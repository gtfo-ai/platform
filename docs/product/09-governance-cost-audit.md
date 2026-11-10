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

- Thresholds: notify at 50% and 80% (configurable), block a new run that could take the window past 100% (*as built at WP-131*: the run's own per-run cap counts toward the window before it is admitted).
- *Amended 2026-11-10 (BD-010).* **The task cap admits a run when spent + held + the stage's run reserve ≤ cap.** A pause says that arithmetic — spent, held, the stage's reserve, the cap and the cap it needs — and never says *spent its cap* unless it has. A raise below the needed cap is refused with the minimum named; a resume of a stage attempt that ran nothing reuses it; on a return the merge request goes back to draft only once the implementation run is admitted.
- Windows are in the organisation timezone (setting, default from the container `TZ`, fallback UTC), reset at boundary.
- **Never kill a run mid-flight for an organisation/project budget** — that wastes the spend already made. Only per-run caps stop a run, and those are known upfront.
- Budget changes are audited (who, when, from → to).
- Forecast: the dashboard shows projected month-end spend from the trailing 7-day average.
- **Estimate before spend:** each task gets a cost estimate at refinement (size × project history); an optional per-project threshold routes expensive tasks to budget approval by a maintainer before Implementation. Estimate accuracy is tracked.
  *Amended 2026-11-10 (BD-010, S-28.16).* An estimate asks for approval only when it rests on at least **3** finished tasks; with fewer it is shown as a *rough estimate from n finished task(s)* and the task cap bounds the spend. **Approving an estimate above the task's cap raises that task's cap to the estimate**, and the card says so first (*Approving raises this task's cap from $50.00 to $123.66*). The card never reads as money spent: it says what was spent so far, that this is an estimate before the expensive stages, and what it rests on. Approvals waiting on fewer than 3 tasks when this shipped were settled by the platform as no longer required.
- **Separate budgets** for shadow mode and the maintenance pipeline so experiments never eat delivery budget.
- **Human time accounting:** human minutes derived from events (review start → merge, question → answer, approvals) are shown next to token cost as *total cost of delivery*; per-user breakdown is off by default.

## Concurrency limits (WIP)

Per project: `max_parallel_tasks` (default 2), `max_tasks_in_pipeline` (default 5, i.e. including waiting ones), `max_parallel_runs` per organisation (default 4, protects against rate limits). Tasks beyond limits wait in `Queued` ordered by ticket priority then age. Limits exist to keep review load humane, not only to protect spend.

*Amended 2026-11-10 (BD-010).* **A limit per owner:** `pipeline.wip.max_tasks_per_owner` (default 3; the organisation's value is a maximum a project may tighten; a per-person override) counts a person's owned tasks that are active, returned, waiting for answers or waiting for approval. `max_tasks_in_pipeline` no longer counts paused or *Needs human* tasks. Unowned tasks are bound by the project limit only. A person's own pick, resume or hand-back is never refused; the scheduler skips a full owner and starts the next task. A ready machine that runs nothing always says why.

## Audit

Everything below is immutable, append-only, and exportable:

- **Run record:** rendered system prompt and user prompt (exact text sent), model, effort, permission mode, allowed tools, MCP servers/skills loaded, settings snapshot (effective config hash + full copy, with secrets redacted; a copy over 256 KiB is kept as its hash and size only), knowledge context pack (which KB documents were included and why), start/end, exit reason, cost, and the **full transcript** (every message/tool call/result as streamed).
- **Task record:** every state transition with cause (event id), every artifact version, every question and answer (with author), every return with reason, every human action (pause, retry, approve, cancel, budget raise).
- **Configuration audit:** every change to settings, integrations (secret values redacted, only "changed"), pipelines, prompts, budgets — who/when/diff.
- **Knowledge audit:** every KB change with provenance (task/run/human) — the KB lives in git, so git history is part of the audit.
- **Integration audit:** every outbound action (ticket transition, comment, MR update, Slack message) with payload and result; every inbound event.

Retention: configurable per organisation; **default is to keep everything forever** (Q13). Operators may set a purge window for raw transcripts; summaries, costs, artifacts and events are always kept. Export as JSON per task: the task record, its run records (with their settings hash), its audit rows and its events, the last two capped at 1 000 each — the audit rows only for a caller who may read the task's audit (`org.audit.read`, maintainer), so the export is never a way around a narrower read, and a member's export says it carries none (Q112 (a)); transcripts, prompts, settings snapshots and artifact bodies are their own downloads, which the export names (*as built at WP-112*).

## Safety rails (product-level; technical enforcement in Round 2)

- Agents get **least-privilege tools per stage** (read-only stages cannot write files or call mutating integration actions).
- Agents never see integration secrets; tools are pre-authenticated.
- Destructive git operations (force push to protected branches, branch deletion outside `agentic/*`, history rewrite) are blocked by policy.
- Outbound network from agent workspaces is allow-listed per project (package registries, the git host, configured integrations).
- A **kill switch** per project and global ("stop all agents") is one click and one env var.
- The **autonomy dial** (product/18, BD-027) is the single control that summarises how much the platform may do without a human; every level's effective policies are listed next to it.
