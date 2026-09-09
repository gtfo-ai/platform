-- 0005 — event log, dispatch bookkeeping and the webhook inbox
-- (technical/03 § "Event log and jobs", TD-005).

-- Append-only, monthly range partitions on occurred_at. The table is also the transactional
-- outbox: an aggregate's state change and its events are written in one transaction and the
-- dispatcher publishes from here.
create table events (
  position bigint generated always as identity,
  stream_type text not null,
  stream_id uuid not null,
  stream_seq integer not null,
  type text not null,
  payload jsonb not null,
  -- Envelope actor (technical/02): system, user or integration. No default — `actorSchema` is a
  -- discriminated union with no empty member, so a defaulted `{}` would be an invalid actor
  -- written silently. Every append names who caused it.
  actor jsonb not null,
  cause_event_position bigint,
  correlation_id uuid,
  occurred_at timestamptz not null default now(),
  -- Consumers fence on pg_snapshot_xmin(pg_current_snapshot()); the global position is not gapless
  -- (research/07).
  xact_id xid8 not null default pg_current_xact_id(),
  primary key (occurred_at, position),
  constraint events_stream_seq_positive check (stream_seq >= 1)
) partition by range (occurred_at);

comment on table events is
  'Append-only domain event log and transactional outbox (TD-005). Partitioned monthly on occurred_at.';

create index events_stream_idx on events (stream_type, stream_id, stream_seq);
create index events_type_occurred_at_idx on events (type, occurred_at);
create index events_correlation_id_idx on events (correlation_id) where correlation_id is not null;
create index events_position_idx on events (position);

-- technical/03 asks for UNIQUE(stream_type, stream_id, stream_seq). PostgreSQL cannot express that
-- on a partitioned table: every unique constraint must contain the partition key, which would
-- reduce the guarantee to "unique within one month". The invariant is instead enforced globally by
-- this table plus the trigger below.
--
-- How locking actually works here, because it is not what TD-005's wording suggests: the trigger's
-- `on conflict do update … returning` takes the `event_streams` row lock itself, so concurrent
-- appends to one stream serialise at INSERT time without the caller doing anything. The
-- application role must NOT try to lock this row — it holds SELECT only, so `SELECT … FOR UPDATE`
-- (and FOR SHARE, FOR NO KEY UPDATE) fail with 42501. A caller that wants TD-005's pessimistic
-- aggregate load locks the aggregate's own row in a read_write table — `tasks`, `runs`, and so on
-- — never this one.
create table event_streams (
  stream_type text not null,
  stream_id uuid not null,
  last_seq integer not null,
  updated_at timestamptz not null default now(),
  primary key (stream_type, stream_id),
  constraint event_streams_last_seq_positive check (last_seq >= 1)
);

-- SECURITY DEFINER so the application role never needs INSERT or UPDATE on `event_streams`: with
-- write access it could delete the row and re-append an existing sequence, forging the very
-- invariant this table exists to hold. It gets SELECT only (app_access = 'read_only' below) and
-- the trigger, running as the owner, maintains the counter.
create function events_enforce_stream_seq()
  returns trigger
  language plpgsql
  security definer
  set search_path = pg_catalog, public
as $$
declare
  v_expected integer;
begin
  insert into event_streams as s (stream_type, stream_id, last_seq)
  values (new.stream_type, new.stream_id, 1)
  on conflict (stream_type, stream_id)
    do update set last_seq = s.last_seq + 1, updated_at = now()
  returning s.last_seq into v_expected;

  if new.stream_seq <> v_expected then
    raise exception
      'stream %/% is at sequence %, cannot append %',
      new.stream_type, new.stream_id, v_expected, new.stream_seq
      using errcode = 'unique_violation';
  end if;

  return new;
end
$$;

revoke all on function events_enforce_stream_seq() from public;

create trigger events_stream_seq_guard
  before insert on events
  for each row
  execute function events_enforce_stream_seq();

-- Idempotency guard for the dispatcher: one row per (event, handler) (TD-005).
-- There is no foreign key to events.position because `position` alone cannot carry a unique
-- constraint on a partitioned table; the identity sequence still makes it globally unique.
create table handler_executions (
  event_position bigint not null,
  handler text not null,
  priority integer not null,
  -- WP-04 owns the dispatcher's status vocabulary.
  status text not null,
  attempts integer not null default 0,
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  primary key (event_position, handler)
);

create index handler_executions_status_idx on handler_executions (status, event_position);

-- Webhook dedup and raw audit (technical/03). Payloads are untrusted data (BD-022).
create table inbox (
  provider text not null,
  delivery_id text not null,
  integration_id uuid references integrations (id) on delete set null,
  received_at timestamptz not null default now(),
  headers jsonb not null default '{}'::jsonb,
  payload jsonb not null,
  processed_at timestamptz,
  error text,
  primary key (provider, delivery_id)
);

create index inbox_unprocessed_idx on inbox (received_at) where processed_at is null;

insert into platform_table_policy (table_name, app_access, partition_column)
values ('events', 'append_only', 'occurred_at');

-- Read-only for the application: only the definer trigger writes it (see above).
insert into platform_table_policy (table_name, app_access)
values ('event_streams', 'read_only');
