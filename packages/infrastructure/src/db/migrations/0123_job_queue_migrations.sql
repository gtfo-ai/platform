-- migration-class: additive
-- 0123 — `job_queue_migrations`: the record of the queue migrations `migrate` applied (TD-004's
-- 2026-11-26 amendment, BD-034, BACKLOG 1656).
--
-- A queue's options (retries, backoff, expiry) live on pg-boss's own `queue` row, and pg-boss's
-- `create_queue` is `insert … on conflict do nothing`: editing `JOB_QUEUE_DEFINITIONS` shapes a fresh
-- database and leaves every existing one as it was. BD-034 lengthens the retries of the
-- provider-calling queues a person waits on (`pipeline.outbound`, `mr.comment.debounce`) from three
-- tries to about five hours, which an existing database only gets through a migration of the queue
-- row. That cannot be a statement in this directory — the pgboss schema is installed *after* these
-- files run, and an `update` is not an additive statement (TD-032) — so it is a named row of
-- `JOB_QUEUE_MIGRATIONS` (`packages/application/src/ports/job-queues.ts`), applied once by `migrate`
-- through pg-boss's `updateQueue` after the queues are declared, under the same advisory lock, and
-- recorded here (`packages/infrastructure/src/jobs/job-queue-migrations.ts`).
--
-- One row per applied queue migration, inserted after its update (a crash between the two applies
-- the same options again next time, which is the same options). `options` is what was applied, keys
-- sorted, so a later build carrying different options for the same name is refused — forward-only,
-- like `platform_migrations`' checksum. Never updated, never deleted. No foreign key: `queue` names a
-- row of `pgboss.queue`, which this schema does not own.
create table job_queue_migrations (
  name text primary key,
  queue text not null,
  options jsonb not null,
  applied_at timestamptz not null default now(),
  constraint job_queue_migrations_name_shape check (name ~ '^[0-9]{4}_[a-z0-9_]+$'),
  constraint job_queue_migrations_queue_shape check (char_length(queue) between 1 and 128)
);

-- Written once by `migrate` and never changed.
insert into platform_table_policy (table_name, app_access)
values ('job_queue_migrations', 'append_only');

comment on table job_queue_migrations is
  'The queue migrations migrate applied (TD-004 2026-11-26 amendment, BD-034): one row per named change to a live pg-boss queue''s options, with the options applied.';
