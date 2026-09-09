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

### ObservabilityLogs
```
queryRange(selector, from, to, limit, filter?) -> {streams[], line_count, truncated}
labels(name?) ; series(selector, since)
agentTooling() -> {cli: logcli spec, skill, env}
capabilities() -> {labels, series, maxRangeMs, maxLines}
```
The caps are enforced, not advisory: a range or a limit above `capabilities()` is `invalid_request`, and a result that hit the limit says `truncated: true`, because a truncated answer to "is this error still happening?" reads exactly like a complete one.

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
  providers/gitlab/ providers/slack/ providers/sentry/ providers/loki/
  registry.ts               # providers register {type, id, configSchema, secretFields, capabilities, agentTooling}
test/contract/support/integrations/
  <type>-contract-suite.ts  # the reusable suite, parameterised over a harness factory
test/contract/integrations/
  <type>.contract.test.ts   # runs the suite against the fake; provider WPs add a replay-mode runner
```

The suites sit under `test/` for the same reason the `Jobs` contract suite does (technical/10 and
WP-05): one exported suite, several runners — the fake on every `verify`, each real adapter in nock
replay mode — and a suite that lived inside a package would be counted as that package's coverage
while asserting nothing about it.

Adding GitHub = `providers/github/` implementing GitProvider + fixtures + setup guide + a runner for
the existing suite (BD-017).

## Inbound: webhooks and polling

- One HTTP endpoint per provider (`/webhooks/<provider>/<integrationId>`), verifies signature (`X-Hub-Signature`, `X-Gitlab-Token`, `Sentry-Hook-Signature`, Slack signing secret when not in Socket Mode), stores the raw payload (audit), computes a **dedup key** (Jira `X-Atlassian-Webhook-Identifier`; GitLab event + object id + `updated_at`; Sentry hook id), and enqueues normalisation as a job. Response is 2xx within milliseconds; all work is asynchronous.
- **Polling fallback** per binding when no public URL (`APP_WEBHOOK_PUBLIC_URL` unset) or as a safety net: Jira `search/jql` with `updated >= -Nm`, GitLab MR/pipeline listing since last cursor; same normaliser; dedup makes both paths safe together.
- **Slack** uses Socket Mode (research/03): a long-lived connection in the API process (or a dedicated `slack` process when scaling), emitting the same domain events.
- Actor identity: every normalised event carries `{provider, providerUserId, email?, displayName}` resolved to a platform user when possible; unresolved identities are stored as `unmapped` (BD-022).

## Outbound: actions

- Every action call goes through an `IntegrationActionExecutor` that: checks shadow mode (mutating actions are no-ops recorded as `would_have`), applies rate-limit/backoff per provider (429 + `Retry-After`), enforces idempotency (marker ids for comments, "only transition if not already there"), records `integration.action.performed|failed` with redacted payload, and updates health.
- **Row and event are not the same record** (settled at WP-07, reconciling this section with technical/02's invariant "shadow tasks never produce `integration.action.performed` for mutating actions"). The `integration_actions` row records what the platform *decided*; the event records what the provider was *made to do*. So `ok` → row + `integration.action.performed`; `failed` → row + `integration.action.failed`; `would_have` (shadow) and `replayed` (idempotency hit) → row only, because nothing was sent. The mapping is one exported function, `integrationActionEventDrafts`, which every audit-log adapter must use.
- **Shadow mode is one guard in the executor, not a null adapter** (settled at WP-07 review round 1; this section and technical/10 previously implied both). A `MutatingActionRequest` carries the task's `mode` as a **required** field, and the executor returns `shadowResult()` with a `would_have` row before it touches the rate limiter or the provider. One guard is provable — a single branch, mutation-checked, with the contract suite driving every fake through it — where N null adapters would each have to be written, kept in step with its port and independently proved never to write. It also keeps the audit honest: a null adapter *bypasses* the executor and so records nothing, while the row is exactly what shadow mode is for (product/12's ShadowReport). The type ports have no shadow variant, and `packages/integrations`'s fakes are test doubles: nothing in the product path swaps an adapter for a fake.
- On success the idempotency key is stored **before** the audit row is written: a crash between the two then costs a less precise status (`replayed` instead of `ok`) rather than a second comment on the ticket.
- Rate-limit budgets are per `integrations.id`, not per provider name — two bindings of one provider are two accounts with two quotas — and a provider that knows better passes its own policy at registration.
- Actions are triggered by event handlers in the integration priority band (100–199), so the pipeline never calls providers directly.

## Agent tooling exposure

Providers declare what an agent may use inside a run: a CLI on PATH with an env spec (names of variables the runner injects from run-scoped credentials), a skill (recipes), and optionally an MCP server spec. The spec type has **no field for a value** — only names, and for an MCP server only header names — so a provider that wanted to ship a token would have to change the type, which is the review that should happen (BD-002, BD-025). The runner mounts only the tooling for the stage's tool policy (product/13 table). Mutating ticket/MR actions are exposed to agents only via the platform MCP (`add_ticket_comment`, `open_mr`, `update_mr_description`, `create_followup_ticket`, `ask_human`, `report_progress`, `kb_search`, `get_task_context`) which enforce policy and audit.

## Health and setup

Each binding shows: last inbound event, last outbound success/failure, token expiry (from provider metadata when available), and a generated setup guide (webhook URL + secret, required scopes, Slack manifest). *Test connection* runs a read-only capability probe.
