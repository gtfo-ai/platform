-- 0087 — the mark of the recovery row that escalates an expired last try (WP-156 ruling (c),
-- TD-004's M7 amendment, PROGRESS backlog 421).
--
-- A bound-and-escalate job (`mr.comment.debounce`, and the `pipeline.outbound` duties a person
-- waits on) escalates its task from inside its handler when its **last** try throws
-- (`pipeline/job-escalation.ts`). A last try that **expires** never throws: measured at WP-156
-- (`test/integration/jobs/job-expiry.integration.test.ts`), pg-boss 12.30.0 fails it either from
-- the worker's own timer (output `{"name":"Error","message":"handler execution exceeded <n>s"}`,
-- with the handler still running) or from the supervisor (output
-- `{"value":{"message":"job timed out"}}`, when no process is left to time it), and both leave the
-- same `failed` row a throw leaves, told apart only by `output`. The recovery pass
-- (`recovery/expired-job.ts`) reads those rows off pg-boss's own table and escalates each job's task
-- **once per job id** — and this table is that "once".
--
-- One row per pg-boss job id the pass acted on, inserted **before** the escalation in a transaction
-- of its own (the recovery table's safe order: a crash between the two costs the escalation, never
-- repeats it). `on conflict do nothing` on the primary key is the arbiter between two processes
-- running the pass at once. Never updated, never deleted: the pg-boss row it names is deleted by
-- pg-boss's own retention after a week, and the pass reads only a day back
-- (`EXPIRED_JOB_HORIZON_MS`), so a mark outliving its job is harmless and a mark that vanished
-- would let a job still inside the horizon escalate twice.
--
-- No foreign keys: `job_id` names a row of `pgboss.job`, which this schema does not own, and
-- `task_id` is what the job's payload said — recorded for the reader, and possibly a task that
-- was deleted since (the escalation then answers `absent`, which is still an ending).
create table expired_job_escalations (
  job_id uuid primary key,
  queue text not null,
  task_id uuid,
  marked_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint expired_job_escalations_queue_shape check (char_length(queue) between 1 and 128)
);

-- Written once by the recovery pass and never changed.
insert into platform_table_policy (table_name, app_access)
values ('expired_job_escalations', 'append_only');

comment on table expired_job_escalations is
  'The expired-last-try recovery''s mark (WP-156, backlog 421): one row per pg-boss job id whose task the recovery pass escalated because its last try expired rather than threw.';
