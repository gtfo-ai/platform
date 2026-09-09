# 09 — Governance: cost, budgets, audit

Decisions: [BD-011 cost accounting](../decisions/business/BD-011-cost-accounting.md), [BD-010 limits and budgets](../decisions/business/BD-010-wip-limits-and-budgets.md), [BD-003 audit everything](../decisions/business/BD-003-auditability.md).

## Cost model

- **Unit of cost is the Run.** Every run records: model, effort, input tokens, output tokens, cache-write tokens, cache-read tokens, per-model breakdown when sub-agents are used, provider-reported cost in USD, wall time, turns.
- **Roll-ups:** run → stage (sum of its runs) → task → project → organisation, by day/week/month. Stored as materialised aggregates so the dashboard is instant.
- **Source of truth for USD:** the provider's reported cost (the SDK result message). We also keep our own price table (model → price per MTok, effective date) to (a) estimate cost live while a run streams, (b) reprice when the operator uses a subscription or gateway that reports no cost, (c) show "what would this cost on API pricing" in subscription mode.
- **Subscription mode:** no invoice cost; we still show *token* usage and *API-equivalent* cost, clearly labelled "estimated". Budgets in subscription mode apply to the estimated cost (so behaviour is identical).
- **Non-token costs** (CI minutes, hosted MCP calls) are out of scope for v1; the model allows adding `cost_items` of other kinds later.

## Budgets

| Scope | Windows | Behaviour when reached |
|---|---|---|
| Organisation (global) | daily, weekly, monthly | no new runs anywhere; running runs finish |
| Project | daily, weekly, monthly | no new runs for that project |
| Task | total cap (default $50, per template) | task → `Paused: budget`, human can raise |
| Stage run | per-run cap (see stage defaults) | run stops via SDK budget limit; stage is retried once with a summary of progress if the cap was hit mid-work, otherwise escalate |

- Thresholds: notify at 50% and 80% (configurable), block at 100%.
- Windows are in the organisation timezone (setting, default from the container `TZ`, fallback UTC), reset at boundary.
- **Never kill a run mid-flight for an organisation/project budget** — that wastes the spend already made. Only per-run caps stop a run, and those are known upfront.
- Budget changes are audited (who, when, from → to).
- Forecast: the dashboard shows projected month-end spend from the trailing 7-day average.

## Concurrency limits (WIP)

Per project: `max_parallel_tasks` (default 2), `max_tasks_in_pipeline` (default 5, i.e. including waiting ones), `max_parallel_runs` per organisation (default 4, protects against rate limits). Tasks beyond limits wait in `Queued` ordered by ticket priority then age. Limits exist to keep review load humane, not only to protect spend.

## Audit

Everything below is immutable, append-only, and exportable:

- **Run record:** rendered system prompt and user prompt (exact text sent), model, effort, permission mode, allowed tools, MCP servers/skills loaded, settings snapshot (effective config hash + full copy), knowledge context pack (which KB documents were included and why), start/end, exit reason, cost, and the **full transcript** (every message/tool call/result as streamed).
- **Task record:** every state transition with cause (event id), every artifact version, every question and answer (with author), every return with reason, every human action (pause, retry, approve, cancel, budget raise).
- **Configuration audit:** every change to settings, integrations (secret values redacted, only "changed"), pipelines, prompts, budgets — who/when/diff.
- **Knowledge audit:** every KB change with provenance (task/run/human) — the KB lives in git, so git history is part of the audit.
- **Integration audit:** every outbound action (ticket transition, comment, MR update, Slack message) with payload and result; every inbound event.

Retention: configurable per organisation; **default is to keep everything forever** (Q13). Operators may set a purge window for raw transcripts; summaries, costs, artifacts and events are always kept. Export as JSON per task.

## Safety rails (product-level; technical enforcement in Round 2)

- Agents get **least-privilege tools per stage** (read-only stages cannot write files or call mutating integration actions).
- Agents never see integration secrets; tools are pre-authenticated.
- Destructive git operations (force push to protected branches, branch deletion outside `agentic/*`, history rewrite) are blocked by policy.
- Outbound network from agent workspaces is allow-listed per project (package registries, the git host, configured integrations).
- A **kill switch** per project and global ("stop all agents") is one click and one env var.
