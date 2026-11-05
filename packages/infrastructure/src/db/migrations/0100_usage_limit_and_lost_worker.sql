-- migration-class: additive; raises-rollback-floor
-- 0100 — a usage limit and a lost worker re-offer a stage once (WP-285, WP-286; TD-031 decisions
-- 11–12, BD-032 decisions 6–7).
--
-- **`rate_limited`** joins `run_terminal_reason`: a run a subscription's usage limit ended mid-run.
-- It has been in `packages/contracts` since WP-273 (`CONTRACTS_AHEAD_OF_STORAGE`, now empty), so the
-- build that runs beside this file already parses it — which is what makes the `add value`
-- additive (TD-032 decision 1). Appended, like 0035's `lease_expired` and 0080's `shutdown`:
-- `test/integration/db/enums.integration.test.ts` compares the database's order with the zod enum's.
-- Nothing in this file writes the label, which is what lets it run inside the migrator's
-- transaction.
--
-- **The two counters live on the stage entry** (TD-031 §12): `lost_runs` — runs of this entry the
-- lease sweep ended `lease_expired` — and `usage_limited_runs` — runs that ended `rate_limited`. The
-- first of each re-plans the entry (a new run, a new offer, the worker that lost or was limited
-- added to the carried exclusions); the second escalates. Columns rather than a count over `runs`,
-- because the sweep's ending and `settleRun` decide in the run's terminal transaction and the
-- stranded-stage recovery must tell a re-plan that was owed (`lost_runs = 1`, no successor offer)
-- from an ending that was not — one integer on the row it already reads.
--
-- **`workers.paused_until_estimated`**: a usage limit that named no reset time pauses the worker for
-- `APP_WORKER_USAGE_PAUSE_DEFAULT`, and the Workers screen then says *until about* (TD-031 §11).
--
-- **Additive by TD-032's list**: an enum value already in the contract, and `not null default`
-- columns the previous build never names (its inserts take the defaults); no check constraint, which
-- on an existing table would need `not valid` and a later validation, for counters only ever
-- incremented by one statement each. **It raises the rollback
-- floor** (TD-032 §2) from 3 to 4: a build before this one reads a `rate_limited` run as an
-- ordinary failure and escalates where this build re-plans, and it treats a stage entry whose first
-- run the sweep ended as one to escalate — so a task this build left re-planning, with
-- `lost_runs = 1` and its new offer still to be written, would be escalated by the older build's
-- stranded-stage recovery instead.
alter type run_terminal_reason add value 'rate_limited';

alter table task_stages add column lost_runs integer not null default 0;
alter table task_stages add column usage_limited_runs integer not null default 0;

alter table workers add column paused_until_estimated boolean not null default false;
