# 06 — Integrations architecture

> Round 2 design. Sources: product/08, BD-017, BD-022, BD-023, BD-025, research/03. Provider-specific library choices are recorded in TD records once research/05 lands.

## Type contracts (ports in the application ring)

Each integration **type** is a TypeScript/Python interface pair: an *outbound port* (actions the platform calls) and an *inbound normaliser* (provider payload → domain events with verified actor identity). Providers implement both. The pipeline, UI and knowledge base depend only on the ports.

### TaskManagement
```
readTicket(ref) -> Ticket {key, url, type, title, description, comments[], labels, priority, links[{type, key, state}], epic?: {key, title, description}, siblings?: [{key, title, state}], attachmentsText[]}
matchTickets(rule) -> TicketRef[]                   # the ticket poller's read, oldest first (WP-87); rule `keys` = the tickets named, whatever the pick-up rule (WP-110)
pollPlan() -> {rule, interval_seconds} | null        # WP-87: the binding's own switch, rule and interval
transition(ref, targetStatusName, fields?) -> {changed, from, to}   # resolves at runtime; already there = {changed:false}; unknown target fails loudly
upsertWorkpad(ref, markerId, markdown) -> CommentRef # edit in place (BD-023); Jira finds it by paging the thread (WP-111)
addComment(ref, markdown) -> CommentRef              # questions, linter output
setLabels(ref, add[], remove[])
linkMergeRequest(ref, mrUrl)
createTicket(draft) -> TicketRef                     # scope-creep valve, epic split
resolveIdentity(providerUserId|email) -> UserIdentity
inbound: InboundNormaliser                           # see below; ticket.matched|comment.added|status.changed
capabilities() -> {webhooks, epics, links, customFields, adf, createTicket, attachments, lifecycleStatuses, transitionsRead, assign, commentsRead}   # the last four: WP-171, below
listStatuses() ; listTransitions(ref) ; selfIdentity() ; assignToSelf(ref) ; unassign(ref) ; listComments(ref, {since?, limit})   # WP-171: the M10-head amendment below
testConnection() -> HealthProbe                      # read-only probe (product/08 § Health and setup)
```
Markdown → provider format converter (ADF for Jira Cloud, wiki markup for DC) lives in the provider module.

> **Amendment (WP-36): `createTicket` has two callers, not three.** The line above named a
> *"maintenance chore"* as a third, and the product documents say otherwise: product/19:126's
> feature card gives the maintenance pipeline's external touch as **merge requests**, and
> product/18:31 says a scheduled chore *"produces a normal `chore` task"*. The scheduler creates that
> task directly, on a platform-issued reference (`chore!<type>-<period>`) that every ticket read and
> every ticket write refuses by name, so no maintenance chore files a ticket on anybody's board.

> **Amendment (WP-40): the second of the two callers now exists.** `createTicket` had no caller in
> any ring from WP-08 until this row; the epic split is the first, through
> `ticketWrites.createChildTicket` from the `breakdown_create` outbound duty, and **only after a
> human has accepted the child** (product/04:117, Q85). The scope-creep valve is still unbuilt. The
> capability flag is read **twice** on that path, and the earlier of the two is the one that matters:
> intake refuses to route an epic to the variant at all when the binding reports `createTicket:
> false`, because a queued breakdown whose acceptance could only throw is worse than an ordinary
> feature ticket — a human has spent a decision on it by then.


> **The inbound half, as implemented at WP-07.** Every type port carries one `InboundNormaliser`
> instead of the loose `webhookVerify` / `normalizeEvent` pair: `verify(delivery) -> bool`,
> `deliveryKey(delivery) -> string` (the dedup key the endpoint stores), and
> `normalise(delivery, {projectId, integrationId, resolveUser}) -> {events, ignored}`. Three
> changes matter. The delivery keeps its **raw body**, because every signature scheme in TD-024 is
> computed over the bytes. The normaliser is given `resolveUser`, because BD-022 and Q10 make a
> chat answer or approval legal *only* for an identity that maps to a platform user. And a
> delivery that produces no event says why (`unsupported_event`, `unmapped_identity`,
> `not_for_this_project`, `malformed_payload`) instead of returning an empty array, so a missing
> pipeline transition is debuggable and a test can assert positively on the drop.
>
> Events come back as `{type, payload, actor}` drafts rather than as `DomainEvent`s: the envelope
> needs an id, a stream and a `stream_seq`, which belong to the append the application ring makes
> inside its transaction (TD-005).

> **M10 head amendment (2026-10-08, BD-031 decided by the product owner, TD-029 decision 2).** The
> port gains six members for the ticket lifecycle, the claim and the human-return window:
> ```
> listStatuses() -> [{id, name, category: todo|in_progress|done|unknown, raw_category}]   # read; union over issue types
> listTransitions(ref) -> [{id, name, to: {name, category}}]                               # read; diagnosis and the setup check
> selfIdentity() -> ExternalIdentity                                                     # read; the binding's own account
> assignToSelf(ref) -> {changed, assignee}                                               # mutation (executor)
> unassign(ref) -> {changed}                                                             # mutation; only when the assignee is the binding's own account
> listComments(ref, {since?, limit}) -> {comments[], total|null}                         # read; the window's re-read
> ```
>
> **Which providers implement them.** Jira Cloud implements all six (WP-172), using
> `GET project/{key}/statuses`, `GET issue/{key}/transitions`, `GET myself`,
> `PUT issue/{key}/assignee` and `GET issue/{key}/comment?orderBy=-created`. It never uses
> `GET statuses/search`, which needs project administration
> (`docs/research/15-tracker-lifecycle-and-mr-conversation.md` J1–J6). The fake implements them with a
> configurable status set and assignee (WP-171). Jira Cloud is the only task-management adapter in this
> build. Any later adapter either implements each member or throws
> `IntegrationError('unsupported')` **naming the member**. The capability flags (`lifecycleStatuses`,
> `transitionsRead`, `assign`, `commentsRead`) say which. The shared contract suite runs both branches,
> the refusing one against a stub adapter in the suite, so a silent no-op cannot pass (BD-017).
>
> **Category normalisation:** `new` → `todo`; `indeterminate` and `in-flight` → `in_progress`;
> `done` → `done`; anything else → `unknown`, with `raw_category` kept. The vendor documents no enum,
> and the product owner observed the first three keys live (backlog 535).
>
> **As built at WP-171.** The six members and four flags are on the port
> (`packages/application/src/ports/integrations/task-management.ts`), with the signatures above. The
> refusal is `IntegrationUnsupportedError`, whose code is `unsupported_capability` (the error code the
> port already had; there is no `unsupported` code) and whose `action` is the member's name;
> `LIFECYCLE_MEMBER_CAPABILITY` maps each member to its flag (`assign` declares `selfIdentity`,
> `assignToSelf` and `unassign`). `normaliseStatusCategory` is the port's one pure function and matches
> the keys **exactly** — `DONE` is `unknown`. `listComments` keeps comments **created strictly after**
> `since`, answers them **newest first** (`orderBy=-created`), takes `limit` 1–100 (Jira's default
> page), and `total` is the window's count, never below `comments.length`, or `null`. `assignToSelf`
> takes the ticket whoever holds it; the claim's re-read decides who won. At WP-171 the **Jira
> adapter declared the four flags `false` and refused all six by name**, so the shared suite ran its
> refusal branch against Jira as well as against the stub. Since WP-172 that branch runs against the
> stub alone.
>
> **As built at WP-172.** Jira Cloud declares the four flags `true` and implements the six members
> (`packages/integrations/src/providers/jira-cloud/index.ts`). `listStatuses` asks J1 once per key in
> the binding's `project_keys` and unions the answers by name (`lifecycleStatusKey`, first spelling
> wins); a name seen with two category keys keeps the first and names the second on the
> `list_statuses` audit row (`category_conflicts`), because the adapter holds no logger. A binding with
> **no** `project_keys` has no project to ask J1 about, so `listStatuses` refuses it
> (`invalid_request`) rather than answering an empty list; a project the account cannot see fails
> the whole read (`not_found`). `assignToSelf` and `unassign` are a `read_assignee` read (`fields=assignee`)
> and then, only when a write is needed, an `assign_to_self` / `unassign` mutation — so shadow mode
> stops before the `PUT`, and `unassign` sends `{"accountId": null}` only when the binding's own
> account holds the ticket. A `403` on the `PUT` is `forbidden` naming *Assign Issues*.
> `listComments` asks J5 for `maxResults=limit&orderBy=-created`, cuts the page to `limit`, keeps the
> comments created strictly after `since`, and never reads J5's `total`: the window's length is the
> `total` when the window is shorter than `limit` (the thread ran out, or the horizon fell inside the
> page), otherwise `null`. A status or transition the port's shape cannot carry (no id or name, a name
> past `MAX_LIFECYCLE_STATUS_NAME_CHARS`) is skipped and counted on the audit row. The binding schema
> embeds `ticketLifecycleSchema` as `lifecycle` and refuses a slot that names `pickup_status`; the
> catalogue's credential-free schema rebuilds the object rather than `omit`ting it, because zod 4's
> `omit` refuses an object schema with a refinement.
>
> **The binding's `lifecycle` block** (TD-029 decision 1) is part of every task-management provider's
> binding schema. It is defined once in `packages/contracts`, and `pickup_status` is its `pick_up_from`.
> `PUT /api/projects/:id/bindings` validates it against `listStatuses()`, read through the executor.

### GitProvider
```
cloneUrl(project, credential) ; mintCredential(project, scope: read|push:agentic/*, ttl) -> Credential
openMergeRequest({branch, target, title, description, draft, labels, reviewers}) -> MrRef
commitFiles({project, branch, start_branch, message, author, actions[]}) -> {sha, branch, url}   # WP-18b: one commit of whole files (the knowledge apply); GitLab refuses it WHOLE and names no file (any 4xx → invalid_request), so the apply splits a refused batch into one commit per page, once (WP-156, backlog 420; technical/07)
updateMergeRequest(mr, {description?, draft?, labels?, reviewers?, title?})
getMergeRequest(mr) -> {state, draft, headSha, mergeable, diffStats, coverage?}
closeMergeRequest(mr) -> MergeRequest                 # WP-59: idempotent (closed stays closed), `conflict` for a merged MR; a rework's superseded MR (Q92)
findOpenMergeRequest(project, sourceBranch) -> MergeRequest | null   # WP-138: the open MR of one branch — `open_mr` adopts it after a `conflict` only when it is the binding's own and targets the default branch
authenticatedUser() -> ExternalIdentity               # WP-138: the account the binding's credential acts as (GitLab `GET /user`)
projectMemberAccess(project, username) -> {member, role, pushes, administers}   # WP-137: a static run credential's user, read with the API token by the probe (GitLab `GET /users?username=` + `GET /projects/:id/members/all/:user_id`); `administers` = Maintainer and above
branchPushProtection(project, branch) -> {protected, nobodyPushes, forcePushAllowed, pushers}   # WP-141: who may push to a branch, read with the API token (GitLab `GET /projects/:id/protected_branches`, every rule matching the branch, exact or wildcard, combined most-permissive; none = unprotected); an operator's own run token needs push No one and force push off on the default branch
runTokenApiAccess(runToken) -> {status, refusedForScope, error}   # WP-141: the scope proof — one identity read made WITH the run token (GitLab `GET /user`; only a 403 with `insufficient_scope` is refused for scope); the platform's only use of a run token against a provider API
deployKeyAccess(project, publicKey) -> {enabled, canPush, keyId}   # WP-146: whether a public key is one of the project's deploy keys and may push (GitLab `GET /projects/:id/deploy_keys`), read with the API token by the deploy-key probe; matched by type and base64
createMergeRequestPipeline(mr) -> {id, headSha, status, url?}   # WP-138: a mutation, the `mr_pipeline` duty's (the `mr_ready` duty's until backlog 486), after the Developer stage, when the head has no pipeline (or one held at a manual job) and the default branch has a CI file
repositorySettings(project) -> {defaultBranch | null, ciConfig: repository{path} | external{location} | unknown{reason}}   # WP-139: GitLab `GET /projects/:id` — `default_branch` (the wizard's prefill and, since WP-142, the settings page's mismatch notice — its **only** readers; every pipeline reader takes the stored branch) and `ci_config_path` (empty → `.gitlab-ci.yml`; `…@project` or a URL → external, counted as CI present; absent key → unknown). The CI gate and `mr_ready` look for that path on the default branch (by presence only, through the mirror) instead of a fixed `.gitlab-ci.yml`; since WP-143 the CI gate's tamper check also protects that path, and the readiness CI-rules notice and R13 read its bytes through the mirror (`RepositoryFileRequest.ciConfigPath`, the one provider-named path whose content is read)
getMergeRequestDiffStats(mr) -> {filesChanged, insertions, deletions} | null   # WP-59: GitLab answers from GraphQL `diffStatsSummary`; null = not computed
listDiscussions(mr) ; replyToDiscussion(mr, discussionId, markdown) ; resolveDiscussion(mr, discussionId)
createDiscussion(mr, {path?, line?, markdown})         # review findings; both absent = a thread on the MR (WP-24's neutral summary)
getMergeRequestDiff(mr, {limit}) -> [{oldPath, newPath, diff?, newFile, renamedFile, deletedFile, omitted}]  # review-only mode (WP-24)
getPipelineStatus(headSha) -> {status, url, jobs[{name, status, logRef}]}
getJobLog(jobId, {tailBytes}) -> string
getBranchHead(project, branch) -> {branch, sha}   # WP-142: the branch is the caller's — always the stored `projects.default_branch` (was `getDefaultBranchHead(project)`, which also chose the branch). GitLab `GET /projects/:id/repository/branches/:branch`
readCodeowners(project, ref) -> Rules
listMergedMergeRequests(project, since, limit) -> [{ref, author, mergedAt, title, diffStats?, discussionCount}]   # history bootstrap, shadow comparison
listCommits(project, {since, limit}) -> [{sha, message, author, committedAt, url?}]   # history bootstrap's commit messages (WP-35)
listMergeRequests(project, {updatedAfter, limit}) -> [{ref, state, draft, headSha?, createdAt, updatedAt, mergedAt?, closedAt?, mergeCommitSha?}]   # the merge-request poller's read, every state, oldest update first (WP-110)
pollPlan() -> {interval_seconds} | null             # WP-110: the binding's own switch and interval; null without a single project
revokeCredential({revokeId})                          # by address (WP-77): when the workspace is destroyed, and by the recovery pass for a run whose revoke never happened
inbound: InboundNormaliser -> mr.* | ci.pipeline.finished | default_branch.moved   # WP-148: a push to InboundContext.defaultBranch (the project's stored branch), never to the provider's own default
capabilities() -> {webhooks, projectTokens, groupTokens, codeowners, coverageArtifacts, draftPipelines, discussionResolution, credentialMinting}
```
> **Amended at WP-35 (rule 8: docs win, so the doc moves first).** This line used to read
> `-> [{iid, author, mergedAt, diffStats, discussions[]}]`, and the `discussions[]` was never true of
> any implementation: `MergedMergeRequest` carries a **count** and not the comments (built at WP-09,
> first called at WP-34). The difference is not cosmetic — it is why *"the last N merged MRs **with
> their review comments**"* (product/19 §18) costs `1 + N` provider reads rather than one, which is
> the arithmetic `application/src/bootstrap/batch.ts` states and PROGRESS backlog **64** records.
> `listCommits` is new at WP-35: product/19 §18 names commit messages as a bootstrap input and the
> port had no read for them at all.

> **M10 head amendment (2026-10-08, BD-031 decided by the product owner, TD-029 decisions 2, 6 and 10).**
> The git port gains **no** method. Its contract is tightened in two places.
>
> - **`listDiscussions` lists every note.** A merge request's general (non-threaded) note is returned as
>   a discussion of its own, whatever the provider says about `resolvable`. GitLab's documentation
>   contradicts itself on that field (`docs/research/15-tracker-lifecycle-and-mr-conversation.md` G2),
>   and the product owner's example review consists of exactly such notes. The GitLab adapter already
>   does this (`packages/integrations/src/providers/gitlab/provider.ts:531-551`). WP-173 pins it in the
>   shared contract suite, for the fake as well.
> - **`replyToDiscussion` answers an individual note.** On GitLab, whether the reply endpoint accepts an
>   `individual_note` discussion's id is **[unverified]**. WP-173 records it against a documented-adapted
>   fixture. If it is refused, the adapter posts a new merge-request note that opens with the reply's
>   platform marker and names the note it answers, and its docblock states the divergence.
>
> **Callers.** `replyToDiscussion` and `resolveDiscussion` get their first callers: the
> `conversation_replies` and `review_threads_resolve` duties, through `IntegrationActionExecutor`
> (WP-179). Whether a note is a **person's word** is decided by the marker at the start of its body,
> never by `authenticatedUser()`, because a binding may act as a person (TD-029 decision 6, Q118).
> The opposite question — is this note **the platform's own**, so a reply need not be posted again or
> a finding thread may be resolved — asks the marker **and** that the note's author is
> `authenticatedUser()` (WP-179): both narrow a mutation the platform would make, so neither can
> silence a person. A reply is found again by its marker across every discussion, never by the
> discussion `replyToDiscussion` returned, whose id may differ (the port's docblock).

Git operations (clone, branch, commit, rebase, push) are performed by the workspace manager with `git` and a credential helper, never by the agent with a raw token (BD-025).

### Communication
```
postTaskThread(project, task, markdown) -> ThreadRef
postQuestion(thread, question) -> MessageRef          # Block Kit buttons + "reply in thread"
postApproval(thread, approval) -> MessageRef
updateMessage(ref, markdown|blocks)
postDigest(channel, items[])
inbound: InboundNormaliser -> task.question.answered | task.approval.decided | feedback.received
capabilities() -> {threads, buttons, messageUpdate, socketMode, digest}
```
An answer or an approval is emitted **only** for an author who maps to a platform user (BD-022, Q10); an unmapped author is reported as `ignored: unmapped_identity`. Feedback is different on purpose: it is data, not a decision, so it is recorded with the unmapped identity and a null user id.

> **As built at WP-88 (PROGRESS backlog 195, 233): the thread ↔ task map is the platform's.** A
> threaded reply carries a channel and a thread handle and nothing else, and an adapter is built per
> call (Q55), so no adapter can remember which task a thread belongs to. The notify duty records the
> task's thread in `chat_threads` (migration 0062) when it opens it, and a question's message on its
> `notifications` row; the ingress hands every normaliser `InboundContext.resolveThread`, which
> answers the thread's task and the open questions posted into it — a reply answers one only when
> exactly one is open, and with several it answers nothing and is recorded as ambiguous. A question
> is posted through `postQuestion` (buttons when a click and a reply can arrive, text naming the
> task page otherwise), and the `question_settled` duty edits its message through `updateMessage`
> once it is answered or expires, as WP-65's `approval_settled` does for an approval.

### ObservabilityErrors
```
getIssue(ref) ; getLatestEvent(ref) -> {stackTrace, breadcrumbs, tags, release, firstSeen, lastSeen, count}
searchIssues(project, query, since)
linkMergeRequest(issue, mrUrl) ; comment(issue, text) ; resolve(issue, inRelease?)
linkedIssues(text) -> {id}[]   # WP-89, pure
resolveOnMerge() -> boolean    # WP-111, pure: the binding's `resolve_on_merge`, false by default
agentTooling() -> {mcp?: McpServerSpec, cli?: CliSpec, skill: SkillRef, env: EnvSpec}
```
No inbound normaliser in v1: product/08 lists `error.issue.created` as optional and technical/02's catalogue has no such event, so a normaliser would have nothing legal to emit.

> **Amended at WP-89 (PROGRESS backlog 143): `linkedIssues(text) -> {id}[]`, and the pre-fetch
> exists.** The bug pre-fetch has to know which issue a ticket is about, and the ticket is the only
> thing that says, so the port gained one pure, synchronous member: the issue ids a text links to,
> recognised only on the binding's own instance and organisation, each once, at most
> `MAX_LINKED_ISSUES` (20) — an id the provider issued, never a URL anybody dials. The shared contract
> suite holds it on the fake and on Sentry. The pre-fetch itself is
> `packages/application/src/pipeline/observability-prefetch.ts`: in the `stage.execute` job before an
> Investigator run, outside every transaction, through `IntegrationActionExecutor`, the binding
> resolved by `PipelineIntegrationsPort.forObservability` — per type and apart from `forProject`, so a
> broken Sentry or Loki binding fails the excerpt open and never the pipeline — redacted with the
> binding's redactor, and cut in the prompt at `MAX_ERROR_EVENT_EXCERPT_CHARS` /
> `MAX_LOG_EXCERPT_CHARS` (12 000 + 8 000 characters, one artifact's worth, derived at the constants
> in `packages/domain/src/prompt/assembly.ts`). Sentry and Loki are registered in the pipeline's
> registry (`bindings/shipped-registry.ts`) from this row on.

> **Every string an errors adapter emits is bounded by a named cap** (WP-11 review round 1). Sentry
> capped the stack trace, the message and the breadcrumb trail, and capped the tag *count* while
> leaving a tag *value* unbounded — so a 2 MB `server_name` reached the port intact. `max_field_bytes`
> now bounds every short provider string (tag names and values, a breadcrumb's `category` and
> `level`, correlation ids, release, environment, assignee), a text field over it is truncated with
> a marker, and an **identifier** over it (an id, a slug, a permalink) is `invalid_response` rather
> than a plausible-looking cut. The event's size is therefore the sum of its caps.
>
> **And that sentence was false for three review rounds, which is the transferable part** (WP-11a,
> standing rule 37). A breadcrumb's `category` and `level` went out raw — 100,027,762 bytes of JSON
> at the shipped defaults (`max_breadcrumbs=25`, `max_breadcrumb_bytes=1024`) from 50 crumbs with
> 2 MB fields, a figure `sentry/mapping.test.ts` now asserts rather than quotes — because every
> round audited *the call sites that cap things*
> instead of the *members of the emitted type*, and round 3 stated its sweep was complete. The rule
> for any adapter: enumerate the type's members, state where each one's bound comes from, and make
> the enumeration executable. `packages/integrations/src/providers/emitted-bounds.test.ts` drives
> every method of both observability adapters from a hostile document, walks each answer to its
> leaves — **object keys included**, since `tags` and `labels` are records whose keys are provider
> text — and fails on any string past the largest configured cap and on any key not in its
> inventory. **A member whose bound is a *refusal* needs a hostile document of its own**, which is
> the second half of the rule and cost WP-11a its own review round: the walk feeds an identifier a
> *safe* value, because a hostile one throws before anything is emitted, so deleting `identifier()`
> from `ref.short_id`, `ref.url`, `project`, `event_id` or `issue_id` left all 758 tests green. An
> enumeration is only as wide as the values it dares send. Two more members were found by that
> enumeration and are now bounded: `HealthProbe.detail`
> (the failure branch renders the binding's own `organization`, whose slug schema has no length) and
> Loki's `LabelValues.name`. The cap runs **after** redaction, because a `[REDACTED:integration:…]`
> placeholder is longer than the secret it replaces.

> **The first provider cannot implement two of these methods** (WP-11). Sentry's published API
> reference documents 21 endpoints for Events & Issues and **none of them creates or lists a
> comment or a code link**; the only comment surface it publishes is the inbound
> `Sentry-Hook-Resource: comment` webhook. The adapter therefore declares `comments: false` and
> `linkMergeRequest: false` and refuses, rather than posting to an endpoint no vendor page names —
> "tell the tracker the fix shipped" is discharged by the documented `resolve(issue, {inRelease})`
> and by Sentry's own `Fixes <SHORT-ID>` commit-message convention. Whether the port should keep
> the two methods at all is **Q43**.

> **As built at WP-111 (PROGRESS backlog 302, option (b)): resolve on merge, opt-in per binding.**
> `resolveOnMerge()` answers the binding's `resolve_on_merge` (Sentry's config, `false` unless set;
> set on the binding, or on the account as every binding's default). A handler on `mr.merged`
> (`pipeline.errors.resolve_on_merge`, TD-005 priority 120) enqueues the `resolve_on_merge`
> `pipeline.outbound` duty for a task on the `bug` template; the duty
> (`packages/application/src/pipeline/resolve-on-merge.ts`) re-validates the task, resolves the
> errors binding through `observabilityForProject` (none → nothing; one that will not load → the
> job fails), stops when the flag is off, runs `linkedIssues` over the task's stored ticket snapshot,
> and calls `resolve(issue)` — **no release** — once per linked issue through
> `IntegrationActionExecutor` (`errorWrites`, action `resolve_issue`): one audit row per issue,
> `would_have` for a shadow task, and an `IdempotencyPlan` keyed on the task and the issue, so a
> second `mr.merged` for the task replays rather than resolving twice. `comment` and
> `linkMergeRequest` are not called (Q43). product/08's *"resolve-in-next-release"* — Sentry's
> `resolvedInNextRelease` status — is not what is sent; that is filed under WP-111.

### ObservabilityLogs
```
queryRange(selector, from, to, limit, filter?) -> {streams[], line_count, truncated}
labels(name?) ; series(selector, since)
agentTooling() -> {cli: logcli spec, skill, env}
capabilities() -> {labels, series, maxRangeMs, maxLines}
```
The caps are enforced, not advisory: a range or a limit above `capabilities()` is `invalid_request`, and a result that hit the limit says `truncated: true`, because a truncated answer to "is this error still happening?" reads exactly like a complete one.

> **Amended at WP-89: `excerptSelector() -> string | null`.** Which streams hold a project's logs is
> the operator's to say and not the ticket's, so the bug pre-fetch's selector is **binding**
> configuration (Loki's `excerpt_selector`, refused at the config parse unless `queryRange` would
> accept it) and the port publishes it; `null` means the pre-fetch queries nothing and the prompt
> says `not_configured`. The excerpt is at most 50 lines, ±5 minutes around the event, filtered by
> the event's `trace_id` or `request_id`, and never outside `capabilities()`.

> **Caps the port does not name, added by the adapter at WP-11.** `maxRangeMs` and `maxLines`
> bound the *question*; neither bounds the *answer*. A single log line can be a 50 MB base64 blob,
> and a thousand ordinary lines can still be tens of megabytes on their way into a context pack, so
> the Loki binding also carries `max_line_bytes`, `max_label_bytes`, `max_labels`,
> `max_label_values`, `max_series` and `max_total_bytes`. Each truncates with a visible marker
> naming the cap that fired and each sets `truncated: true` where the answer has such a flag, so
> the port's promise is kept along an axis it did not describe. **A cap counts what is emitted**:
> `max_total_bytes` counts each line *and the label set copied onto it*, because counting the line
> alone let a 2 MB label value across 20 lines answer with 42 MB and `truncated: false` (WP-11
> review round 1). **A cap that bounds one item does not bound a list**: `series` returned every
> label set Loki sent — 10 000 series of 5 kB of labels is 11 MB with no marker — until review
> round 2 gave it `max_series` and put it under `max_total_bytes` too; its marker is a label set of
> its own, because `series` returns a bare array with no `truncated` field to set. **A marker
> counts inside its own cap**, which is what makes a cap idempotent: appending it outside meant
> applying a cap twice measured the first marker and reported a dropped-byte count about platform
> text, and two Sentry call sites disagreed by a factor of seventeen about the same value.
> `maxRangeMs` binds `series` as well as `queryRange` — its window runs from `since` to now — and
> that obligation lives in the shared contract suite rather than in one adapter. **Two members the
> cap list did not name** were added at WP-11a by enumerating the emitted types instead of the call
> sites: `HealthProbe.detail` is bounded by `max_line_bytes` after redaction, and
> `LabelValues.name` — the caller's own argument echoed back — is *refused* past `max_label_bytes`
> rather than cut, because it names the label being listed and is spliced into the request path.
> That refusal is an obligation of the **shared** `ObservabilityLogs` contract suite as of WP-11a,
> not a promise one adapter makes: it was refused by Loki, accepted by the fake and called by
> nobody for a round, which is a fake kinder than the adapter (standing rules 1 and 23). **The
> obligation has two halves, and only one of them can live in the suite.** The suite pins the
> refusal's *position* — one byte past the binding's own cap, read out of that binding's config
> rather than restated, because a comfortable distance is a negative case a too-wide guard passes
> too. The *acceptance* at exactly the cap is asserted by each binding in its own tier —
> `providers/emitted-bounds.test.ts` for the Loki adapter, `logs/fake.test.ts` for the fake —
> because a name of the cap's length is one no harness has a recorded answer for and the Loki runner
> replays fixtures. A provider author owes **both**: without the second, a binding that refuses
> *every* label name passes the suite (standing rule 42, a boundary asserted from one side is half a
> test). And the name is spliced into a path, so the *encoding* of it is pinned as well, per adapter,
> by `providers/request-path.test.ts`. They are configuration rather than capability flags because
> widening `ObservabilityLogsCapabilities` is a port change and belongs to whoever needs to read
> them from the pipeline. The adapter also refuses to trust the server's own limit: a response
> carrying more entries than the query asked for is cut and reported as truncated.

> **A truncation marker is platform text in a provider-shaped field, and a provider can forge it**
> (WP-11a review round 1, judged non-blocking and left for **WP-16**). `agentic.truncation` is a
> tag on a Sentry event, a label on a Loki stream and a breadcrumb category — all namespaces the
> provider also writes — so an application that tags its own events `agentic.truncation`, or a
> label set that carries it, produces an answer that *claims* something was dropped when nothing
> was. The direction matters: a **real** truncation overwrites the forged value (the platform
> writes the marker last), so completeness cannot be faked and the caps still hold; what a forger
> buys is a false "truncated" claim plus platform-looking text inside a prompt. **WP-16 owns it**,
> because the harm is in the context pack: whatever assembles a pack must render provider text as
> provider text and must not treat a marker key as the platform's own voice. Closing it in the
> adapters would mean stripping the key from provider data first, which is a second rule about
> provider-chosen keys in a place that has one already.

### Provider module layout

As built at WP-07, the three pieces of a type live in three rings rather than in one directory,
because the heading of this section is the binding constraint: **the ports are in the application
ring**, and `packages/integrations` is an adapter package that nothing in `application` may import
(the dependency rule in `biome.json`).

```
packages/application/src/ports/integrations/
  common.ts                 # IntegrationRef, typed errors, the inbound normaliser, agent tooling
  audit.ts                  # audit entry + IntegrationAuditLog, idempotency, redaction, timer ports
  <type>.ts                 # one file per type: data schemas, capability flags, the port interface
packages/application/src/integrations/
  action-executor.ts        # IntegrationActionExecutor; rate-limiter.ts; redaction.ts (TD-012 step 1)
packages/integrations/src/
  <type>/fake.ts            # in-memory fake with a divergence register (a test double, not shadow mode)
  support/fake-support.ts   # signed fake webhook envelope, scripted failures, deterministic clock
  providers/jira-cloud/     # index.ts (registration), client.ts (thin REST), adf.ts, webhook.ts, setup-guide.md
  providers/gitlab/         # WP-09: config.ts, http.ts, client.ts, schemas.ts, mapping.ts,
                            # codeowners.ts, credentials.ts, webhook-verify.ts,
                            # webhook-payloads.ts, inbound.ts, provider.ts, index.ts, setup-guide.md
  providers/slack/          # WP-10: config.ts, http.ts, client.ts, schemas.ts, blocks.ts,
                            # mrkdwn.ts, signature.ts, inbound.ts, threads.ts, socket.ts,
                            # provider.ts, index.ts, app-manifest.json, manifest.ts,
                            # setup-guide.md
                            # (WP-32 removed digest.ts: the digest is a behaviour of the
                            # communication *type*, so its schedule and its policy live in
                            # `@platform/application`'s notify/digest.ts — BD-017, since a
                            # scheduler in this package could only schedule Slack.)
  providers/sentry/ providers/loki/
  registry.ts               # providers register {type, id, configSchema, secretFields, capabilities, agentTooling}
test/contract/support/integrations/
  <type>-contract-suite.ts  # the reusable suite, parameterised over a harness factory
test/contract/integrations/
  <type>.contract.test.ts   # runs the suite against the fake; provider WPs add a replay-mode runner
test/fixtures/http/<provider>/
  *.json                    # recorded interactions, each with its documentation URL and whether
                            # the shape is `documented` or `inferred` (technical/10)
```

The suites sit under `test/` for the same reason the `Jobs` contract suite does (technical/10 and
WP-05): one exported suite, several runners — the fake on every `verify`, each real adapter in
replay mode — and a suite that lived inside a package would be counted as that package's coverage
while asserting nothing about it.

Adding GitHub = `providers/github/` implementing GitProvider + fixtures + setup guide + a runner for
the existing suite (BD-017).

> **A binding is created with a redactor, and the type requires one** (TD-012, WP-11 review round
> 1). `ProviderCreateInput` is `{integrationId, config, secrets, redactor}`: every adapter takes a
> `SecretRedactor` as a **required** option, never an optional one, because an optional security
> dependency is an absent one — WP-11 shipped both observability adapters with an optional redactor
> and a registration that passed none, so `redact.apply` was the identity function along the only
> production path. Two halves make the guarantee whole: the caller injects what *it* knows (a
> run-scoped token, a neighbouring binding's secret) and the adapter composes that with a redactor
> built from its own **resolved** credentials, so a caller passing `noSecretsRedactor()` cannot
> disarm the one secret the adapter is certain about. Platform services an adapter needs (the clock,
> the transport, the redaction and unmapped-value sinks) are captured by a registration **factory**
> — `createLokiRegistration(deps)`, as Jira's has been since WP-08 — which is also what lets the
> contract suites drive `create()` itself rather than a constructor next to it.
>
> **And required is not used.** Making the field required proves an adapter is *handed* a redactor,
> not that it applies one: the check happens where the object is built. Two shipped adapters proved
> it — GitLab composed no redactor over its own credentials, so `getJobLog` returned
> `PRIVATE-TOKEN: glpat-…` verbatim; Jira applied its redactor to `HealthProbe.detail` **only**, and
> the executor does not compensate, because it redacts the audit *row* and returns the raw result.
> Three rules came out of the fix, and they apply to a sixth provider as much as to these five:
>
>  1. **Redact at the transport, not at the call sites.** One pass over the request document and one
>     over every response document, above the success test, is a guarantee; a redactor applied in
>     each of six port methods is six chances to forget the seventh — and WP-07's review found
>     redaction present on a success path and missing on the failure path three times in one file.
>  2. **Redact before every cut.** A cap applied first leaves a fragment that no exact-match
>     redactor can ever find again. That includes the cuts nobody thinks of as caps: Jira's
>     300-character error detail, GitLab's 32-character `object_kind` quote, and `JSON.parse`'s own
>     `SyntaxError`, which quotes the ten bytes it choked on into a message that travels on `cause`.
>  3. **Redact the inbound delivery too.** It never crosses the transport, and it is the one
>     document that ends up in `events.payload`, which is append-only (BD-003).
>  4. **A document is not only its values.** `redactJson` walks string *values* and leaves object
>     **keys** alone by design (`application/src/integrations/redaction.ts` records the collision
>     hazard that decides it), so every site that turns a **provider-chosen key** into emitted text
>     owes its own pass — Loki's label names, and Jira's `ErrorCollection.errors`, whose keys a
>     reviewer used to read a planted credential out of an error message. **Headers are the same
>     class**: a delivery's identifier header becomes a stored dedup key, and `X-Gitlab-Token` *is*
>     a webhook secret. Redact where you emit; a key's collision is only knowable there.
>  5. **Enumerate the members of the port, not the calls you remembered to make.** Round 1 of this
>     fix walked eighteen GitLab answers and eleven Jira ones and was complete by its own list;
>     five members had no scenario at all, and one of them was the header path above.
>     `emitted-secrets.test.ts` now derives the list from `Object.keys(port)` (rules 7 and 37).
>
> The proof is `packages/integrations/src/providers/emitted-secrets.test.ts`: both adapters built
> through their **real registration** with `noSecretsRedactor()` as the caller's redactor, the
> binding's own credentials planted in every string the provider can return, and every emitted field
> walked by path — failure branches included.

> **A new obligation on a port lands in the shared suite, in the same change.** WP-09 added one —
> an adapter may not report a revocation it cannot substantiate, so a credential handle it did not
> mint is `not_found` — and for a review round it lived only in GitLab's own contract file, which
> made it a promise one provider had made to itself: a GitHub adapter that silently `return`ed
> would have passed the whole suite. BD-017's claim is that a new provider is trustworthy *without*
> touching the pipeline, and the shared suite is the only thing that can make that true. Where the
> obligation needs a provider-shaped input, the suite takes it from the harness context rather than
> writing a literal (`foreignRevokeId` is GitLab's `<project>#<token_id>` and the fake's `rev-<n>`),
> and it asserts the *specific* refusal, because a handle that is not a handle at all earns a
> different one (`invalid_request`).

> **What a provider module looks like, as built at WP-09** (`providers/gitlab/`): `config.ts` (the
> binding's zod schema, strict), `http.ts` (the thin `fetch` client — status mapping, `Retry-After`,
> a bounded pager), `client.ts` (the ~19 endpoints the port needs, each parsed with
> `parseProviderData`), `schemas.ts` (the provider's response shapes, deliberately *non*-strict
> because a vendor adds fields every release), `mapping.ts` (provider vocabulary → port
> vocabulary), `webhook-verify.ts` + `webhook-payloads.ts` + `inbound.ts` (the inbound half),
> `credentials.ts`, `provider.ts`, `index.ts`, `setup-guide.md`.
>
> **Two providers in one work package, kept apart** (WP-11): `providers/sentry/` and
> `providers/loki/` implement *different* type ports and share no production code — not even the
> thin HTTP client, because the two vendors differ in the base path, the auth header set (Loki may
> be unauthenticated and adds a tenant header), the rate-limit signalling (Sentry publishes
> `X-Sentry-Rate-Limit-*` on every response; Loki publishes nothing) and in whether a body is ever
> text. A client parameterised over those four differences would be a module whose divergence
> register described neither provider. What *is* shared is test support: one replay transport
> (`test/contract/support/integrations/http-replay.ts`), which knows no vendor. Loki adds one file
> the others have no analogue for — `logql.ts`, the query-language boundary: a stream selector is
> **validated** because it is an expression the platform writes, and a caller's `filter` is
> **escaped** because it is a literal that may have arrived from a ticket or an agent. LogQL
> concatenated from untrusted text is injection with a query language instead of a shell (BD-022).
>
> Two constraints that turned out to be structural rather than stylistic:
>
>  - **`fetch` is injected, and the client never retries.** Backoff, the rate-limit budget and the
>    shadow guard live in `IntegrationActionExecutor`, which owns the injected timer; a retry loop
>    inside a provider would be a second one running on a wall clock. The injected transport is
>    also what makes replay mode work without an HTTP interception library, and what lets a test
>    assert that a shadow-mode call issued *zero* requests. *Amended 2026-10-06 (PROGRESS backlog
>    490):* the executor's retry is seconds long; an outage longer than it is the **caller's**
>    bound, never a second retry loop here — a pipeline gate re-asks a provider that did not answer
>    on its own time bound (technical/02, the gate amendment of that date), reading the executor's
>    `retryable` codes and a bare `TimeoutError`/`fetch failed` as *the provider did not answer*.
>  - **The client is handwritten for Slack too, and TD-024 says otherwise** (WP-10, Q42). TD-024
>    names `@slack/bolt` with `@slack/web-api`; `WebClient` retries a call "up to 10 times, spaced
>    out over about 30 minutes" and waits out a 429 itself, on a wall clock, which is precisely the
>    second backoff loop the bullet above forbids — and it offers no transport seam, so "contract
>    suite in replay" would need a live listener rather than an injected `fetch`. Slack is
>    therefore a thin `fetch` client like the other four, with in-house `v0` signature verification
>    (which is what TD-024's own title says for signatures) and a Socket Mode client whose
>    WebSocket factory, timer and clock are injected. The decision record is left for a human to
>    amend: Q42 states the conflict and the recommendation this implements.
>  - **The adapter carries a divergence register too, and its rule is the dual of the fake's:** a
>    fake may be stricter than the real adapter and never kinder, so *the adapter must not be
>    kinder than the provider*. Where replay cannot reproduce a real behaviour, or where the port's
>    wording promises something the provider does not enforce, it is written down where the adapter
>    is defined. WP-09 found four such places worth the reader's time: GitLab publishes no
>    insertion/deletion counts for a merge request (`diff_stats` is `null`, not zeroes), an access
>    token expires at midnight UTC on a *date* so a TTL in seconds is granted in whole days, a
>    token has no branch scoping at all (Q40), and mergeability is computed asynchronously so
>    `mergeable: null` is a state the port must keep distinct from `false`.

## Inbound: webhooks and polling

- One HTTP endpoint per provider (`/webhooks/<provider>/<integrationId>`), verifies signature (`X-Hub-Signature`, `X-Gitlab-Token`, `Sentry-Hook-Signature`, Slack signing secret when not in Socket Mode), stores the payload (audit), computes a **dedup key** (Jira `X-Atlassian-Webhook-Identifier`; GitLab event + object id + `updated_at`; Sentry hook id), and appends the normalised events. Response is 2xx as soon as the delivery is recorded.
  - **Amended at WP-15c, in three places, and each amendment is a correction rather than a detail.**
    1. **The payload is stored redacted, not raw.** GitLab's legacy scheme sends the binding's own
       webhook secret as plain text in `X-Gitlab-Token`, so "stores the raw payload" wrote a live
       credential to `inbox` on **every** delivery, with no attacker and nothing planted — and
       TD-012's write list does not name `inbox`, so nothing else would have caught it. `headers`
       and `payload` are written `redactJson`-redacted with the **account's** own redactor,
       **after** `verify` (which needs the bytes as they were signed) and **after** the dedup key
       (which the adapter redacts itself), and migration `0014` adds `redaction_count` — the sum
       over the row's three redactions, deliberately not the key's, which is ~always 0 and would be
       a dead signal. Because a redacted payload can no longer be re-verified against its
       signature, the **verdict is persisted** (`inbox.verified`) rather than recomputed.
    2. **Normalisation happens in the request, not in a job.** "Enqueues normalisation as a job …
       all work is asynchronous" has the defect PROGRESS backlog 20 is about, in its unrecoverable
       form: the `inbox` row is written, `Jobs.enqueue` does not join that transaction (TD-004),
       and a crash between the two leaves a delivery *recorded as performed* that never was — which
       a redelivery cannot fix, because the row it would be deduplicated against is the one the
       crash left behind. Normalising first and writing the row **in the same transaction as the
       events it produced** removes the window: either both commit or the sender retries. The cost
       is that the 2xx waits for normalisation, which is pure on Jira and at most one discussions
       read on a GitLab *note*. If a provider's `normalise` ever grows expensive, the shape to
       adopt is **not** the job — it is a sweep of `inbox_unprocessed_idx`, where the row *is* the
       queue and losing the wake-up costs latency rather than the delivery.
    3. **An unverifiable delivery writes no `inbox` row at all** (401, audited as one
       `integration_actions` row with `direction = 'in'` and no event). A row would let anyone who
       can address the endpoint **poison a dedup key**: plant the id a genuine future delivery will
       carry, and that delivery is then silently taken for a redelivery and dropped.
  - **A delivery nobody can key is received, not refused** (202, `accepted: false`): both shipped
    providers refuse to key the hook kinds their normaliser would ignore anyway (wiki, release),
    and a vendor that keeps receiving errors eventually **disables the webhook** — standing rule 20.
  - **A delivery over its integration's rate limit is answered 429, unverified and unrecorded**
    (WP-87, Q60): a token bucket per `integrations.id`, taken after the account row is read and
    before the credentials are decrypted and `verify` runs, with `Retry-After`, no `inbox` row, no audit row and a counter — technical/08 §
    "Rate limits and safety" has the as-built note. Only the HTTP door is limited; a held
    connection's envelope is not.
  - **Authenticity is the account's question and meaning is the project's.** The URL names an
    `integrations.id`, so `verify` and the dedup key are computed from `integrations.config` alone,
    while `normalise` runs once per **binding** with that binding's `bindings.config` merged over
    it — which is what lets one Jira site serve two projects with different pick-up rules without
    the override changing which deliveries the account accepts.
  - **GitLab has two schemes and the choice is not ours** (WP-09). GitLab 19.0 added
    [Standard Webhooks](https://www.standardwebhooks.com/) — `webhook-id`, `webhook-timestamp` and
    `webhook-signature` (`v1,<base64 HMAC-SHA256 over "{id}.{timestamp}.{body}">`, key = the
    `whsec_` token base64-decoded) — beside the legacy plain `X-Gitlab-Token`, and documents the
    migration rule: *verify the signature when `webhook-signature` is present and fall back to the
    secret token otherwise*. The normaliser follows it exactly, which also closes a downgrade: a
    signed delivery whose signature fails is **never** re-checked against the plain token, or an
    attacker who has seen one `X-Gitlab-Token` could forge any body on an instance that has already
    migrated. A signed delivery whose `webhook-timestamp` is outside the binding's tolerance
    (default 5 minutes) is a replay and is rejected; that comparison takes an injected clock.
    With neither token configured, `verify` is `false` — an endpoint that accepts unverified
    deliveries because nothing was configured looks exactly like one that works.
- **Polling fallback** per binding when the instance has no public URL, or as a safety net: Jira `search/jql` with `updated >= -Nm`, GitLab MR/pipeline listing since last cursor; same normaliser; dedup makes both paths safe together.
  > **As built at WP-87 (PROGRESS backlog 187): a ticket poller** (the merge-request half is WP-110's,
  > below). A
  > task-management binding whose configuration sets `poll_enabled` (the platform's key,
  > `TICKET_POLL_CONFIG_KEYS`; interval `poll_interval_seconds`, 30–86400, default 60) is polled by one
  > `ticket.poll` job per binding (`packages/application/src/pipeline/ticket-poll.ts`), which asks
  > `matchTickets` for the binding's **pick-up rule** — the rule its webhook matches with, through the
  > port's `pollPlan()` — since a cursor on the binding (`bindings.poll_cursor`, migration 0061). The
  > read goes through `IntegrationActionExecutor` outside every transaction; each match is redacted
  > with the binding's redactor and recorded by `recordNormalisedDelivery`, the function the webhook
  > ingress records through, so it becomes the **same** normalised signal — `ticket.matched` then
  > `ticket.updated`, the pair a Jira `jira:issue_updated` produces when an edit makes a ticket match —
  > written with its `inbox` row in one transaction. Each window starts `TICKET_POLL_OVERLAP_MS`
  > (five minutes) **behind** the cursor, because Jira's search index lags by seconds and its relative
  > `-Nm` is evaluated on Jira's clock while `N` is computed on the platform's (an absolute JQL date is
  > read in the site's time zone, which the adapter does not know); what the overlap re-reads collides
  > on its key. A window can never start *at* the cursor against Jira — `buildJql` rounds its minutes
  > up — so a full page holding nothing newer than the cursor (a bulk edit larger than a page inside
  > that minute) is read again in the same poll at four times the limit, up to
  > `TICKET_POLL_MAX_LIMIT` (1000; the adapter follows `nextPageToken` to fill it), and once more
  > without the overlap. **The one hard limit:** more than a thousand matching tickets updated in the
  > window just before the cursor (at least the minute Jira rounds to) — the poll then cannot move
  > past them, reports `stalled` and logs a warning on every poll. It stays stalled — the window is
  > anchored at the cursor, so neither time nor a newer edit shrinks it; the ways out are the webhook
  > (which intake deduplicates against the poll) or moving `bindings.poll_cursor` forward by hand,
  > which gives up that window.
  >
  > **"Dedup makes both paths safe together", stated exactly.** A poll's `delivery_id` is
  > `<provider>:poll:<project>:<ticket>@<updated_at>` on the same `inbox(provider, delivery_id)` key,
  > so a second poll of an unchanged ticket appends nothing. A webhook's key is the provider's
  > delivery identifier, which no search result carries, so the two doors never share a key; what
  > keeps a binding with both from starting a ticket twice is intake's 1:1 rule
  > (`tasks_project_id_ticket_key_mode`, `saga.ts`'s `findByTicket`), asserted end to end in both
  > orders (`test/e2e/pipeline/ticket-poll.e2e.test.ts`). Since WP-134 (PROGRESS backlog 418) the
  > rule also holds across a **move**: a provider that sends a stable ticket id (`TicketRef.id`,
  > Jira's numeric issue id, on the read, the poll and the webhook alike) is matched by that id under
  > any key (`tasks_project_ticket_id_mode`, migration 0077), so `NEW-5` meets the task `OLD-1`
  > started; a provider without one, and a task created before 0077, are matched by key. The price is a second `ticket.matched` /
  > `ticket.updated` for one change seen by both doors — absorbed by intake, and one extra snapshot
  > read for a live task.
  >
  > **A polled edit emits `ticket.updated`** (criterion 2), with `changed_fields: []` — a search result
  > carries no changelog. **Since WP-110 a poll also re-reads its live tasks' tickets** (PROGRESS
  > backlog 298): a second `matchTickets` per poll with a `keys` rule — the tickets of the binding's
  > tasks in any state but `done`/`cancelled`, whatever the pick-up rule says, at most
  > `TICKET_POLL_LIVE_KEYS_LIMIT` (100, one Jira page, so the bound is **one request per poll**) —
  > recorded as `ticket.updated` **only**, never `ticket.matched`, on the same key; so an edit to a
  > ticket a **status** rule no longer matches (the platform's status mapping moved it on) reaches its
  > live task. A key Jira says does not exist (`400`, a deleted ticket — documented for Data Center
  > search, inferred for Cloud) is dropped and the search asked again; since WP-134 (backlog 375) a
  > refusal that names **no** key — Cloud's wording is not measured — is bisected until the refused
  > key stands alone, every search counted against `MAX_KEY_SEARCHES` (32), and the keys left out
  > are reported to the poll, which names them in a warning every poll. A read that still fails —
  > past the bound, or every key refused on its own — fails open (a warning; the rule half stands).
  > It never moves the cursor. **Since WP-145 (PROGRESS backlog 437) a live task that recorded its
  > issue's id is asked by it** — the rule carries `ids` beside `keys`, Jira's JQL is
  > `(id in (10001) OR key in ("ACME-7"))`, and an id is written bare only when it is decimal digits —
  > because a moved issue answers under its new key and whether JQL resolves a former key is not
  > measured (`search-jql-by-id-after-move.json`, `inferred`); a refused id is narrowed and reported
  > like a refused key. The `ticket.updated` it records carries the id, and the signal handler
  > matches a task by that id first and by key only for a task with none, moving the task to the
  > new key (`task.ticket.rekeyed`; the branch and the merge request keep the old one).
  > **What a poll cannot see**: comments and `ticket.created` (so the ticket linter is
  > webhook-only); and tickets that matched before polling was switched on, because a binding's first
  > poll reads its last interval only — a first read of every ticket ever labelled would start closed
  > ones. **A lost poll is recovered**: a poll re-arms itself in a `finally`, and a sweep job
  > (`APP_POLL_SWEEP_INTERVAL_MS`, default a minute — `APP_TICKET_POLL_SWEEP_INTERVAL_MS` before
  > WP-123, still read for one release with a `warn`) enqueues a poll for every polling binding,
  > which `stately` collapses onto a live chain's queued job and which restarts a lost one — so the
  > bound on a lost chain is one sweep. The webhook URL is still built from `APP_BASE_URL`
  > (`APP_WEBHOOK_PUBLIC_URL` was removed, backlog 127).
  >
  > **As built at WP-110 (PROGRESS backlog 297): the merge-request poller.** A git binding whose
  > configuration sets `poll_enabled` (the same platform keys; GitLab's `pollPlan()` also needs a
  > `project`) is polled by one `mr.poll` job per binding (`packages/application/src/pipeline/mr-poll.ts`)
  > — WP-87's shape: a cursor on the binding (`bindings.mr_poll_cursor`, migration 0068), the same
  > overlap and widening window (`pollWindow`), the same sweep and re-arm, the read
  > (`GitProviderPort.listMergeRequests`: GitLab's *List project merge requests* with `updated_after`,
  > `order_by=updated_at`, `sort=asc`, every state) through the executor outside every transaction,
  > and each listed merge request redacted and recorded by `recordNormalisedDelivery` on the key
  > `<provider>:poll:<project>:<path>!<iid>@<updated_at>`. A listing is a **state**, so it becomes the
  > transition the log does not have yet: `mr.opened` for a merge request created inside the window
  > (or reopened after the log's `mr.closed`), `mr.updated` with the provider's `updated_at` for an
  > open one, `mr.merged` / `mr.closed` when it merged or closed — for a merge request the log has
  > never heard of, only when that instant is inside the window, so an old merge request touched
  > today is not announced as new. **"Dedup makes both paths safe together", for merge requests,
  > is the log's**: a poll's key can never equal a webhook's delivery id, and several consumers of a
  > merge request's lifecycle are not one-per-merge-request (the merge measurement counts per event;
  > a second close met `needs_human → needs_human`), so `recordNormalisedDelivery` drops an
  > `mr.opened`/`mr.merged`/`mr.closed` draft that repeats the newest lifecycle event the project's
  > log holds for that merge request (`integrations/merge-request-lifecycle.ts`), for **both** doors;
  > the read is served by `events_mr_lifecycle_idx` (migration 0068) and is race-free because it is
  > taken after the stream sequence the append is guarded by. A listing can be **overtaken** between
  > the list and the record (a webhook records a close; the stale `opened` listing would read as a
  > reopen), so a listing whose transition goes against the log of a merge request the log already
  > knows is **confirmed by one more read of that merge request** and records nothing if the provider
  > no longer says its state — one read per transition the poll finds, never per listing. (WP-110
  > review round 1 compared the listing's `updated_at` with the platform's `occurred_at` instead; two
  > clocks, and on a poll-only binding it lost a merge GitLab stamped before the platform recorded
  > the open — closed at review round 2.) The saga's `mr.closed` branch also amends the brief of a
  > task already at `needs_human` rather than escalating it again (`amendEscalation`). **What a merge-request poll cannot see**:
  > approvals (`mr.approved`), review comments (`mr.review.comment`), finished pipelines
  > (`ci.pipeline.finished` — the CI gate reads the head's pipeline itself, `gates.ts`) and
  > default-branch moves (`default_branch.moved`) stay webhook-only; a merge request opened and
  > closed between two polls is one `mr.closed`; `blocking_threads_resolved` is never sent. Two
  > `mr.updated` for one push can still land (one per door); the head handler orders them by the
  > provider's instant.
  >
  > **Amended at WP-123 (PROGRESS backlog 373): a poll-only binding re-checks Ready and hears a
  > reviewer.** The sentence above is now true only of a binding a webhook can reach. A git binding
  > whose plan says **no** webhook reaches it (`MergeRequestPollPlan.receives_webhooks: false`; for
  > GitLab, neither `webhook_secret_token` nor `webhook_signing_token` is set, so every delivery is
  > refused — so a secret set for a webhook GitLab cannot actually reach turns **both** paths off for
  > that binding, as the setup guide warns) makes two more reads per `mr.poll`, both through the executor outside every
  > transaction: **(a)** `getBranchHead` of the **stored** default branch (WP-142), compared with `bindings.mr_poll_default_head`
  > (migration 0074; cleared by a change of the stored branch, so the next poll is a first read and records no move) — a different head is recorded as `default_branch.moved` by
  > `recordNormalisedDelivery` on the key `<provider>:poll:<project>:<path>@default:<old>..<new>`
  > and then written (a poll that dies between the two records the same key again and collides), and
  > the first read records nothing — the one move it cannot record is an exact repeat of an earlier
  > pair (A → B → A → B), which needs the protected default branch force-pushed twice; **(b)** for each task at
  > `ready_for_merge` (at most `MR_POLL_REVIEW_TASKS_LIMIT`, 20, oldest entry first, a `warn` past
  > it), `listDiscussions` — each note a person wrote (not `system`, not `isPlatformNote`) at or
  > after the Ready stage row's `entered_at` **less five minutes** (`REVIEW_NOTE_SKEW_MS`: the
  > comparison crosses the provider's clock and the platform's, so it errs toward reading a note
  > early rather than losing one) is recorded as `mr.review.comment` on the key
  > `<provider>:poll:<project>:<path>!<iid>#note:<id>`. Both reads fail open (a `warn`, retried next
  > poll; the stored head and the per-note keys lose nothing). **Only for a poll-only binding, by
  > the ruling**: a binding with a webhook gets both events from its deliveries, so no event
  > arrives by two doors and no cross-door dedup is needed. **Approvals stay webhook-only** — they
  > feed the human-time projector's review minutes and nothing else. Residuals: a polled note is
  > dated by the poll that recorded it (up to one interval late), and a person's note written up to
  > five minutes before the task entered Ready arms the review window a webhook would not have.
- **Slack** uses Socket Mode (research/03): a long-lived connection in the API process (or a dedicated `slack` process when scaling), emitting the same domain events.
  > **As built at WP-43.** The connection is held by **the process that serves `/webhooks/*`** —
  > `ROLE=all` or `ROLE=api` — and by construction rather than by a flag: `startRuntime` hands the
  > held-connection supervisor (`@platform/application`'s `inbound-connections.ts`) the process's
  > webhook ingress, which exists exactly when the role serves the API, and every envelope is handed
  > to that same `WebhookIngress.deliver` the HTTP route calls. There is no dedicated `slack`
  > process in this build. One connection per `communication` account whose `integrations.config`
  > selects Socket Mode (the default); it is opened at composition, re-read every minute, closed at
  > shutdown, and an account the process will not hold — a worker role, no app-level token, no
  > signing secret, a refused `apps.connections.open` — is **named** in the log. The open itself goes
  > through `IntegrationActionExecutor` as a read (egress allow-list, rate limit, one audit row per
  > open). The WebSocket it returns does not pass the executor, and **its host is the real trust
  > boundary** — the socket signs each envelope with the binding's own secret, so whatever answers
  > there is trusted by construction — so the adapter refuses (`forbidden`, by name, before
  > connecting) a `wss://` host that is not the binding's allow-listed `base_url` host or a
  > subdomain of it (`assertSocketHost`; Slack answers `wss-primary.slack.com` for `slack.com`). Two API replicas hold
  > two connections; Slack sends each payload to one of them and may resend it to another, and the
  > `inbox (provider, delivery_id)` key — built from the payload, not the connection — is the
  > backstop. Slack delivers events and interactive payloads **only** over the socket while Socket
  > Mode is on (<https://docs.slack.dev/apis/events-api/using-socket-mode>, retrieved 2026-09-26),
  > so the two transports are an operator's either/or, and the setup guide says which to pick.
  > **A human decision a provider delivers is decided by its aggregate**, not appended: the ingress
  > hands `task.approval.decided` and `task.question.answered` to `inbound-decisions.ts`, which runs
  > `decideApproval` / `answerQuestion` — `can()` against the decider's role in the project, first
  > answer wins — in the delivery's own transaction, and records a refusal on the `inbox` row.
  - **The signature is not optional in Socket Mode** (WP-10). A Socket Mode payload arrives with no
    Slack signature on it, but the interactivity and events *HTTP* paths exist whether or not an
    operator enables them, so the adapter wraps every envelope into a `WebhookDelivery` signed with
    the binding's own signing secret and hands it to the same `inbound.verify`. That local
    signature attests the **transport**, not Slack's key; what it buys is a single door, so a
    caller that forgets which transport a delivery came from cannot skip verification. Its
    fail-closed consequence is the useful one: a binding with no usable signing secret cannot open
    a socket at all, because every delivery it produced would be refused downstream.
  - **The identity is the Slack user id and nothing else.** A display name, a username and an email
    inside a message body are typed by whoever sent it; `resolveUser` is given
    `{provider: 'slack', external_id: 'U…'}` and no forgeable field. The *other* half of the
    mapping — a platform user's email to a Slack account — is `resolveIdentity`, which calls
    `users.lookupByEmail` at setup time and **refuses** a bot, an app user or a deactivated
    account, because those cannot be a platform user and mapping one would make anything that can
    post as that bot able to answer a question (BD-006, Q10).
- Actor identity: every normalised event carries `{provider, providerUserId, email?, displayName}` resolved to a platform user when possible; unresolved identities are stored as `unmapped` (BD-022).

## Outbound: actions

- Every action call goes through an `IntegrationActionExecutor` that: checks shadow mode (mutating actions are no-ops recorded as `would_have`), applies rate-limit/backoff per provider (429 + `Retry-After`), enforces idempotency (marker ids for comments, "only transition if not already there"), records `integration.action.performed|failed` with redacted payload, and updates health.
- **Row and event are not the same record** (settled at WP-07, reconciling this section with technical/02's invariant "shadow tasks never produce `integration.action.performed` for mutating actions"). The `integration_actions` row records what the platform *decided*; the event records what the provider was *made to do*. So `ok` → row + `integration.action.performed`; `failed` → row + `integration.action.failed`; `would_have` (shadow) and `replayed` (idempotency hit) → row only, because nothing was sent. The mapping is one exported function, `integrationActionEventDrafts`, which every audit-log adapter must use.
- **Shadow mode is one guard in the executor, not a null adapter** (settled at WP-07 review round 1; this section and technical/10 previously implied both). A `MutatingActionRequest` carries the task's `mode` as a **required** field, and the executor returns `shadowResult()` with a `would_have` row before it touches the rate limiter or the provider. One guard is provable — a single branch, mutation-checked, with the contract suite driving every fake through it — where N null adapters would each have to be written, kept in step with its port and independently proved never to write. It also keeps the audit honest: a null adapter *bypasses* the executor and so records nothing, while the row is exactly what shadow mode is for (product/12's ShadowReport). The type ports have no shadow variant, and `packages/integrations`'s fakes are test doubles: nothing in the product path swaps an adapter for a fake. **One declared carve-out since WP-76** (Q98 (a), TD-028 decision 7): a shadow task's `read`-scoped git credential mint, and a git credential revoke of any scope, are performed (status `ok`, event `integration.action.performed`) with `shadow` in the row — the request declares it with no idempotency key, and the executor, checking the declaration before it reads the mode, refuses it on any other action or on a mint of any other scope.
- On success the idempotency key is stored **before** the audit row is written: a crash between the two then costs a less precise status (`replayed` instead of `ok`) rather than a second comment on the ticket.
- Rate-limit budgets are per `integrations.id`, not per provider name — two bindings of one provider are two accounts with two quotas — and a provider that knows better declares its own policy, which the production executor's `rateLimits` resolver hands it (`pipelineRateLimitPolicy` in `packages/integrations/src/bindings/shipped-registry.ts`; today only Jira Cloud declares one, wired at PROGRESS backlog 550). **A call nested in another call's `perform` on the same integration runs under the outer call's lease** (backlog 550): the limiter holds a slot across `perform` and a waiter has no deadline, so the Jira adapter's own executor call inside the pipeline's used to wait for a second slot while holding the first, and `maxConcurrent` concurrent calls deadlocked that integration in that process. The nested call takes no slot and no token and makes one attempt (the outer call owns the retries); its shadow guard, idempotency record and audit row are unchanged, so a pipeline call through a Jira binding still writes two rows until the adapter adopts GitLab's shape.
- Actions are triggered by event handlers in the integration priority band (100–199), so the pipeline never calls providers directly.
- **An action is decided by a handler and performed by a job — never inside the handler's transaction** (settled at WP-15d; this section named the *band* and said nothing about the *transaction*, which is the silence that let three handlers call providers from inside `context.scope.tx`). A handler holds the dispatcher's transaction, its own, and one of the deployment's dispatch slots; a provider call made there holds all three for the length of an HTTP round trip, and the audit row BD-003 requires then commits **inside** the caller's transaction instead of after it. So the handler enqueues one `pipeline.outbound` job from `HandlerContext.afterCommit` and the job performs the call outside every transaction. Three rules come with it:
  - **the job re-validates on fire** (TD-004 has no cancel and `afterCommit` is at-most-once), so a wake-up that arrives twice, late, or not at all is survivable: the workpad and the ticket status are re-derived from the task row by the next event, and the intake branch check finds the task already created;
  - **what cannot be un-done is not done before the decision commits.** Nothing withdraws a comment posted for a task whose transaction rolled back, which is the argument *for* the job rather than against it: inside the transaction the failure mode is a ticket comment for a task that never existed, outside it a committed task whose comment is one retry late;
  - **a mutating action carries an idempotency key made of the wake-up** (`<action>:<platform id>:<cause event id>`), because a job is at-least-once and an edit-in-place is not a replacement for one. The key never carries provider text: the executor *refuses* a key that would need redacting.
- The **core band is under the same rule**: intake's protected-branch check is a read a priority-10 handler decides on and a job performs. "The pipeline never calls providers directly" is about the executor being the only door; it was never a licence for the core band to call one from inside a transaction.
- **The executor's scope is *per binding*, and a call with no binding is audited by its own module** (settled at WP-51; PROGRESS backlog **97**, answer (a)). Every duty above is expressed in terms of an `integrations` row — the audit is `integration_actions.integration_id uuid not null references integrations (id)`, the idempotency record is scoped the same way, the rate-limit budget is per `integrations.id` — so the rule this section states is precisely *"every outbound call the platform makes **on behalf of a binding** goes through the executor"*. That is narrower than "every outbound call" and nothing said so until WP-51; `CLAUDE.md`'s non-negotiable and the executor's own docblock are qualified to match. The table is **not** widened: making `integration_id` nullable with a `source` discriminator teaches three readers (the audit screen, the cost ledger's joins, the task index) and a separate `outbound_calls` table builds a schema for one caller; neither earns its cost on this build. The cheap wrong answer is worse than both — attributing a registry request to whatever binding is at hand makes the audit trail *lie* about which credential was in scope. **A platform-owned call — no `integrations` row, no credential, no project configuration — is therefore audited by its own module, under a named checklist**: (1) no credential in scope, so the property the audit polices cannot be violated; (2) an operator-declared host, matched exactly, empty by default; (3) a bounded body read with a timeout; (4) no writes, so there is no side effect an idempotency record would protect; (5) `assertOutsideTransaction`. The one such module today is `packages/infrastructure/src/dependencies/registry-metadata.ts` (WP-38, Q84), and what it does **not** get is stated there rather than implied: no `integration_actions` row, no idempotency record, no per-integration rate limiter. A second platform-owned call meets this decision instead of re-deriving it.
- **An organisation-scoped call goes through the executor too, keyed by the account and by no project** (WP-65, PROGRESS backlog 80). It is the third shape, and it is *not* the platform-owned one above: it has an `integrations` row and a credential, just no **binding** — the organisation budget's notification, which has no project. `createOrganisationIntegrationsLoader` (`packages/integrations/src/bindings/organisation-loader.ts`) builds the organisation's **communication account** the way the project loader builds a binding — its registration, its decrypted credentials, the provider's strict schema over the account's **own** `integrations.config` (no binding overlay), a redactor over the account's own credentials composed with the platform's — and hands back the same `PipelineIntegrations` shape with `git` and `taskManagement` always `null`, through the guarded door `integrationsForOrganisation`. Every call made through it is an ordinary `IntegrationActionExecutor` call, so its audit row, idempotency record and rate-limit budget are keyed by that account's `integrations.id` and its `integration_actions` row names **no project** — the honest attribution, because that account's credential and no project's configuration was in scope; attributing it to a project the account happens to be bound to would state something false. The channel is the one the account names in its own config (the value every binding overrides), so an organisation-scoped message goes to exactly one channel a human already chose. An account whose own config names no channel means the organisation chose none: the call is not made and the duty says so at `warn`. **Two** accounts that each name one are refused by name (`BindingLoadError`), the same refusal a project with two chat bindings gets — which to pick is Q103. Any future organisation-scoped outbound call (a digest of organisation-wide events, an organisation-level ticket) takes this path rather than re-deriving it.
- **A binding may only name a host the operator declared** (settled at WP-51; PROGRESS backlog **48**). `integrations.config` carries a free-form URL written by an `integration.write` caller, and it is handed to the client that binding's credential is built into — so an administrator who may name a host and a credential *field*, but who by design never sees the credential's *value*, could have the platform deliver it to a host they read, recorded in the audit as an ordinary successful call. `APP_INTEGRATION_HOSTS` (technical/12) is the answer: instance configuration, **never settable through the API**, empty by default and therefore closed (a single `*` declares it open), matched **exactly** on the host — `gitlab.example.com` admits neither `evil-gitlab.example.com` nor `gitlab.example.com.evil.test`, the same three shapes technical/05's egress renderer is argued from. It is enforced in **two** places because one is not enough: at write time, so `POST /api/integrations` — and, since WP-100, `PATCH /api/integrations/:id` and a binding's overlay in `PUT /api/projects/:id/bindings` — refuses with `403 integration_host_not_permitted` naming the host and the setting; and at **call** time in the executor, against `IntegrationRef.host` — the host the adapter read out of its own validated config — so a row written before the list existed, narrowed out of it afterwards, or written with `psql` is refused before anything is sent. The five provider config schemas stop being bare `z.url()` at the same time: `http`/`https` only, because `z.url()` accepts `javascript:`, `data:`, `vbscript:` and `file:` (Q49). What the list does not do is stated rather than implied: it decides over **names**, not addresses, and it never sees a redirect — the response is consumed inside the adapter. **Since WP-59 (PROGRESS backlog 129) no redirect is followed at all**: all five provider HTTP clients send `redirect: 'error'` (the registry client's spelling), a `3xx` to another host *or* the same one fails the call rather than being re-checked, and `packages/integrations/src/providers/redirect-refusal.test.ts` holds every provider directory to it with an injected `fetch` answering `302`. Before it, a redirect was followed with whatever headers Node's `fetch` keeps across origins — measured at WP-59, GitLab's `private-token` among them.
- **A configuration is parsed with the provider's own schema at the write** (WP-100; PROGRESS backlog **328**). `POST /api/integrations` and `PATCH /api/integrations/:id` parse `config` — and `PUT /api/projects/:id/bindings` the account's document with the binding's overlay on top — with the provider's `configSchema` minus its credential fields (`accountConfigSchema`, read off the catalogue, never a constructed provider), and refuse `400 invalid_integration_config` / `invalid_binding_config` naming each key path, never a value, before any row is written. It is the question the binding loader and the prober ask at use, moved to where the mistake is made: until WP-100 the create stored whatever it was sent and the SPA's form sent `config: {}`, so every integration created from the screen answered 201 and failed at the first probe and every load. A row written before it publishes `config_refusal` on `GET /api/integrations`, and `/test` answers `409 invalid_integration_config`, each naming the paths and the `PATCH` that repairs them. The form renders each provider's required fields from `GET /api/integrations/providers`, which is the same catalogue.
- **A static run credential** (WP-137; TD-028 decision 13). A git registration may declare which config keys carry one (`ProviderRegistration.staticRunCredential`: the mode, the run token's secret field, the API token's field, the username, the expiry and the minting switch — checked against `configSchema` and `secretFields` at registration), so no consumer names GitLab's keys (BD-017). GitLab's are `run_credential: minted | static`, the secret `run_token`, `run_token_username` and `run_token_expires_at` — the three non-secret ones **account-only** (`accountOnlyFields`), so no project's binding overlay can switch its account to `static`. The binding loader reads it out of the validated, secret-merged document into `GitBinding.staticRunCredential` for the run-credential path alone, and GitLab's `create` builds the adapter **without** `run_token` (`gitlabAdapterInput`) — held by `emitted-secrets.test.ts`'s census over every request the adapter makes, which since WP-141 admits the run token in exactly one: the scope proof's `GET /user`, made with the token passed as an argument on a transport built for that call. The four writes of an integration's configuration or credentials refuse a broken one by name (`run_credential_refused`, 400; the configuration-only rules through `configIssuesOf` as `invalid_integration_config`), and the bindings `PUT` refuses a second project's binding of a static integration (`static_run_credential_shared`, 409, under a transaction-scoped advisory lock per integration, which a `PATCH` into `static` takes too). The probe adds a `run_credential` check — `projectMemberAccess` through the executor, `check_run_credential_member`, a read with the API token — that refuses a role that cannot push or one above Developer, and always says it cannot confirm the token's owner. technical/05 § "Credentials and identity" has the run path and what is lost. **Whose token** (WP-141; TD-028 decision 13a): `run_token_owner: dedicated_user | operator` (account-only; `operator` refused unless `static`; `StaticRunCredentialSupport.ownerField` and the provider's `scopeProofHint`). For `operator` the probe does not read a membership: it reports `run_credential` as the **scope proof** (`runTokenApiAccess` through the executor, `check_run_token_scope`, accepted only on a refusal for scope) and a `default_branch_protection` check (`branchPushProtection`, `check_default_branch_protection`, on the bound project's stored default branch), and `runCredentialWrites.mint` repeats the protection read before every run that gets the token. **A project SSH deploy key** (WP-146; TD-028 decision 13b): `StaticRunCredentialSupport.deployKey` declares a third `modeField` value and its two keys — GitLab's `run_credential: deploy_key`, the secret `run_ssh_private_key` (stripped from the adapter's input like `run_token`, and held to no request by the same census) and the account-only `run_ssh_public_key` — and the provider's SSH route (`sshRoute`: GitLab.com's `altssh.gitlab.com:443`, pinned under `gitlab.com` with the documented host keys in `providers/gitlab/ssh-route.ts`; any other `base_url` is refused by name). The write refuses a key with a passphrase, another type, a public key that is not its own (derived from the seed), minting beside it and a run token beside it (`deployKeyWriteIssues`); the loader reads it into `GitBinding.deployKeyRunCredential`; the one-binding rule covers it (`declaresDedicatedRunCredential`); the probe reports `run_credential` from `deployKeyAccess` (`check_deploy_key`, write access required) and `default_branch_protection` (push "No one", no deploy key admitted). technical/05 has the run path: the key stays with the runner and the run container gets an ssh-agent socket.
- **A credential is re-sealed, and an integration retired, through two commands** (WP-114; PROGRESS backlog **331**). `POST /api/integrations/:id/secrets` re-seals: `secret_refs` is the create's — credential field → the **name** of an environment variable on the operator-declared `APP_INTEGRATION_SECRET_ENV`, read and sealed by the server (TD-020; no credential crosses the API) — and each named field's sealed row is **replaced and deleted**, a field not named keeping its own (a stored row that cannot be opened is deleted too: it already failed every load); `health` resets, `Idempotency-Key` is required and the claim is taken in the effect's transaction. `DELETE /api/integrations/:id` **retires**: the integration's `secrets` rows are deleted, `secret_ids` and `health` emptied and `retired_at` set (migration 0070), and the row is **kept**, because `integration_actions.integration_id` is a `NOT NULL` foreign key and the audit must keep naming the credential a call used (BD-003). It is refused while a binding names the integration (`integration_bound`) or while a minted run credential of it is unexpired and not confirmed revoked (`integration_has_live_credential`) — TD-028 decision 10 revokes through the minting integration, and a retire would destroy the credential the revoke needs. The check and the retire are one transaction under the integration's **row lock**, which a bindings `PUT` takes `for share` and a mint's audit insert takes `for key share` through the foreign key, so whichever commits first decides. A mint whose provider call is in flight across an unbind and a retire is recorded on the retired row afterwards, so the mint reads `retired_at` **after** its record commits and, finding it set, revokes through the adapter it already holds (which kept the decrypted credential) and refuses the run start (`MintingIntegrationLiveness`, PROGRESS backlog 386). A retire is also refused while the account is the organisation's flagged chat account (`integration_is_organisation_default`), and `PATCH /api/org` refuses to flag a retired one (`integration_retired`), under the same row lock (backlog 387). A retired integration is never loaded (`BindingRepository.forIntegration` answers no account; a binding of it is refused by name by the loader), is listed with `retired_at`, and refuses every write (`409 integration_retired`); its name stays taken. Rotating a token is therefore one re-seal, not a second integration; the Slack and Sentry setup guides name the path.
- **A broken organisation account is named once** (WP-157; PROGRESS backlog **413**). Every live communication account's credentials join every project's exact-value set over prompt files (WP-121), so one that will not decrypt withholds the prompt files of **every** project. `GET /api/integrations` publishes `credentials_readable` on each live communication account — answered by `createOrganisationAccountCredentialCheck`, the same resolution the reading that withholds uses, and carrying no value and no store reason — with `credentials_consequence` naming the cost; every other row is `null`, *not checked*. The Integrations card says it on the account and the dashboard renders one banner for a maintainer, whatever the project count. `/readyz` is unchanged.

## Agent tooling exposure

Providers declare what an agent may use inside a run: a CLI on PATH with an env spec (names of variables the runner injects from run-scoped credentials), a skill (recipes), and optionally an MCP server spec. The spec type has **no field for a value** — only names, and for an MCP server only header names — so a provider that wanted to ship a token would have to change the type, which is the review that should happen (BD-002, BD-025). The runner mounts only the tooling for the stage's tool policy (product/13 table).

> **A provider may legitimately mount nothing, and the type has to allow it** (settled at WP-11).
> Sentry publishes three agent-facing surfaces and none of them has an environment contract the
> platform can honour: the hosted MCP server authenticates by OAuth ("the first connection will
> trigger an authentication flow"), which a run container cannot perform and which a spec carrying
> only *names* cannot express; the classic `sentry-cli` documents its whole environment and has no
> issue commands; the new interactive CLI's documentation is not on the vendor's documentation
> site. WP-08 answered the same question the same way for Jira. So the honest spec is one that
> mounts no CLI and no MCP server — and the contract suite was widened to accept it
> **together with** a new obligation, because relaxing a rule alone is a weakening (standing rule
> 23): *a spec that mounts nothing must declare no secret variable at all.* A credential injected
> into a run container for a tool that is not there is a secret handed out for no reason (BD-025),
> and that is now a positive assertion every provider and every fake is held to. The open question
> about Sentry's missing comment and code-link endpoints is Q43.
>
> **Amended since** (standing rule 83): both specs now name a **skill** — Sentry's `sentry-issue`
> since WP-14a, and Jira's `jira-ticket` since WP-54 — while still mounting no CLI and no MCP server
> and declaring no variable. A skill is prompt material, not a mount, and since WP-54 it is what a
> binding provisions: a provider skill reaches a run only when the project has a binding whose
> `AgentTooling.skill` names it (`createBoundSkillsReader`, over the catalogue). Mutating ticket/MR actions are exposed to agents only via the platform MCP (`add_ticket_comment`, `open_mr`, `update_mr_description`, `create_followup_ticket`, `ask_human`, `report_progress`, `kb_search`, `get_task_context`) which enforce policy and audit.

## Health and setup

Each binding shows: last inbound event, last outbound success/failure, token expiry (from provider metadata when available), and a generated setup guide (webhook URL + secret, required scopes, Slack manifest). *Test connection* runs a read-only capability probe.
