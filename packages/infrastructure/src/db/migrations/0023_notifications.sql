-- 0023 — the notification outbox (WP-32, product/18:33, technical/02's notify band at priority 210).
--
-- The platform sends its first chat message in this work package, and the thing that has to survive
-- between deciding to say something and actually saying it is a row. Three processes are involved
-- and any of them may be a different replica: an event handler decides (210), a `pipeline.outbound`
-- job delivers minutes later, and the `notify.digest` tick collects what quiet hours held back hours
-- after that.
--
-- **`delivered_at` is the only column that says a human was told.** Everything else is evidence:
--
--  * `planned_delivery` is what the policy decided at the moment the notification was *raised* —
--    which is the only moment the quiet window can be evaluated for it. A row planned `digest` and
--    then delivered immediately (or the reverse, after a failure) keeps both facts.
--  * `digest_day` is a **claim**: the day's digest stamps the rows it is about to post before it
--    posts them, so a retried job posts the same set rather than a growing one, and a claim left by
--    a day that never completed is re-claimed by the next one instead of being stranded.
--  * `urgent` is the classification the project's configuration gave it (`features.digest.urgent`),
--    recorded rather than re-derived, because the configuration can change afterwards and the
--    question "why was I woken at 03:00" is about the configuration that was in force.
--  * `mode` is the task's (`tasks.mode`). The digest groups by it and makes one call per mode, so a
--    shadow task's lines can never ride in a message a real one is in — BD-021 says a shadow
--    mutation is recorded `would_have` and never performed, and the executor can only honour that
--    if the call carries the mode.
--
-- **Unique on `(project_id, cause_event_id, class)`**, which is what makes an at-least-once wake-up
-- idempotent: the job may fire twice for one event and the second insert reports a duplicate. It is
-- a platform identity in every part — a uuid, a uuid and a closed vocabulary — so nothing in it
-- would ever need redacting, which is the rule `idempotencyScopeFor` states for the *other* key
-- this path carries (redaction is many-to-one and a key is an identity).
--
-- **`title`, `detail` and `url` are stored external text** — the third such sink after `inbox` and
-- `tasks.ticket_snapshot` — so they are written redacted (TD-012 step 1 composed with step 2, from
-- the chat binding's own redactor) and bounded before they are stored, and `redaction_count` is the
-- only signal a redactor that stopped working would leave. The bounds are the renderer's
-- (`NOTIFICATION_TITLE_MAX`, `NOTIFICATION_DETAIL_MAX`), and they are **not** repeated as column
-- types: a `varchar(200)` here would refuse a row the renderer had already cut, which is a failed
-- notification instead of a short one.
--
-- Not partitioned and not append-only: a row is updated exactly twice at most (claimed, delivered),
-- the table is bounded by the rate at which a pipeline produces events a human wants to hear about,
-- and the two states a reader cares about are indexed.
create table notifications (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  -- Null for a notification about a project rather than a task: a budget window has no task.
  task_id uuid references tasks (id) on delete cascade,
  class text not null,
  cause_event_id uuid not null,
  title text not null,
  detail text,
  url text,
  urgent boolean not null default false,
  planned_delivery text not null,
  mode text not null default 'normal',
  created_at timestamptz not null default now(),
  delivered_at timestamptz,
  delivered_as text,
  digest_day date,
  redaction_count integer not null default 0,
  constraint notifications_class_known check (
    class in (
      'task_started',
      'question',
      'stage_returned',
      'escalation',
      'task_completed',
      'task_cancelled',
      'budget_threshold',
      'budget_exhausted'
    )
  ),
  constraint notifications_planned_delivery_known
    check (planned_delivery in ('immediate', 'digest')),
  constraint notifications_delivered_as_known
    check (delivered_as is null or delivered_as in ('immediate', 'digest')),
  -- "Delivered" is one fact with two columns, so neither may be set without the other: a row with a
  -- timestamp and no channel could not answer "was this posted or batched", and a row with a
  -- channel and no timestamp would be counted as delivered by the digest's own predicate.
  constraint notifications_delivered_pair check ((delivered_at is null) = (delivered_as is null)),
  constraint notifications_mode_known check (mode in ('normal', 'shadow')),
  constraint notifications_redaction_count_nonnegative check (redaction_count >= 0),
  -- One notification per event per class per project. The wake-up is at-least-once; this is not.
  constraint notifications_cause_unique unique (project_id, cause_event_id, class)
);

-- The digest's two reads: which projects have something waiting, and this project's waiting rows.
-- Partial, because everything this index serves is a question about *undelivered* rows and a
-- delivered one is history nobody scans.
create index notifications_undelivered_idx
  on notifications (project_id, created_at)
  where delivered_at is null;

-- "Has a digest already gone out for this project today?" — the guard that stops a later tick
-- starting a second one out of rows that arrived after the first.
create index notifications_digest_day_idx
  on notifications (project_id, digest_day)
  where digest_day is not null;

comment on table notifications is
  'Chat notifications the platform decided to send (WP-32, product/18:33). delivered_at is the only column that says a human was told; digest_day is a claim by the day''s digest. title/detail/url are redacted external text (TD-012).';

insert into platform_table_policy (table_name, app_access) values ('notifications', 'read_write');
