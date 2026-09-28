-- 0059 — three wake-ups and one message the platform could lose (WP-84, PROGRESS backlog 240,
-- 236 (2) and 165).
--
-- ## `tasks.dependency_recovery_attempted_at` — the mark of the deferred-gate recovery (240)
--
-- A dependency-gate ending that met a stop a human owns is deferred (`tasks.dependencies`'
-- `deferred_stage`, WP-67) and performed by the `dependency_gate_resume` duty, which a `task.resumed`
-- handler enqueues **after commit**. A process that dies in that window leaves an `active` task with
-- the deferral on it and nothing to perform it. `recovery/deferred-dependency.ts` is the row of
-- `recovery/stranded.ts`'s table that finds such a task, and this column is its bound (backlog 105's
-- rule): the instant the pass re-enqueued the duty. The pass acts again only for a **later**
-- `task.resumed` than the mark — one attempt per resume — so a duty that keeps failing is not
-- re-enqueued every pass, and a new deferral that meets a new resume is recoverable in its turn.
-- The column's one writer is the recovery store (`postgres-deferred-dependency-store.ts`), which the
-- `tasks` column census pins.
--
-- ## `notifications.repost_attempted_at` — the mark of the re-post sweep (236 (2))
--
-- A planned-`immediate` notification whose delivery failed on every attempt the job had is
-- undelivered for good: nothing re-posts it (no digest carries an organisation row, nor any row of
-- a project with the digest off). The re-post row of the same pass re-enqueues the original duty
-- once, under the same idempotency key, and marks the row first. Nullable: the ordinary life of a
-- row is never to need it.
--
-- ## `reminder` — a notification class (165)
--
-- BD-006's *"with a reminder before escalation"*: a question or an approval still waiting halfway
-- to its deadline is announced once more, as its own class, so the reminder row never collides with
-- the notification that first asked (`(project_id, cause_event_id, class)` is the unique key).
--
-- ## `approvals.reminders_sent` — the approval's reminder counter (165, Q95)
--
-- Q95 put approvals on the question's calendar, so they get the question's reminder too, and the
-- question's counter (`questions.reminders_sent`, migration 0004) beside it. Written only by a
-- narrow increment guarded by `status = 'pending'`, never by the aggregate's whole-row `save`.

alter table tasks add column dependency_recovery_attempted_at timestamptz;

alter table notifications add column repost_attempted_at timestamptz;

-- **Every undelivered row recorded before this migration counts as already attempted** (WP-84 review
-- round 1). Without it the first pass after an upgrade would re-post every undelivered `immediate`
-- row since WP-32 — a `task_started` for a task finished months ago among them. Those rows predate
-- the promise the re-post makes, and they carry no `question_id` (below) to be re-checked against.
-- A backfill rather than an upper age bound on the query: a bound would also silently drop a row
-- recorded *after* the upgrade once an outage (or a switched-off recovery pass) outlasted it, while
-- the gauge still counted it; the backfill excludes exactly the rows the sweep never promised.
update notifications set repost_attempted_at = now()
 where delivered_at is null and planned_delivery = 'immediate';

-- ## `notifications.question_id` — which question a row asks or reminds about (WP-84 review round 1)
--
-- A `question` row and a question's `reminder` row are re-checked against their question before a
-- retry or a re-post sends them (an answered or expired question is not asked again). The row must
-- say which question, because the rebuilt wake-up carries nothing else. An approval's rows use the
-- existing `approval_id`. `on delete set null` for `approval_id`'s reason.
alter table notifications
  add column question_id uuid references questions (id) on delete set null;

alter table notifications drop constraint notifications_class_known;

alter table notifications add constraint notifications_class_known check (
  class in (
    'task_started',
    'question',
    'stage_returned',
    'escalation',
    'task_completed',
    'task_cancelled',
    'budget_threshold',
    'budget_exhausted',
    'approval',
    'maintenance_report',
    'reminder'
  )
);

alter table approvals add column reminders_sent integer not null default 0;
alter table approvals add constraint approvals_reminders_sent_nonnegative
  check (reminders_sent >= 0);

-- ## `delivered_as = 'withheld'` — a notification the platform decided not to send (review round 2)
--
-- A `question`, `reminder` or `approval` row whose question was answered or expired, or whose
-- approval was decided or expired, before a retry, a re-post or the digest reached it, is **not
-- sent** — and until this outcome existed it stayed `delivered_at is null`, so the next digest
-- carried it anyway and the `notifications_undelivered` gauge counted it for ever: a false alarm
-- about a message that was correctly withheld, not lost. `withheld` is terminal like the other two:
-- `delivered_at` is set with it (`notifications_delivered_pair` holds), so the gauge, the re-post
-- and the digest — all of which read `delivered_at is null` — skip it, and `digestDelivered` (which
-- reads `delivered_as = 'digest'`) is not fooled by a withheld row claimed for the day.
alter table notifications drop constraint notifications_delivered_as_known;
alter table notifications add constraint notifications_delivered_as_known
  check (delivered_as is null or delivered_as in ('immediate', 'digest', 'withheld'));

