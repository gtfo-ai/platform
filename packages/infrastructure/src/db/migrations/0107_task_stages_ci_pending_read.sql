-- migration-class: additive
-- 0107 — what the CI gate is waiting on (backlog 1078).
--
-- Until now the CI gate's pending read reached the database only as `return_reason` at its
-- timeout: AUT-6655's pipeline was held at a manual job for two hours across two attempts, and no
-- person could see why until each hour ran out. `ci_pending_read` is that read, structured, on the
-- `ci_gate` attempt it belongs to — `{pipeline_id, pipeline_url, head_sha, status, held_job,
-- held_job_url, draft, checked_at, timeout_minutes}`, the provider's strings redacted and bounded —
-- written on every pending read of the head pipeline (a pipeline neither passed nor failed) while
-- the attempt is open, and set to `null` by a pending read that found no such pipeline. A closed
-- attempt keeps its last read: the next attempt's first read compares itself with it, and the
-- task-detail DTO serves the open attempt's as `gate_wait`.
--
-- **A column of the attempt rather than a table of its own**: the read is one value per attempt,
-- overwritten in place, and the attempt row is already the key both readers ask by — a narrow
-- table would repeat `(task_id, stage, attempt)` to hold one row each. **Not `tasks`**: the task
-- row is versioned and partitioned by writer (`tasks-column-ownership.test.ts`), and a poll's write
-- every thirty seconds beside the stage executor is the lost-update shape that partition exists to
-- refuse. One writer, `TaskRepository.recordCiPendingRead` (`… where state = 'running' and
-- exited_at is null`, so a closed attempt's read is never moved).
--
-- **Additive by TD-032's list**: a nullable column the previous build never names, with no default
-- and no backfill — every existing row is `null`, which reads "no pending read recorded". The
-- shape is held by the one writer's strict zod schema (`ciPendingReadSchema`) and by every read,
-- which parses the same schema and refuses a value that does not match it (never a default); no
-- check constraint, because `jsonb_typeof` is a function call TD-032's amendment C cannot read as
-- null-propagating.
alter table task_stages add column ci_pending_read jsonb;

comment on column task_stages.ci_pending_read is
  'Backlog 1078: the CI gate attempt''s last pending read of the head pipeline (ciPendingReadSchema), redacted. Written while the attempt is open; null = no such read.';
