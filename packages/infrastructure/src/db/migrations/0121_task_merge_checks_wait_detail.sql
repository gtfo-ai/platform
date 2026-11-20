-- migration-class: additive
-- 0121 — `task_merge_checks.merge_wait_detail`: the words beside what the platform's merge waits
-- for (S-28.23, TD-038 Amendment C, backlog 1636).
--
-- A head at Ready that is not the reviewed one is classified now, never just refused: the
-- `platform_merge` duty reads the reviewed change back from the provider and tells a rebase
-- (identical change digest) from new changes. A rebase whose pipeline failed on the rebased commit
-- waits `head_rebased_ci_failed`, and the page names the jobs that failed — the one wait whose
-- sentence needs more than its code, so it is a column of its own beside `merge_wait`.
--
-- Provider text (CI job names): redacted with the git binding's redactor, then each name cut as the
-- CI gate cuts a job name, the list cut at 200 characters, before it is written (TD-012). Its one
-- writer is `TaskRepository.recordMergeDecision`, which writes it with every decision — `null`
-- unless the wait carries a detail, so a later wait never shows an earlier wait's jobs. Its one
-- reader is the task read's `merge.waiting_detail`.
--
-- Additive by TD-032's list: a nullable column, and a `not valid` check over that column only
-- (amendment C) whose expression is null-propagating — `null <> ''` is null, so a row the previous
-- build writes (no value) passes it. Non-empty when present; the 200-character bound is the
-- writer's (`MAX_MERGE_WAIT_DETAIL_CHARS`), because a function call is not null-propagating by
-- construction to the scanner (0120's shape).
alter table task_merge_checks add column merge_wait_detail text;

alter table task_merge_checks
  add constraint task_merge_checks_merge_wait_detail_not_empty
  check (merge_wait_detail <> '') not valid;

comment on column task_merge_checks.merge_wait_detail is
  'The redacted, bounded words beside merge_wait (S-28.23, TD-038 Amendment C): the CI jobs that failed on a rebased commit; null when the wait carries none.';
