-- 0017 — what the cost ledger needs that `0007_cost.sql` did not have (WP-19).
--
-- Everything the ledger writes to already exists: `cost_entries`, `cost_rollup_daily`, `budgets`,
-- `budget_windows`, `price_list` and `run_model_usage` were created at 0004 and 0007 and have never
-- had a writer. This migration changes three things the first writer needs, and nothing else.
--
-- 1. **`run_model_usage.usd_reported`.** technical/03 gives `runs` the pair `usd_reported
--    numeric(12,6) null, usd_estimated numeric(12,6)` — the provider's invoice number and the price
--    table's computation of the same run — and gives `run_model_usage` only the estimate. The
--    per-model record the SDK reports (`modelUsage[].costUSD`, normalised by
--    `transcript-normaliser.ts`) is a *reported* number, so storing it in a column named
--    `usd_estimated` would make the two indistinguishable from one row. Nullable, because a
--    producer that reported no per-model cost has not reported zero (standing rule 18).
--
-- 2. **`run_model_usage.usd_estimated` becomes nullable, and loses its default.** `not null default
--    0` cannot say "the price table has no row for this model", which is a real and expected state:
--    a model released after the operator's last price update prices at *nothing*, and a zero there
--    is a free run in every sum over the column. `apps/server/src/queries/pipeline-queries.ts` reads
--    the pair the same way it reads `runs`: reported first, estimate second.
--
-- 3. **`cost_entries` gets `(run_id, model, created_at)` unique.** The ledger's idempotency is
--    `handler_executions` — the row and the claim commit together (TD-005) — and this is the second
--    line of defence for the path that does *not* go through the dispatcher: the backfill
--    (`events/replay.ts`) and whatever an operator runs by hand. `created_at` is in the key because
--    the table is range-partitioned on it and PostgreSQL requires the partition key in every unique
--    constraint; the ledger writes `created_at` from the database's own `now()`, so the constraint
--    cannot collapse two genuine charges of one run — it catches a *replay within the same
--    microsecond*, which is exactly what a double-fired backfill is.
--
-- No new table. `budget_windows` already holds the projection, and the rollover needs no row of its
-- own: a window is identified by its start instant, so a cost entry after the boundary folds into a
-- fresh row (`packages/application/src/cost/window.ts` carries the argument).

alter table run_model_usage
  add column usd_reported numeric(12, 6);

alter table run_model_usage
  alter column usd_estimated drop not null,
  alter column usd_estimated drop default;

alter table cost_entries
  add constraint cost_entries_run_model_unique unique (run_id, model, created_at);
