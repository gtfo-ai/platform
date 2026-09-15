-- 0031 — `runs.mode` for the runs that were recorded before the planner could name them (WP-36).
--
-- PROGRESS backlog **57**: `runModeFor` mapped `runs.mode` from the **template**, and two of
-- technical/04's seven modes belong to *stages* that every ticket template shares — the
-- retrospective (`retro`) and the librarian curation (`librarian`). Every one of those runs was
-- written `normal`, so the column could not answer *"what did delivery cost and what did upkeep
-- cost"*, which is the question a maintenance pipeline makes somebody ask. WP-36 added
-- `RUN_MODE_BY_STAGE` beside `RUN_MODE_BY_TEMPLATE`; this file is the other half of the same
-- commit, because **`runs.mode` is written once and nothing rewrites it** — a fix applied only to
-- the planner leaves every earlier run mislabelled for ever, on a column a screen already renders
-- (`apps/web/src/features/run-detail.tsx` shows it as a badge).
--
-- ## The statements mirror the planner's rule exactly, and that is the whole of their correctness
--
-- The planner asks three questions in one order: `tasks.mode = 'shadow'` wins, then the
-- **template** table, then the **stage** table. So:
--
--   * `mode = 'normal'` is the predicate of both statements — a shadow run stays `shadow`, and a
--     run some later build has already labelled is never relabelled here;
--   * the stage backfill excludes the templates that have an entry of their own, because the
--     template beats the stage (a `review_only` task's run is `review_only` whatever its stage is
--     called). The list is the four ids `RUN_MODE_BY_TEMPLATE` carries.
--
-- A **project-defined** template with a stage called `retrospective` is relabelled too, and that is
-- the rule rather than an accident: the stage table is keyed by stage id for every template that is
-- not in the template table, so the backfill and the planner agree about a template this repository
-- has never seen.
--
-- Idempotent by construction: the second run matches nothing, because the first left no row at
-- `normal` that the rule would move.

update runs r
   set mode = case ts.stage
                when 'retrospective' then 'retro'::run_mode
                else 'librarian'::run_mode
              end
  from task_stages ts, tasks t
 where ts.id = r.task_stage_id
   and t.id = r.task_id
   and r.mode = 'normal'
   and ts.stage in ('retrospective', 'librarian')
   and t.template not in ('review_only', 'ticket_lint', 'history_bootstrap', 'discovery');

-- The template half: WP-21's discovery template, whose runs have been `normal` since WP-21 shipped.
-- The other three template ids were mapped by the work packages that created them, so their rows
-- were already written with the right value and this statement would match none of them.
update runs r
   set mode = 'discovery'::run_mode
  from tasks t
 where t.id = r.task_id
   and r.mode = 'normal'
   and t.template = 'discovery';
