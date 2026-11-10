-- migration-class: additive
-- 0116 — the one-off ticket-status sweep (S-28.5, M28 ruling 5, TD-029 amendment B decision 4).
--
-- S-28.5's reverse sync stops a live task when a person finished or took its ticket, but only on a
-- signal: a task whose ticket was finished before the deploy (AUT-6676, *Released* three weeks
-- before it became a task) never sends one. The recovery pass's `ticket_status_sweep` row
-- (`packages/application/src/recovery/ticket-status-sweep.ts`) finds each live `normal` task once,
-- **records it here first** (one `insert … on conflict do nothing`, so two passes that found the same
-- task enqueue one read), and only then enqueues the `ticket_status_recheck` duty, which reads the
-- ticket and applies the same table the signal does.
--
-- The sweep is one-off by its cutoff: it considers only tasks created before its own first row
-- (`min(swept_at)`), so a task created after the deploy is never swept. Residual, stated: on an
-- installation with no live task at the first pass no row is written, and each later task is swept
-- once — one extra read per task.
--
-- Additive by TD-032's list: a new table the previous build never names, registered below.
create table ticket_status_sweeps (
  task_id uuid primary key references tasks (id) on delete cascade,
  swept_at timestamptz not null
);

-- `read_write`: rows are inserted once and removed with their task.
insert into platform_table_policy (table_name, app_access)
values ('ticket_status_sweeps', 'read_write');

comment on table ticket_status_sweeps is
  'The one-off ticket-status sweep (S-28.5, M28 ruling 5): a row per live task whose ticket the sweep re-read once, written before the read is enqueued. The earliest swept_at is the sweep''s cutoff: tasks created after it are never swept.';
