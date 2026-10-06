-- 0086 — `task_stages.attached_feedback`: a gate's last failure, kept through a person's return
-- (WP-152, PROGRESS backlog 491, technical/02's 2026-10-06 (M9) amendment).
--
-- When a gate's bounded loop is spent — `ci_fix` on a red pipeline — the gate attempt's row is closed
-- `returned` with the failure as its `return_reason`: on a CI gate, the failing jobs' log excerpts,
-- redacted and bounded when the gate stored them (WP-81, backlog 485). The task then waits in
-- `needs_human`. A person's `return-to-stage` or `rework` out of that escalation closes the **same**
-- row — the same `(task, stage, attempt)` — and wrote their note over `return_reason`, so the logs
-- were lost before anyone could ask for them, and the next Developer run was handed the person's
-- words alone (AUT-6820, measured at `068a0cfb`).
--
-- The command now moves the row's `return_reason` (and its cut length) here, in its own transaction,
-- just before the return writes the person's note: `TaskRepository.attachReturnReason`, which moves
-- only a row closed `returned` that holds a non-empty reason. **The move is unconditional** (WP-152
-- ruling (a)): the excerpt is kept whatever the person chose. What they chose — *Attach the gate's
-- last failure*, ticked by default — is `attached_feedback_sent`: `true` hands the next run both the
-- note and the excerpt, as two `return_feedback` data blocks with platform-written `source`
-- attributes; `false` keeps the excerpt on the row and hands the run the note alone.
-- `lastReturnReason` reads all three.
--
-- **The text nullable, no default, no backfill.** `null` is *nothing was kept* — every row written
-- before this migration and every return but a person's from a parked gate. A row whose excerpt a person's
-- return already overwrote has nothing left to move, so nothing is recovered; only the escalation's
-- `task.escalated` payload still carries a copy of those.
--
-- **The same shape as `return_reason_original_chars` (0058)**: a positive length only, and only beside
-- the text it measures. The text moves as it was stored: redacted at the gate's write (TD-012), never
-- re-derived or keyed on.
--
-- One writer, `attachReturnReason`, called by the two human return commands; one reader,
-- `lastReturnReason`. `recordStageExited` and `closeOpenStage` touch none of the three columns.
alter table task_stages add column attached_feedback text;
alter table task_stages add column attached_feedback_original_chars integer;
alter table task_stages add constraint task_stages_attached_feedback_original_chars_positive
  check (
    attached_feedback_original_chars is null
    or (attached_feedback_original_chars > 0 and attached_feedback is not null)
  );
-- Whether the next run is handed the kept excerpt (`attach_gate_feedback`). False for every row that
-- kept nothing, so `true` always has a text beside it.
alter table task_stages add column attached_feedback_sent boolean not null default false;
alter table task_stages add constraint task_stages_attached_feedback_sent_has_text
  check (not attached_feedback_sent or attached_feedback is not null);
