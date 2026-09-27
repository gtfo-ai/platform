-- 0051 — an organisation-scoped notification, the maintenance report, and the approval message's
-- address (WP-65, PROGRESS backlog 80, 107 and 202).
--
-- **An organisation's budget has no project** (backlog 80). BD-010's organisation cap is the one
-- budget that stops every project, and `budget.exhausted` for it carries `project_id: null`, so the
-- row that records "the platform decided to tell somebody" had nowhere to live: `project_id` was
-- `not null`. WP-65 takes the backlog entry's answer (c) — the notification goes to the channel
-- the organisation's **own** chat account names (`integrations.config`), not to an arbitrary
-- project's binding — and the row that records it has no project.
--
-- **The unique key is re-declared `nulls not distinct`**, and that is the half of this migration
-- that matters. PostgreSQL's default is `NULLS DISTINCT`: two rows whose `project_id` is null are
-- never equal, so merely dropping `not null` would have removed the dedup guarantee for exactly the
-- rows that become organisation-scoped — an at-least-once wake-up would then post twice. The
-- constraint keeps its name, so `record`'s `on conflict (project_id, cause_event_id, class)` infers
-- the same arbiter. Asserted by inserting one cause and class twice with a null project
-- (`test/integration/notify/postgres-notification-store.integration.test.ts`).
--
-- An organisation-scoped row has no task either: a task belongs to a project, and a row that named
-- a task with no project would be one nobody can place. The check says so.
--
-- **`maintenance_report` is a class** (backlog 107): the nightly maintenance pass records what it
-- did — created, refused, over budget — as a row planned for the **digest**, the surface an operator
-- already reads at the pass's own grain. It is only written for a project whose digest is on and
-- which has a chat binding, so it is never a row nothing can deliver.
--
-- **`approval_id` and `message_ref`** (backlog 202): an approval posted with buttons is a message
-- the platform must be able to find again, because a decided or expired approval's buttons are a
-- control that lies. `message_ref` is the provider's own address of the posted message (channel and
-- message id — `MessageRef`), written with the delivery; `approval_id` is which approval it asked
-- about. `on delete set null` for the approval, like `decided_by_user_id`'s: the row is the record
-- that a message was sent, and outlives what it was about.
--
-- Forward-only: every existing row has a project, satisfies the scope check and the wider class
-- set, and has neither new column.
alter table notifications alter column project_id drop not null;

alter table notifications drop constraint notifications_cause_unique;

alter table notifications add constraint notifications_cause_unique
  unique nulls not distinct (project_id, cause_event_id, class);

alter table notifications add constraint notifications_org_scope_has_no_task
  check (project_id is not null or task_id is null);

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
    'maintenance_report'
  )
);

alter table notifications
  add column approval_id uuid references approvals (id) on delete set null;

alter table notifications add column message_ref jsonb;

-- "Which message asked about this approval?" — the one read the settled-approval duty makes.
create index notifications_approval_idx
  on notifications (approval_id)
  where approval_id is not null;

comment on column notifications.project_id is
  'Null for an organisation-scoped notification (an organisation budget, WP-65): delivered to the organisation''s own chat account''s channel. The unique key is nulls-not-distinct so such rows still deduplicate.';
comment on column notifications.message_ref is
  'The provider''s address of the posted message (MessageRef), for an approval whose buttons must be removed once it is decided or expires (WP-65, backlog 202).';
