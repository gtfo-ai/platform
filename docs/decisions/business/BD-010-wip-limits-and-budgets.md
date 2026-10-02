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
