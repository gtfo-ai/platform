# BD-010 — WIP limits per project; budgets at org/project/task/run with pause-not-kill

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/09

## Decision
Projects define `max_parallel_tasks` (default 2) and `max_tasks_in_pipeline` (default 5); the organisation defines `max_parallel_runs` (default 4). Budgets exist at organisation and project scope (daily/weekly/monthly), task scope (total cap) and run scope (per-run cap). An org/project budget admits a new run only if the window's spend, what its live runs have committed and what its unmeasured runs are held at, plus the new run's own per-run cap, stay within the limit; running runs finish. *Amended at WP-131 (session 11, backlog 406): it read "Reaching an org/project budget prevents new runs", which let one admitted run overshoot the window by its own reservation; technical/10's "budgets never overspent" is the reading kept.* Per-run caps stop the run through the SDK budget mechanism. Notifications at 50%/80%/100%.

## Rationale
Spending already made should not be wasted by killing a run; predictable worst case comes from per-run caps which are known upfront. WIP limits protect reviewers as much as budgets.

## Consequences
- Queue ordering by ticket priority then age.
- Budget windows use an organisation timezone setting, defaulting to the container's `TZ` and falling back to UTC (Q12).

## Amendment (2026-10-05, product owner — first local test on Autix, PROGRESS backlog 466)
*"When a run delivers a valid artifact in the same turn that crosses its cap, the platform keeps that artifact; the overrun is still recorded and counted."* A per-run cap still stops the run, and the money is counted exactly as for any other ending: the run row, `run.finished`, the cost ledger and the task's spend all carry the reported figure. What changes is the artifact. Before this amendment, an architect run that handed its plan to the CLI's `StructuredOutput` tool in the turn that took it past $5 lost the plan, and the task paused. Now the run ends `completed` with the terminal reason `error_max_budget_usd`. That pairing records the overrun. The stage completes, and the task cap is still checked when the next run is admitted. The artifact is kept only when the CLI accepted the tool call and the platform's own validation also accepts it. Nothing is kept from any ending other than a budget stop: `cost_unreported`, a crash, a timeout, a stall, a cancel and a hand-back all keep their current endings. technical/04 § "Budgets and limits" has the mechanism.

## Amendment (2026-10-06, M9 architect pass — first local test on Autix, PROGRESS backlogs 410 and 489)
*What its unmeasured runs are held at* applies to a run that **may have reached the model**, not to every run without a figure. A run the platform can prove never started its CLI — the process holding it records, in its own committed transaction, that it is about to ask the shim to start the CLI, and a run with no such record cannot have sent a model request — is a **measured zero**, exactly as a start failure already is, and holds nothing against any cap. Every run that did reach that point and ended without a figure stays held at its reservation, as before (WP-131's ruling is unchanged for it), and every run that ended before the record existed is treated as having reached it. Built at WP-150. Evidence: AUT-6820's developer run was refused by its shim before the CLI started (a protocol mismatch read as `auth_failed`), was recorded as a `crash` with no figure and was then held at the implementation cap of 40 USD against the task cap, for money that could not have been spent.
