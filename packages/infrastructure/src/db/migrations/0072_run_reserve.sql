-- 0072 — the reservation a run was admitted at (WP-131, PROGRESS backlog 402).
--
-- ## `runs.reserve_usd`
--
-- A run nobody measured — both cost columns null: the lease sweep's ending, a cancel ended in place,
-- a stop or a crash that read no `result` (WP-47, WP-101, WP-119) — used to count **0** against every
-- cap once it had ended, and the task cap never counted it at all, so a scope whose runs kept ending
-- unmeasured admitted past its limit by up to one per-run cap per such run. BD-010 puts the
-- predictable worst case at the per-run caps, so the ruling on 402 holds an unmeasured ended run at
-- **the cap it was admitted at**: the figure the admission already reserved for it while it was live.
--
-- The run's **own** cap, not the admitting stage's: an unmeasured 15 USD implementation run held at a
-- 2 USD refinement reserve would hold almost nothing. So the figure has to be on the row, written by
-- both inserts (`RunRepository.insert`, from `runBudgetUsd` and from the ask's `budget_usd`).
--
-- **Nullable, no default.** `null` is *"no reservation was recorded"*: every run written before this
-- migration, and a run admitted at a configured cap of `0` (`usdSchema` admits it, and `> 0` below
-- refuses it — the adapter writes `null` for it). The pending term and the task cap read a `null`
-- at the **admitting** stage's reserve, which is stated where they read it
-- (`packages/infrastructure/src/cost/pending-run-spend.ts`).
--
-- **Held, never spent** (standing rule 16): nothing here writes a ledger row, a rollup or
-- `tasks.cost_actual`. The hold ends when `RunRepository.recordCost` writes the run's figure, or —
-- for a windowed cap — when the window that contains `ended_at` rolls over.

alter table runs add column reserve_usd numeric(12, 6);

-- ## `runs.figure_is_floor` (WP-131 pre-review round, PROGRESS backlog 407)
--
-- A `cost_unreported` stop — a `result` that carried no usable `total_cost_usd` — is written with
-- the runner's **floor** in the cost column (`usd_reported = 0`, or `usd_estimated = 0` in `local`
-- mode), which WP-119 kept knowingly. The floor is not a measurement, and every reader of the row
-- took it for one: the caps counted a measured 0 and the task totals named no exclusion. The cost
-- columns are left exactly as WP-119 writes them; this flag says they hold a floor, and the caps and
-- the totals treat such a row as a run **nobody measured** — held at `reserve_usd`, counted in
-- `unmeasured_runs`. `false` for every other row, including every row written before it: no run
-- before this migration recorded whether its cost was a floor, and the ones that were stay read as
-- measured (stated, not recovered).
alter table runs add column figure_is_floor boolean not null default false;

-- ## `tasks.budget_cap_usd` (WP-131 review round 1, the orchestrator's ruling)
--
-- A task held at its cap waits for a human to raise it — and until this column nothing could: the
-- task cap is `ProjectSettings.taskBudgetUsd`, the constant `DEFAULT_TASK_BUDGET_USD` with no
-- configuration key, no API and no screen, so a task paused on a hold was paused for good (402's
-- rejected option (c)). This is the **per-task override**: `null` is "the default applies" (every
-- task before this migration), a number is the cap a maintainer raised it to through
-- `POST /api/tasks/:id/budget`. Only ever **raised** — the command refuses a figure not above the
-- current effective cap — and never written by `save`: one writer, `TaskRepository.raiseBudgetCap`
-- (`tasks-column-ownership.test.ts` holds it). `> 0`, like every other cap column.
alter table tasks add column budget_cap_usd numeric(12, 6);

alter table tasks add constraint tasks_budget_cap_usd_positive check (budget_cap_usd > 0);

alter table runs add constraint runs_reserve_usd_positive check (reserve_usd > 0);
