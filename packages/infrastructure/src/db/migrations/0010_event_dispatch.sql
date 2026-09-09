-- 0010 — the event envelope's own id, and the dispatch queue (TD-005, WP-04).
--
-- Two gaps WP-04 had to close before a dispatcher could exist.

-- ── 1. events.id ─────────────────────────────────────────────────────────────
-- technical/02 gives every event an id and a `cause_event_id`; technical/03's column list has
-- neither, only `position` and `cause_event_position`. `packages/contracts` (WP-01) implemented the
-- document that has them, so an event read back out of the log could not be parsed against its own
-- catalogue schema — the envelope was missing a required field. The id is minted by the domain
-- (`IdSource`, uuidv7) and written by the application; the default is a safety net for hand-written
-- SQL and for the rows migration 0005's own tests insert.
--
-- `position` stays the physical identity: it is what `handler_executions` and `event_dispatch`
-- reference, and what orders the log. `id` is the stable name the rest of the system quotes.
--
-- **Operational note.** `uuidv7()` is VOLATILE, so this is not a metadata-only change: PostgreSQL
-- rewrites every partition of `events` under ACCESS EXCLUSIVE to fill the column (the relfilenode
-- changes; verified). On an empty or young log that is instant, which is the only situation this
-- migration is meant for — it lands before the first deployment. Anyone applying it to a database
-- with a large `events` table should expect a full rewrite and plan a window for it.
alter table events add column id uuid not null default uuidv7();
alter table events add column cause_event_id uuid;

comment on column events.id is
  'Envelope id (technical/02); minted by the domain as uuidv7. Unique by construction — a partitioned table cannot carry a unique constraint that excludes the partition key.';
comment on column events.cause_event_id is
  'Envelope id of the event whose handler emitted this one; cause_event_position is the same link by position.';

create index events_id_idx on events (id);

-- ── 2. The dispatch queue ────────────────────────────────────────────────────
-- TD-005 makes the events table the outbox: appending an event *is* enqueueing its dispatch, in
-- the same transaction. This table is the index over that log — one row per event that has not
-- finished dispatching — written by the trigger below, so:
--
--   * no code path can append an event without queueing its dispatch, and none can queue one that
--     was never appended (the same reason the stream-sequence guard is a trigger and not a
--     convention);
--   * the sweep is O(pending) instead of O(events). Anti-joining `events` against
--     `handler_executions` on every poll would re-read the whole audit log to find the handful of
--     rows that still need work.
--
-- Unlike `events`, this is a work queue and not an audit record: the application deletes a row when
-- the event's handlers are done. What was dispatched, and by which handler, stays in
-- `handler_executions` — including the `$dispatch` marker row, which is the durable "this event
-- finished dispatching" record. So the mutable table holds no evidence; losing all of it would
-- cost re-dispatch, which the handler_executions guard makes a no-op.
create table event_dispatch (
  event_position bigint primary key,
  -- Part of `events`' primary key (occurred_at, position), so the sweep's join can prune
  -- partitions instead of probing every month's index.
  occurred_at timestamptz not null,
  stream_type text not null,
  stream_id uuid not null,
  stream_seq integer not null,
  attempts integer not null default 0,
  error text,
  -- Retry backoff. A failed dispatch keeps its place in the stream and comes back later.
  available_at timestamptz not null default now(),
  enqueued_at timestamptz not null default now(),
  constraint event_dispatch_stream_seq_positive check (stream_seq >= 1),
  constraint event_dispatch_attempts_positive check (attempts >= 0)
);

comment on table event_dispatch is
  'Undispatched events (TD-005). Written by a trigger on events, deleted when every handler of the event reached a terminal status.';

-- The ordering guard reads this index: "is an earlier event of this stream still queued?".
create index event_dispatch_stream_idx on event_dispatch (stream_type, stream_id, stream_seq);
-- The sweep reads this one: due rows, in log order.
create index event_dispatch_ready_idx on event_dispatch (available_at, event_position);

create function events_enqueue_dispatch()
  returns trigger
  language plpgsql
  set search_path = pg_catalog, public
as $$
begin
  insert into event_dispatch (event_position, occurred_at, stream_type, stream_id, stream_seq)
  values (new.position, new.occurred_at, new.stream_type, new.stream_id, new.stream_seq);
  return null;
end
$$;

revoke all on function events_enqueue_dispatch() from public;

comment on function events_enqueue_dispatch() is
  'Enqueues every appended event for dispatch in the appending transaction (TD-005 transactional outbox).';

-- AFTER INSERT, so it only ever sees a row the BEFORE trigger already accepted: an append that
-- fails the stream-sequence guard never reaches the queue.
create trigger events_enqueue_dispatch_after_insert
  after insert on events
  for each row
  execute function events_enqueue_dispatch();

-- read_write: the application claims, defers and deletes rows here. This is the one table WP-04
-- adds that the app may modify, and it deliberately holds no audit value — see the comment above.
insert into platform_table_policy (table_name, app_access)
values ('event_dispatch', 'read_write');
