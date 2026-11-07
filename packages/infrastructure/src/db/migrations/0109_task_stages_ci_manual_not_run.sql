-- migration-class: additive
-- 0109 — what a CI pass left unstarted (S-27.2, TD-036 decision 5, BD-024's 2026-11-07 amendment).
--
-- AUT-6655 on Autix: GitLab held pipeline 3038234623 at `sentry-release-commit`, a release step,
-- and the CI gate waited out its timeout twice. Since S-27.2 a manual job nobody started is not a
-- check unless it is a test, so a held pipeline whose every job that ran is green **passes** — and
-- the platform says what did not run: the task's Checks item and the workpad read *CI passed — the
-- manual job sentry-release-commit was not run*, and Ready says the provider may still show the
-- pipeline blocked. `ci_manual_not_run` is that fact, structured, on the `ci_gate` attempt that
-- passed: `{pipeline_id, pipeline_url, pipeline_status, jobs: [{name, stage, url}] (at most 20),
-- checked_at}` — the blocking manual jobs nobody started (optional ones held nothing and are not
-- listed), names and stages redacted then bounded, URLs kept only as an http(s) URL with no
-- credentials the redactor leaves unchanged, the pipeline id never cut or redacted.
--
-- **A new column, not a third `ci_ending` word or a key in `ci_pending_read`** (TD-036 decision 5):
-- an older build parses those two strictly and would refuse the task's read after a rollback
-- (TD-032 decision 2); it never names this column. **On the attempt row**, for 0107's reasons: one
-- value per attempt, keyed as both readers ask (the task-detail DTO serves the latest passed
-- attempt's, the workpad reads the same); not `tasks`, whose row is versioned and partitioned by
-- writer. One writer, `TaskRepository.recordCiManualNotRun`, in the settling transaction and only
-- while the row is open (`… where state = 'running' and exited_at is null`).
--
-- **Additive by TD-032's list**: a nullable column the previous build never names, with no default
-- and no backfill — every existing row is `null`, which reads "the pass left nothing unstarted, or
-- was not a pass". The shape is held by `ciManualNotRunSchema` at the write and at every read,
-- which refuses a value that does not match it (never a default); no check constraint, for 0107's
-- reason.
alter table task_stages add column ci_manual_not_run jsonb;

comment on column task_stages.ci_manual_not_run is
  'S-27.2 (TD-036): the blocking manual jobs a passed ci_gate attempt left unstarted (ciManualNotRunSchema), redacted. Written once while the attempt is open; null = none.';
