-- migration-class: additive
-- 0110 — a live task's tracker assignee is read once even if its ticket never changes (BACKLOG
-- 1510, closing S-26.1's gap).
--
-- AUT-6676 on Autix stopped `needs_human` (`ticket_assigned_elsewhere`) before S-26.1 shipped: its
-- Jira ticket is assigned to a colleague, but `ticket_assignee` stayed null, because every read
-- that fills it (intake, a stage's re-read, the `owner_sync` duty on `ticket.updated`, the claim's
-- pre-read) needs either a new task or a changed ticket — and an idle task whose ticket nobody
-- touches gets neither. So the held-ticket callout could not name who holds it.
--
-- The recovery pass's `owner_backfill` row (`packages/application/src/recovery/owner-backfill.ts`)
-- finds a live `normal` task with `ticket_assignee is null` and this column null, writes this
-- column (one conditional update, `TaskRepository.markOwnerBackfill`), and only then enqueues the
-- `owner_sync` duty with `owner_backfill: true`, which reads the ticket once whatever the snapshot's
-- freshness. **The mark is the attempt, not the read's success**: a ticket that is genuinely
-- unassigned answers `null` again and is never asked for twice, and a read that fails spends the
-- one attempt too (the next `ticket.updated` or stage re-read still syncs it, as before).
--
-- Additive by TD-032's list: a nullable column the previous build never names, with no default and
-- no backfill — every existing row is `null`, which reads "the one backfill read is still owed".
-- One writer, `markOwnerBackfill` (`tasks-column-ownership.test.ts`). The partial index is the
-- pass's query, so a drained installation answers it from an empty index every interval.
alter table tasks add column owner_backfill_at timestamptz;

create index tasks_owner_backfill_due_idx on tasks (updated_at)
  where owner_backfill_at is null and ticket_assignee is null;

comment on column tasks.owner_backfill_at is
  'When the recovery pass spent this task''s one owner-backfill read (BACKLOG 1510): set before the owner_sync duty is enqueued, never moved. Null is owed. Written only by markOwnerBackfill.';
