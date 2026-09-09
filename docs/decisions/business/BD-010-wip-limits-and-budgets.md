# BD-010 — WIP limits per project; budgets at org/project/task/run with pause-not-kill

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** product/09

## Decision
Projects define `max_parallel_tasks` (default 2) and `max_tasks_in_pipeline` (default 5); the organisation defines `max_parallel_runs` (default 4). Budgets exist at organisation and project scope (daily/weekly/monthly), task scope (total cap) and run scope (per-run cap). Reaching an org/project budget prevents *new* runs; running runs finish. Per-run caps stop the run through the SDK budget mechanism. Notifications at 50%/80%/100%.

## Rationale
Spending already made should not be wasted by killing a run; predictable worst case comes from per-run caps which are known upfront. WIP limits protect reviewers as much as budgets.

## Consequences
- Queue ordering by ticket priority then age.
- Budget windows use an organisation timezone setting, defaulting to the container's `TZ` and falling back to UTC (Q12).
