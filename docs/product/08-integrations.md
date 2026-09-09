# 08 — Integrations

Decision: [BD-017 pluggable by type](../decisions/business/BD-017-pluggable-integrations-by-type.md). Evidence: [research/03](../research/03-integration-tooling.md).

## Integration types and contracts

| Type | Responsibilities (contract) | Events emitted | Actions | Agent tooling exposed |
|---|---|---|---|---|
| **Task management** | Pick-up rules (label / status / epic / query), read ticket (title, description, comments, attachments text, links, type, priority), map pipeline states to statuses, post comments, ask/answer questions, set labels/fields, link MR | `ticket.matched`, `ticket.updated`, `ticket.comment.added`, `ticket.status.changed` | `transition`, `comment`, `label`, `link`, `assign` | read ticket, add comment (via platform tool, not raw credentials) |
| **Git provider** | Clone/push with a bot identity, branches, open/update MR (draft/ready), MR discussions, reviewers, CI status and job logs, diff stats, merge/close events | `mr.opened`, `mr.updated`, `mr.review.comment`, `mr.approved`, `mr.merged`, `mr.closed`, `ci.pipeline.finished` | `open_mr`, `update_mr`, `comment`, `resolve_thread`, `set_reviewers`, `get_ci_logs` | CLI (`glab`/`gh`) with a project-scoped token in a skill |
| **Communication** | Notify (task picked up, question, ready for merge, escalation, budget), threaded Q&A with buttons and free text, daily digest | `message.reply`, `action.clicked` | `post`, `post_question`, `update`, `digest` | none directly; `ask_human` / `notify_human` platform tools |
| **Observability — errors** | Fetch issue, latest event (stack trace, breadcrumbs, tags, release), search issues, link MR, resolve/comment on completion; optionally create tasks from alerts | `error.issue.created` (optional) | `get_issue`, `get_latest_event`, `search`, `link`, `resolve` | `sentry-mcp` (SaaS) or thin CLI script |
| **Observability — logs** | Query logs by time window/labels/ids, label discovery, aggregate before raw lines; pre-fetch excerpt for bug tasks | — | `query_range`, `labels` | `logcli` + skill of recipes |
| *(future)* **Knowledge sources** | Confluence/Notion/Google Docs import during onboarding | — | `fetch_page` | none |
| *(future)* **CI** (separate from Git provider if needed) | External CI systems | `ci.pipeline.finished` | `rerun` | — |

Every provider declares: `type`, `config_schema` (with secret fields marked), `capabilities` (subset of the type's optional features), `health_check`, `webhook_verify` (signature), `event_normalize` (provider payload → platform event with verified actor identity — BD-022), `actions`, `agent_tooling` (which CLI/MCP/skill to mount and what env it needs), and `docs` (setup guide rendered in the UI).

## Two audiences, two access paths (research/03 pattern)

- **The platform** performs deterministic, auditable actions (transitions, comments, MR updates, notifications) through typed thin clients against REST APIs and receives webhooks. No LLM in that path. The platform holds the high-privilege credentials.
- **The agent** explores through CLIs and skills (`glab`, `acli`/`jira`, `logcli`) and at most one third-party MCP (`sentry-mcp`), plus a platform-owned MCP with `ask_human`, `notify_human`, `report_progress`, `get_task_context`, `kb_search`, `add_ticket_comment`. Agents hold read-mostly, project-scoped credentials injected as environment variables for the run only, never printed.

## Providers for v1

### Jira (Task management)
- Pick-up rules per project: label (default `agentic`), status (mapped "Ready for agent"), epic membership, or JQL; ticket type → template mapping (Bug → `bug`, Task/Story → `feature`, configurable); priority ordering for the queue.
- Inbound: Jira admin webhook with secret (or a per-project Automation rule "Send web request" when the operator has no site-admin) and a JQL poll fallback (every 60 s, configurable) so the platform works without a public URL.
- Outbound via REST v3 (Cloud) / v2 (Data Center): transitions resolved at runtime by target status name with required fields supported; ADF comments generated from markdown; labels for state hints (`agentic:refinement`, `agentic:needs-human`) optional; custom-field alternative for admins.
- Status mapping per project and template, e.g. `Refinement → "In Refinement"`, `Waiting for answers → "Waiting for input"`, `Implementation… → "In Progress"`, `Ready for merge → "In Review"`, `Done → "Done"`. Unmapped stages leave the status unchanged.
- The platform maintains one **workpad** comment per ticket (BD-023); questions are posted as separate numbered comments so they notify; answers = a reply by a mapped user (or Slack/UI).
- Agent tooling: `acli` (Cloud) or `jira-cli` (DC) behind a skill with 5–6 recipes; read-only scope plus comment.

### GitLab (Git provider)
- Bot identity: dedicated bot user ("Agentic Bot") + PAT on gitlab.com Free; project/group access token on Premium and on self-managed (both gitlab.com and self-managed GitLab are MVP targets — the dogfood projects use one of each, Q17). Every MR and comment carries a footer with the task link and "Requested by <human>" (Q18). Branch namespace `agentic/*`; MR opened as draft immediately; description template; labels; reviewers from project config; `remove_source_branch`.
- Webhooks: MR (open/update/approved/merge/close), Note (comments), Pipeline (terminal statuses) with secret token; verified actor identity.
- CI gate uses pipeline events and job logs (trimmed to failing jobs).
- Findings from Code review are posted as MR discussion threads; resolved threads on re-review.
- Agent tooling: `glab` with `GITLAB_TOKEN`/`GITLAB_HOST` in a skill; `git` with token-based push limited to `agentic/*`.
- GitHub is the second provider on the same contract (`gh`, PR ⇄ MR mapping) — designed now, implemented later.

### Slack (Communication)
- Bolt app in Socket Mode (no public URL; internal app so the 2025 rate-limit changes do not apply). One channel per project (configurable) + one thread per task.
- Messages: picked up, question (Block Kit buttons for choices + "reply in thread"), plan approval request (Approve / Request changes buttons), ready for merge (summary, MR link, cost, iterations), escalation, budget thresholds, daily digest.
- Answers/approvals from Slack are attributed to the Slack user mapped to a platform user (mapping by email). Unmapped users cannot answer or approve (Q10).
- Agent has no Slack credentials; `ask_human` goes through the platform.

### Sentry (Observability — errors)
- Internal Integration token for the platform (`event:read`, `project:read`, `org:read`, `event:write` for resolve/comment); webhooks optional (issue created → create ticket → pipeline) as a later feature.
- Bug tasks: the platform pre-fetches the linked issue's latest event (stack trace, breadcrumbs, release, frequency, first/last seen) into the Investigation context.
- Agent tooling: `sentry-mcp` (hosted with static bearer header, or stdio) on SaaS; thin REST script on self-hosted.
- On merge: comment on the Sentry issue with the MR link; optional resolve-in-next-release.

### Loki (Observability — logs)
- Config: base URL, auth mode (none / basic / bearer / Grafana Cloud access policy), tenant id, default label selectors per project/environment, max time window and line limit for agents.
- Bug tasks: optional pre-fetch of a small excerpt around the Sentry event timestamp filtered by request/trace id.
- Agent tooling: `logcli` with env auth and a skill with LogQL recipes (labels → series → narrow range → aggregate → raw lines). `mcp-grafana` only when Loki is reachable only via Grafana.

## Cross-cutting rules

- **Setup UX:** each provider renders a form from its config schema, has *Test connection*, shows required scopes and a copy-paste setup guide (Jira webhook JQL, GitLab webhook URL + secret, Slack manifest, Sentry integration scopes).
- **Health:** last event received, last action succeeded, token expiry warnings (GitLab tokens ≤ 400 days, Jira API tokens, Claude OAuth tokens).
- **Idempotency:** every inbound event has a dedup key (Jira webhook identifier, GitLab event + object id + updated_at); every outbound action is idempotent (comment with marker, transition only if not already in status).
- **Rate limits:** back off on 429 with `Retry-After`; per-provider concurrency caps.
- **Audit:** every inbound event and outbound action stored (product/09).
- **No public URL required** for a working v1: Slack Socket Mode + Jira/GitLab polling fallbacks; webhooks are the recommended, lower-latency option.
- **Adding a provider** = one module implementing the type contract + contract tests + a setup guide. Nothing else changes (BD-017).
