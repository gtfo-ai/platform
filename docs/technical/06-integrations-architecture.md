# 06 — Integrations architecture

> Round 2 design. Sources: product/08, BD-017, BD-022, BD-023, BD-025, research/03. Provider-specific library choices are recorded in TD records once research/05 lands.

## Type contracts (ports in the application ring)

Each integration **type** is a TypeScript/Python interface pair: an *outbound port* (actions the platform calls) and an *inbound normaliser* (provider payload → domain events with verified actor identity). Providers implement both. The pipeline, UI and knowledge base depend only on the ports.

### TaskManagement
```
readTicket(ref) -> Ticket {key, url, type, title, description, comments[], labels, priority, links[{type, key, state}], epic?: {key, title, description}, siblings?: [{key, title, state}], attachmentsText[]}
matchTickets(rule) -> TicketRef[]                   # polling fallback
transition(ref, targetStatusName, fields?) -> void   # resolves the transition at runtime; fails loudly if none
upsertWorkpad(ref, markerId, markdown) -> CommentRef # edit in place (BD-023)
addComment(ref, markdown) -> CommentRef              # questions, linter output
setLabels(ref, add[], remove[])
linkMergeRequest(ref, mrUrl)
createTicket(draft) -> TicketRef                     # scope-creep valve, epic split, maintenance chores
resolveIdentity(providerUserId|email) -> UserIdentity
webhookVerify(headers, body) -> bool
normalizeEvent(payload) -> DomainEvent[]             # ticket.matched|comment.added|status.changed
capabilities() -> {webhooks, epics, links, customFields, adf}
```
Markdown → provider format converter (ADF for Jira Cloud, wiki markup for DC) lives in the provider module.

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
webhookVerify ; normalizeEvent -> mr.* | ci.pipeline.finished | default_branch.moved
capabilities() -> {projectTokens, groupTokens, codeowners, coverageArtifacts, draftPipelines}
```
Git operations (clone, branch, commit, rebase, push) are performed by the workspace manager with `git` and a credential helper, never by the agent with a raw token (BD-025).

### Communication
```
postTaskThread(project, task, markdown) -> ThreadRef
postQuestion(thread, question) -> MessageRef          # Block Kit buttons + "reply in thread"
postApproval(thread, approval) -> MessageRef
updateMessage(ref, markdown|blocks)
postDigest(channel, items[])
normalizeEvent -> question.answered | approval.decided | feedback.received (with resolved identity)
```

### ObservabilityErrors
```
getIssue(ref) ; getLatestEvent(ref) -> {stackTrace, breadcrumbs, tags, release, firstSeen, lastSeen, count}
searchIssues(project, query, since)
linkMergeRequest(issue, mrUrl) ; comment(issue, text) ; resolve(issue, inRelease?)
agentTooling() -> {mcp?: McpServerSpec, cli?: CliSpec, skill: SkillRef, env: EnvSpec}
```

### ObservabilityLogs
```
queryRange(selector, from, to, limit, filter?) -> Lines[]
labels(name?) ; series(selector, since)
agentTooling() -> {cli: logcli spec, skill, env}
```

### Provider module layout
```
integrations/
  <type>/port.ts            # interface + event types + capability flags
  <type>/fake.ts            # in-memory fake used by contract tests and shadow mode
  <type>/contract.test.ts   # runs against every provider with recorded fixtures
  providers/jira-cloud/     # index.ts (registration), client.ts (thin REST), adf.ts, webhook.ts, setup-guide.md, config.schema.json
  providers/gitlab/
  providers/slack/
  providers/sentry/
  providers/loki/
  registry.ts               # providers register {type, id, configSchema, secretFields, capabilities, agentTooling}
```
Adding GitHub = `providers/github/` implementing GitProvider + fixtures + setup guide (BD-017).

## Inbound: webhooks and polling

- One HTTP endpoint per provider (`/webhooks/<provider>/<integrationId>`), verifies signature (`X-Hub-Signature`, `X-Gitlab-Token`, `Sentry-Hook-Signature`, Slack signing secret when not in Socket Mode), stores the raw payload (audit), computes a **dedup key** (Jira `X-Atlassian-Webhook-Identifier`; GitLab event + object id + `updated_at`; Sentry hook id), and enqueues normalisation as a job. Response is 2xx within milliseconds; all work is asynchronous.
- **Polling fallback** per binding when no public URL (`APP_WEBHOOK_PUBLIC_URL` unset) or as a safety net: Jira `search/jql` with `updated >= -Nm`, GitLab MR/pipeline listing since last cursor; same normaliser; dedup makes both paths safe together.
- **Slack** uses Socket Mode (research/03): a long-lived connection in the API process (or a dedicated `slack` process when scaling), emitting the same domain events.
- Actor identity: every normalised event carries `{provider, providerUserId, email?, displayName}` resolved to a platform user when possible; unresolved identities are stored as `unmapped` (BD-022).

## Outbound: actions

- Every action call goes through an `IntegrationActionExecutor` that: checks shadow mode (mutating actions are no-ops recorded as `would_have`), applies rate-limit/backoff per provider (429 + `Retry-After`), enforces idempotency (marker ids for comments, "only transition if not already there"), records `integration.action.performed|failed` with redacted payload, and updates health.
- Actions are triggered by event handlers in the integration priority band (100–199), so the pipeline never calls providers directly.

## Agent tooling exposure

Providers declare what an agent may use inside a run: a CLI on PATH with an env spec (names of variables the runner injects from run-scoped credentials), a skill (recipes), and optionally an MCP server spec. The runner mounts only the tooling for the stage's tool policy (product/13 table). Mutating ticket/MR actions are exposed to agents only via the platform MCP (`add_ticket_comment`, `open_mr`, `update_mr_description`, `create_followup_ticket`, `ask_human`, `report_progress`, `kb_search`, `get_task_context`) which enforce policy and audit.

## Health and setup

Each binding shows: last inbound event, last outbound success/failure, token expiry (from provider metadata when available), and a generated setup guide (webhook URL + secret, required scopes, Slack manifest). *Test connection* runs a read-only capability probe.
