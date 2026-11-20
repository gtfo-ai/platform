-- migration-class: additive
-- 0120 — `task_stages.retry_reason`: the words a person gave a *Retry stage* (S-28.20, backlog 1619).
--
-- `POST /api/tasks/:id/retry-stage` has accepted an optional `reason` since WP-15i, and the task
-- page's *Retry a stage* dialog offers a box for it, but the route dropped it: it was not stored, not
-- audited and never reached the run (AUT-6645, 2026-11-20 — a person retried `code_review` believing
-- they had told the agent which findings it could ignore).
--
-- A retry enters a **new attempt** of the stage the task is at. The reason is stored on that
-- attempt's row — the row the retry opened — and the stage executor reads it for that attempt and
-- hands it to the run as a `retry_note` data block (technical/04). A column of the **entered** row,
-- not the exited one: `return_reason`/`returned_to` describe how an attempt *ended* and are what the
-- task page counts as returns (`state = 'returned'`, which `task_stages_returned_to_is_a_return`
-- requires beside a target); a retry is not a return and spends no round.
--
-- Redacted by the command before it is written (TD-012), bounded by the contract
-- (`MAX_COMMAND_TEXT_CHARS`); the prompt applies its own block cap and announces a cut in the marker.
-- Non-empty when present. One writer, `TaskRepository.recordRetryReason` (the retry command, in its
-- own transaction, only on the open row of the attempt it entered); one reader,
-- `TaskRepository.retryReasonOf` (the stage executor's admission). No backfill: `null` is *no note*.
alter table task_stages add column retry_reason text;
alter table task_stages add constraint task_stages_retry_reason_not_empty
  check (retry_reason <> '') not valid;
