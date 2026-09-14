-- 0027 — the coverage the project's CI reported for a task, against its default branch (WP-39).
--
-- product/18:38 is one line — *"Test coverage change of the MR shown in Checks when the project's CI
-- reports coverage"*, default *"on when available"* — and until this migration the platform had the
-- head number on three schemas (`MergeRequest.coverage_pct`, `PipelineStatus.coverage_pct` and the
-- `ci.pipeline.finished` payload) and **nowhere to keep the second one**. A delta is head minus a
-- base, and a grep for `coverage` over this directory returned nothing at all: no table, no column,
-- no rollup. So the work was never an integration — both reads have existed since WP-09 — it was
-- deciding what the base *is*, storing it, and saying how stale it may be.
--
-- **What the column holds** (`taskCoverageSchema`, parsed before every write for the reason
-- `workpad_ref` is — a `jsonb` column accepts any document and the disagreement surfaces at the
-- reader, WP-15h):
--
--   {"head_sha": …, "head_pct": 81.5 | null,
--    "base_branch": "main" | null, "base_sha": … | null, "base_pct": 79 | null,
--    "delta_pct": 2.5 | null, "measured_at": "…"}
--
-- Every number is **null rather than zero when it is missing** (standing rule 16): `+0.0` on a
-- merge-readiness panel reads as *"the agent added no coverage"*, which is the one wrong sentence
-- this feature must not print. `null` on the whole column is a third answer again — no pipeline has
-- finished on this task's merge request yet, or the project's `policies.coverage_source` is
-- `'none'` — and the Checks panel prints a different line for it.
--
-- **Why a column on `tasks` rather than a table.** One row per task, written whole, read by exactly
-- one screen. A `task_coverage` table would buy history — every pipeline's number rather than the
-- last one — and product/18 asks for *"the coverage change of the MR"*, singular; the history that
-- would be worth keeping is the project's coverage over time, which is a statistics row (WP-41) and
-- would be keyed by commit rather than by task. One nullable column, one narrow writer, one reader.
--
-- **Ownership.** One writer, `TaskRepository.saveCoverage`, narrow for the reason every narrow
-- writer here is (standing rule 79): it runs in the `pipeline.outbound` job beside the stage
-- executor's transactions, so a whole-row `save` from there would put back the state, the stage and
-- the cost as they were when the job started — measured at 0.40 USD of a task's recorded spend in
-- WP-15d. It does not bump `tasks.version`: `save` does not name this column, so a token bump here
-- would refuse an in-flight aggregate write that never touched it.

alter table tasks add column coverage jsonb;

comment on column tasks.coverage is
  'What the CI reported for this task''s head revision and for the default branch it will merge into (WP-39, product/18:38), with the delta in percentage points. Null means nothing has been measured: no pipeline has finished on the merge request, or policies.coverage_source is none. A number inside is never zero-for-missing — see taskCoverageSchema.';
