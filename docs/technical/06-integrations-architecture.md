# 06 — Integrations architecture

> Round 2 design. Sources: product/08, BD-017, BD-022, BD-023, BD-025, research/03. Provider-specific library choices are recorded in TD records once research/05 lands.

## Type contracts (ports in the application ring)

Each integration **type** is a TypeScript/Python interface pair: an *outbound port* (actions the platform calls) and an *inbound normaliser* (provider payload → domain events with verified actor identity). Providers implement both. The pipeline, UI and knowledge base depend only on the ports.

### TaskManagement
```
readTicket(ref) -> Ticket {key, url, type, title, description, comments[], labels, priority, links[{type, key, state}], epic?: {key, title, description}, siblings?: [{key, title, state}], attachmentsText[]}
matchTickets(rule) -> TicketRef[]                   # polling fallback
transition(ref, targetStatusName, fields?) -> {changed, from, to}   # resolves at runtime; already there = {changed:false}; unknown target fails loudly
upsertWorkpad(ref, markerId, markdown) -> CommentRef # edit in place (BD-023)
addComment(ref, markdown) -> CommentRef              # questions, linter output
setLabels(ref, add[], remove[])
linkMergeRequest(ref, mrUrl)
createTicket(draft) -> TicketRef                     # scope-creep valve, epic split, maintenance chores
resolveIdentity(providerUserId|email) -> UserIdentity
inbound: InboundNormaliser                           # see below; ticket.matched|comment.added|status.changed
capabilities() -> {webhooks, epics, links, customFields, adf, createTicket, attachments}
testConnection() -> HealthProbe                      # read-only probe (product/08 § Health and setup)
```
Markdown → provider format converter (ADF for Jira Cloud, wiki markup for DC) lives in the provider module.

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

### GitProvider
```
cloneUrl(project, credential) ; mintCredential(project, scope: read|push:agentic/*, ttl) -> Credential
openMergeRequest({branch, target, title, description, draft, labels, reviewers}) -> MrRef
updateMergeRequest(mr, {description?, draft?, labels?, reviewers?, title?})
getMergeRequest(mr) -> {state, draft, headSha, mergeable, diffStats, coverage?}
listDiscussions(mr) ; replyToDiscussion(mr, discussionId, markdown) ; resolveDiscussion(mr, discussionId)
createDiscussion(mr, {path, line, markdown})          # review findings
getPipelineStatus(headSha) -> {status, url, jobs[{name, status, logRef}]}
getJobLog(jobId, {tailBytes}) -> string
getDefaultBranchHead(project) -> sha
readCodeowners(project, ref) -> Rules
listMergedMergeRequests(project, since, limit) -> [{iid, author, mergedAt, diffStats, discussions[]}]   # history bootstrap, shadow comparison
revokeCredential(credential)                          # when the workspace is destroyed
inbound: InboundNormaliser -> mr.* | ci.pipeline.finished | default_branch.moved
capabilities() -> {webhooks, projectTokens, groupTokens, codeowners, coverageArtifacts, draftPipelines, discussionResolution, credentialMinting}
```
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

### ObservabilityErrors
```
getIssue(ref) ; getLatestEvent(ref) -> {stackTrace, breadcrumbs, tags, release, firstSeen, lastSeen, count}
searchIssues(project, query, since)
linkMergeRequest(issue, mrUrl) ; comment(issue, text) ; resolve(issue, inRelease?)
agentTooling() -> {mcp?: McpServerSpec, cli?: CliSpec, skill: SkillRef, env: EnvSpec}
```
No inbound normaliser in v1: product/08 lists `error.issue.created` as optional and technical/02's catalogue has no such event, so a normaliser would have nothing legal to emit.

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

### ObservabilityLogs
```
queryRange(selector, from, to, limit, filter?) -> {streams[], line_count, truncated}
labels(name?) ; series(selector, since)
agentTooling() -> {cli: logcli spec, skill, env}
capabilities() -> {labels, series, maxRangeMs, maxLines}
```
The caps are enforced, not advisory: a range or a limit above `capabilities()` is `invalid_request`, and a result that hit the limit says `truncated: true`, because a truncated answer to "is this error still happening?" reads exactly like a complete one.

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
                            # digest.ts, provider.ts, index.ts, app-manifest.json, manifest.ts,
                            # setup-guide.md
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
>    assert that a shadow-mode call issued *zero* requests.
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

- One HTTP endpoint per provider (`/webhooks/<provider>/<integrationId>`), verifies signature (`X-Hub-Signature`, `X-Gitlab-Token`, `Sentry-Hook-Signature`, Slack signing secret when not in Socket Mode), stores the raw payload (audit), computes a **dedup key** (Jira `X-Atlassian-Webhook-Identifier`; GitLab event + object id + `updated_at`; Sentry hook id), and enqueues normalisation as a job. Response is 2xx within milliseconds; all work is asynchronous.
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
- **Polling fallback** per binding when no public URL (`APP_WEBHOOK_PUBLIC_URL` unset) or as a safety net: Jira `search/jql` with `updated >= -Nm`, GitLab MR/pipeline listing since last cursor; same normaliser; dedup makes both paths safe together.
- **Slack** uses Socket Mode (research/03): a long-lived connection in the API process (or a dedicated `slack` process when scaling), emitting the same domain events.
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
- **Shadow mode is one guard in the executor, not a null adapter** (settled at WP-07 review round 1; this section and technical/10 previously implied both). A `MutatingActionRequest` carries the task's `mode` as a **required** field, and the executor returns `shadowResult()` with a `would_have` row before it touches the rate limiter or the provider. One guard is provable — a single branch, mutation-checked, with the contract suite driving every fake through it — where N null adapters would each have to be written, kept in step with its port and independently proved never to write. It also keeps the audit honest: a null adapter *bypasses* the executor and so records nothing, while the row is exactly what shadow mode is for (product/12's ShadowReport). The type ports have no shadow variant, and `packages/integrations`'s fakes are test doubles: nothing in the product path swaps an adapter for a fake.
- On success the idempotency key is stored **before** the audit row is written: a crash between the two then costs a less precise status (`replayed` instead of `ok`) rather than a second comment on the ticket.
- Rate-limit budgets are per `integrations.id`, not per provider name — two bindings of one provider are two accounts with two quotas — and a provider that knows better passes its own policy at registration.
- Actions are triggered by event handlers in the integration priority band (100–199), so the pipeline never calls providers directly.
- **An action is decided by a handler and performed by a job — never inside the handler's transaction** (settled at WP-15d; this section named the *band* and said nothing about the *transaction*, which is the silence that let three handlers call providers from inside `context.scope.tx`). A handler holds the dispatcher's transaction, its own, and one of the deployment's dispatch slots; a provider call made there holds all three for the length of an HTTP round trip, and the audit row BD-003 requires then commits **inside** the caller's transaction instead of after it. So the handler enqueues one `pipeline.outbound` job from `HandlerContext.afterCommit` and the job performs the call outside every transaction. Three rules come with it:
  - **the job re-validates on fire** (TD-004 has no cancel and `afterCommit` is at-most-once), so a wake-up that arrives twice, late, or not at all is survivable: the workpad and the ticket status are re-derived from the task row by the next event, and the intake branch check finds the task already created;
  - **what cannot be un-done is not done before the decision commits.** Nothing withdraws a comment posted for a task whose transaction rolled back, which is the argument *for* the job rather than against it: inside the transaction the failure mode is a ticket comment for a task that never existed, outside it a committed task whose comment is one retry late;
  - **a mutating action carries an idempotency key made of the wake-up** (`<action>:<platform id>:<cause event id>`), because a job is at-least-once and an edit-in-place is not a replacement for one. The key never carries provider text: the executor *refuses* a key that would need redacting.
- The **core band is under the same rule**: intake's protected-branch check is a read a priority-10 handler decides on and a job performs. "The pipeline never calls providers directly" is about the executor being the only door; it was never a licence for the core band to call one from inside a transaction.

## Agent tooling exposure

Providers declare what an agent may use inside a run: a CLI on PATH with an env spec (names of variables the runner injects from run-scoped credentials), a skill (recipes), and optionally an MCP server spec. The spec type has **no field for a value** — only names, and for an MCP server only header names — so a provider that wanted to ship a token would have to change the type, which is the review that should happen (BD-002, BD-025). The runner mounts only the tooling for the stage's tool policy (product/13 table).

> **A provider may legitimately mount nothing, and the type has to allow it** (settled at WP-11).
> Sentry publishes three agent-facing surfaces and none of them has an environment contract the
> platform can honour: the hosted MCP server authenticates by OAuth ("the first connection will
> trigger an authentication flow"), which a run container cannot perform and which a spec carrying
> only *names* cannot express; the classic `sentry-cli` documents its whole environment and has no
> issue commands; the new interactive CLI's documentation is not on the vendor's documentation
> site. WP-08 answered the same question the same way for Jira. So the honest spec is one that
> mounts no CLI, no MCP server and no skill — and the contract suite was widened to accept it
> **together with** a new obligation, because relaxing a rule alone is a weakening (standing rule
> 23): *a spec that mounts nothing must declare no secret variable at all.* A credential injected
> into a run container for a tool that is not there is a secret handed out for no reason (BD-025),
> and that is now a positive assertion every provider and every fake is held to. The open question
> about Sentry's missing comment and code-link endpoints is Q43. Mutating ticket/MR actions are exposed to agents only via the platform MCP (`add_ticket_comment`, `open_mr`, `update_mr_description`, `create_followup_ticket`, `ask_human`, `report_progress`, `kb_search`, `get_task_context`) which enforce policy and audit.

## Health and setup

Each binding shows: last inbound event, last outbound success/failure, token expiry (from provider metadata when available), and a generated setup guide (webhook URL + secret, required scopes, Slack manifest). *Test connection* runs a read-only capability probe.
