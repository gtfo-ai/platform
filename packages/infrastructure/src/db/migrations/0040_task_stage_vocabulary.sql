-- 0040 — `task_stages` gets one declared vocabulary and a column naming where a return went (WP-55).
--
-- Two defects of the same table, one change (PROGRESS backlog 32 and 67).
--
-- (1) `state` was never given a vocabulary. 0004 wrote "State, outcome and return reason are
-- free-form until WP-15 fixes the interpreter's vocabulary"; WP-15 merged, 0012 quoted that note as
-- its own premise, and the vocabulary was never fixed — so that sentence is **stale** and this is the
-- file that says so (0004 is applied and never edited). The store wrote `entered`/`exited`, the
-- task-detail DTO published six other words, and `apps/server` mapped between them, answering
-- `pending` for anything it did not recognise and `completed` for a stage the pipeline had
-- *returned*. From here the column holds exactly `taskStageStateSchema`'s six words
-- (`packages/contracts/src/pipeline.ts`): the store parses what it writes, the projection parses
-- what it reads, and the constraint below makes the database refuse a seventh.
--
-- The rewrite of existing rows claims no more than the rows already said:
--   * `entered` with no `exited_at`             → `running`   (what the projection published);
--   * a closed row whose outcome is `returned`   → `returned`;
--   * a closed row whose outcome is `failed`     → `failed`    (the executor's and the lease
--                                                   sweep's escalations write that outcome);
--   * any other closed row                       → `completed`.
-- **The residual, stated rather than hidden:** a gate row a task walked through before this
-- migration was never closed (measured at WP-55 — see PROGRESS `#### WP-55`), so it becomes
-- `running` here exactly as the projection published it before. Its verdict was never stored and
-- this file does not invent one; only rows written after this migration carry a gate's `outcome`.
-- A value outside the vocabulary that is neither `entered` nor `exited` is left alone, and the
-- constraint then refuses the migration naming it — no writer in this repository produced one, and
-- guessing what a hand-written word meant is the silent default this change removes.
--
-- (2) A return's reason was written on the row of the stage the task *left* and read back from the
-- rows of the stage it *entered*, which never name the same stage on any shipped edge — so a
-- returned stage was served its own last complaint, or nothing, instead of the finding it was sent
-- back to fix. The reason stays where it was written (the attempt that produced it, which is what
-- this table is for as an audit); `returned_to` records which stage that return targeted, and the
-- reader asks for *the newest return targeting this stage since its previous attempt*. Null on every
-- row that is not a return, and on every return written before this migration: the target of an
-- old return is not recoverable from the row, and the reader asks only for rows that name one.
alter table task_stages add column returned_to text;

update task_stages
   set state = case
                 when state = 'entered' and exited_at is null then 'running'
                 when outcome = 'returned' then 'returned'
                 when outcome = 'failed' then 'failed'
                 else 'completed'
               end
 where state in ('entered', 'exited');

alter table task_stages
  add constraint task_stages_state_known
  check (state in ('pending', 'running', 'completed', 'returned', 'skipped', 'failed'));

-- A return names a target and a reason; a row that names a target without being a return would be
-- a second meaning on the column, which is the defect (1) records for `state`.
alter table task_stages
  add constraint task_stages_returned_to_is_a_return
  check (returned_to is null or state = 'returned');
