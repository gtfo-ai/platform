-- 0058 — how long a return reason would have been had its writer not cut it (WP-81, BD-024 §5).
--
-- A failed CI gate's return reason carries an excerpt of the failing job's log, and the gate bounds
-- that excerpt to its head and its tail before the reason is stored. The reason reaches the next
-- Implementation run inside the prompt's `return_feedback` data block, and technical/07 requires a
-- truncation the platform applies to be announced in the block's **marker** (`truncated="true"`),
-- never as a line in the body a log could forge. The marker is written long after the cut, by the
-- assembler, so the cut has to be recorded beside the reason. This is where.
--
-- **Nullable, no default.** `null` is "nothing was cut" — every row written before this migration
-- and every writer but the CI gate. A positive length only, and only beside a reason: a cut of no
-- text means nothing, and the check says so rather than leaving it to the one writer.
--
-- **One writer**, `TaskRepository.recordStageExited`, from the return path of `applyDecision`; one
-- reader, `TaskRepository.lastReturnReason`, which hands it to the prompt with the reason.
alter table task_stages add column return_reason_original_chars integer;
alter table task_stages add constraint task_stages_return_reason_original_chars_positive
  check (
    return_reason_original_chars is null
    or (return_reason_original_chars > 0 and return_reason is not null)
  );
