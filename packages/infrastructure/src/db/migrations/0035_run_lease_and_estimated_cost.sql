-- 0035 — what a dead run's money needs (WP-47; PROGRESS backlog 109, 50, 110, 75; Q70 (b)).
--
-- Four changes, one subject: a run whose process vanished stays `running` for ever, holds its
-- stage's per-run budget in every future window, and the only lever an operator has — cancel —
-- loses whatever it had burned. Nothing here is new schema for a new feature; three of the four
-- give a column that has existed since 0004 either a writer or an honest absent value.
--
-- ## 1. `run_terminal_reason` gains `lease_expired`
--
-- The sweep ends a run **no process is renewing the lease of**, and that is the *only* thing a
-- missing heartbeat licenses it to say. `crash` would claim the session died and `cancelled` would
-- claim a human stopped it; both are claims about the model, and the session may well still be
-- running in a process that lost its database connection. So the reason is named, and the name is
-- what tells an operator reading the run screen what actually happened.
--
-- `alter type … add value` may run inside a transaction block (PostgreSQL 12+), which is what this
-- migrator does, as long as the new label is not *used* in the same transaction — nothing here
-- writes a row. The value is **appended**, because a bare `add value` appends and
-- `test/integration/db/enums.integration.test.ts` compares the database's order with the zod
-- enum's.
--
-- ## 2. `runs.usd_estimated` becomes nullable and loses its default
--
-- Exactly the change migration 0017 made to `run_model_usage.usd_estimated`, one table across and
-- for the same reason: `not null default 0` cannot tell *"nobody wrote a figure"* from *"it cost
-- zero"*, and a zero in a cost column reads as a free run (standing rule 16). Until WP-47 the
-- column had **no writer at all**, so every one of the values in it is the default — which is why
-- the backfill below is honest rather than destructive: it replaces a 0 that means "nobody wrote
-- this" with the `null` that says so.
--
-- `RunRepository.finish` now writes it (`usd_estimated = cost.usd` when `is_estimate` is set,
-- `usd_reported = cost.usd` when it is not, and the other one `null`), so the pending term can be
-- `coalesce(usd_reported, usd_estimated, 0)` and a BD-004 `local`-mode run — where **every** run's
-- cost is an estimate — stops committing nothing to every cap and stops reading as free on
-- `GET /api/runs/:id`.
--
-- ## 3. `cost_entries.late`
--
-- A cancelled or lease-expired run's spend reaches the ledger from the process that *ran* it,
-- after the row was already terminal (Q70 (b)). That row is a **late report** and is labelled as
-- one rather than merged into the original: an operator reconciling an invoice has to be able to
-- tell a charge the ledger made when the run ended from one it made afterwards, because the two
-- answer different questions about the same money. `false` is right for every row already written
-- — all of them were made by the handler on the run's own terminal event.
--
-- ## 4. `tasks.cost_estimated` is dropped
--
-- `not null default 0` since 0004, published on the task DTO as `cost_estimated_usd`, and written
-- by nothing — so every task the product has ever shown reported `$0.00` of estimated spend
-- (backlog 75). The replacement is a **projection** over `cost_entries where is_estimate`, which
-- has carried the per-row flag since WP-19: no fourth running total to keep in step, no backfill
-- for tasks that already exist, and no new writer to add to the `tasks` column partition
-- (`tasks-column-ownership.test.ts`). technical/03 is amended in the same change.
--
-- ## No index for the sweep, stated rather than omitted
--
-- The sweep reads live runs — `runs_active_idx on runs (status) where status in ('created',
-- 'starting','running')` already covers exactly that set, and the set is bounded by BD-010's
-- `max_parallel_runs` rather than by the size of the table. A second partial index on
-- `lease_expires_at` would be maintained on every heartbeat write to save a filter over a handful
-- of rows.

alter type run_terminal_reason add value 'lease_expired';

alter table runs
  alter column usd_estimated drop not null,
  alter column usd_estimated drop default;

-- Every value in this column was written by the default; `null` is what "nobody priced this run"
-- has always meant here, and it is what the pending term and the run projection now read.
update runs set usd_estimated = null where usd_estimated = 0;

alter table cost_entries
  add column late boolean not null default false;

alter table tasks
  drop column cost_estimated;
