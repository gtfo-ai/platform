-- 0022 — what a task's cost estimate rests on (WP-28, Q71).
--
-- WP-19 gave a task a number: `estimateTaskCostUsd` returns `{usd, basis, samples}` and
-- `CostStore.saveEstimate` stored **two** of the three, writing `tasks.size` and
-- `tasks.estimate_usd` and putting `basis` and `samples` in a debug log line. Nothing downstream
-- could then tell a figure derived from this project's own finished tasks from one derived from the
-- rest of the organisation, or either from a refusal — which is precisely what an approval card has
-- to say when it asks a maintainer to release a spend. Q71's recommendation, implemented: *"add
-- both columns in WP-28's migration so the approval card states what the figure rests on."*
--
-- **Three states, and the third is the one a nullable column is for.**
--
--  * `estimate_basis = 'project_history' | 'org_history'` with `estimate_usd` set — a number, and
--    where it came from.
--  * `estimate_basis = 'unknown'` with `estimate_usd` **null** — the estimator ran and *refused*:
--    the project (and the organisation) has no finished task with a size and a positive cost, so
--    there is nothing to estimate from. Standing rule 16: this is not zero, and the budget gate
--    does not fire on it.
--  * `estimate_basis` null — the estimator has **not run**. A task before refinement completes, and
--    a row written before this migration. It is deliberately not backfilled to `'unknown'`: a task
--    that already carries a number got it from a basis nobody recorded, and writing a word in that
--    column now would be inventing the provenance the column exists to carry (standing rule 86).
--
-- `estimate_samples` is paired with the basis by a check constraint rather than defaulted to zero,
-- for the same reason: "no samples" and "never asked" are different answers, and a `not null
-- default 0` would publish the second as the first.
--
-- **Ownership.** Both columns are written by exactly one statement — `CostStore.saveEstimate`
-- (`packages/infrastructure/src/cost/postgres-cost-store.ts`), which already owns `size` and
-- `estimate_usd` and runs in the `artifact.created` handler beside the `stage.execute` job's
-- transactions. `tasks-column-ownership.test.ts` reads that off disk; a whole-row `tasks.save`
-- that named either of these would be the lost update PROGRESS backlog 18 records.
--
-- No enum type: `approval_kind` and its siblings in 0002 are vocabularies the pipeline branches on
-- across many tables, and this one is read by one projection and one renderer. A check constraint
-- keeps the same three values without adding a type whose `alter type … add value` cannot run in a
-- transaction — which this migration runner holds every file in.
alter table tasks add column estimate_basis text;
alter table tasks add column estimate_samples integer;

alter table tasks
  add constraint tasks_estimate_basis_known
  check (estimate_basis is null or estimate_basis in ('project_history', 'org_history', 'unknown'));

-- "How many tasks the number rests on" only means anything once a basis has been recorded, and a
-- sample count without one would be a number with no statement attached.
alter table tasks
  add constraint tasks_estimate_samples_paired
  check ((estimate_basis is null) = (estimate_samples is null));

-- A non-negative count, because the only thing it counts is rows.
alter table tasks
  add constraint tasks_estimate_samples_nonnegative
  check (estimate_samples is null or estimate_samples >= 0);
