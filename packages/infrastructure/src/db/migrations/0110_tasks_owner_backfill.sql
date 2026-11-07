-- migration-class: additive
-- 0110 — a live task's tracker assignee is read once even if its ticket never changes (BACKLOG
-- 1510, closing S-26.1's gap; BACKLOG 1511, a failed read is tried again).
--
-- AUT-6676 on Autix stopped `needs_human` (`ticket_assigned_elsewhere`) before S-26.1 shipped: its
-- Jira ticket is assigned to a colleague, but `ticket_assignee` stayed null, because every read
-- that fills it (intake, a stage's re-read, the `owner_sync` duty on `ticket.updated`, the claim's
-- pre-read) needs either a new task or a changed ticket — and an idle task whose ticket nobody
-- touches gets neither. So the held-ticket callout could not name who holds it.
--
-- The recovery pass's `owner_backfill` row (`packages/application/src/recovery/owner-backfill.ts`)
-- finds a live `normal` task with `ticket_assignee is null`, `owner_backfill_at is null`, fewer than
-- three attempts and no retry time still ahead, **claims an attempt** (one conditional update,
-- `TaskRepository.claimOwnerBackfillAttempt`: `owner_backfill_attempts + 1` and the next
-- `owner_backfill_retry_at`, 15 minutes after the first, 2 hours after the second), and only then
-- enqueues the `owner_sync` duty with `owner_backfill: true`, which reads the ticket whatever the
-- snapshot's freshness:
--
--   owner_backfill_at        the backfill is over — the provider answered definitively (the
--                            ticket, an unassigned one included; a 404; a permission refusal), or
--                            the third attempt failed too and the platform stopped and logged it.
--                            Written by `settleOwnerBackfill`, only while null. Null is owed.
--   owner_backfill_attempts  attempts claimed so far, 0–3. A transient or provider failure (an
--                            outage, a 429, a 401, a binding that will not load) settles nothing, so
--                            the next pass after the retry time tries again; a lost enqueue counts as
--                            an attempt, so it is bounded by the same three.
--   owner_backfill_retry_at  not before this instant may the next attempt be claimed.
--
-- Additive by TD-032's list: two nullable columns and one with a literal default, which the
-- previous build never names — every existing row reads "owed, never tried". One writer per column
-- (`tasks-column-ownership.test.ts`). The partial index is the pass's query, so a drained
-- installation answers it from an empty index every interval.
alter table tasks add column owner_backfill_at timestamptz;
alter table tasks add column owner_backfill_attempts integer not null default 0;
alter table tasks add column owner_backfill_retry_at timestamptz;

create index tasks_owner_backfill_due_idx on tasks (updated_at)
  where owner_backfill_at is null and ticket_assignee is null;

comment on column tasks.owner_backfill_at is
  'When the owner backfill ended for this task (BACKLOG 1510/1511): a definitive read, or the last of three failed attempts. Null is owed. Written only by settleOwnerBackfill.';
comment on column tasks.owner_backfill_attempts is
  'Owner-backfill attempts claimed, at most 3 (BACKLOG 1511). Written only by claimOwnerBackfillAttempt, with owner_backfill_retry_at.';
