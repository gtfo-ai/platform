-- migration-class: additive
-- 0113 — the manual jobs the platform started on a CI gate attempt (S-28.7, the M28 ruling on the
-- owner's feedback of 2026-11-10).
--
-- Autix's CI holds `build_composer`, `codeception` and `crawler-test` at `manual` while the merge
-- request is a `Draft:`, and the platform keeps it a draft until Ready, so every task's CI gate
-- waited for a person and timed out. Since S-28.7 a project chooses per job in
-- `pipeline.ci.manual_jobs` (project settings only): `run` — the platform starts it and its result
-- is a required check; `wait`; `ignore`. `ci_manual_started` is what the platform did about each
-- `run` job on this attempt: `[{job_id, pipeline_id, name, url, at, outcome}]` (at most 50, one
-- entry per job id), `outcome` one of `started`, `refused` (the provider refused the platform's
-- account, so a person starts it) or `unsupported` (the binding cannot start a manual job). Names
-- redacted then cut at 100 characters, ids digits only, the URL `http(s)` only or `null`.
--
-- **A new column, not keys in `ci_pending_read`**: an older build parses that one strictly and
-- would refuse the task's read after a rollback (TD-032 decision 2); it never names this column.
-- **On the attempt row**, as 0107 and 0109: one value per attempt, keyed as the readers ask. One
-- writer, `TaskRepository.recordCiManualStarted` (the `ci_play_manual` duty), only while the row is
-- open (`state = 'running' and exited_at is null`).
--
-- **Additive by TD-032's list**: a nullable column the previous build never names, no default, no
-- backfill — `null` reads "the platform started nothing on this attempt". The shape is held by
-- `ciManualStartedSchema` at the write and at every read, which refuses a value that does not
-- match it; no check constraint, for 0107's reason.
alter table task_stages add column ci_manual_started jsonb;

comment on column task_stages.ci_manual_started is
  'S-28.7: the manual jobs the platform started (or could not start) on this ci_gate attempt (ciManualStartedSchema), redacted. One writer, open rows only; null = none.';
