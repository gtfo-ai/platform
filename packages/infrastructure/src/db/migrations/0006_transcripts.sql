-- 0006 — transcripts (technical/03 § "Transcripts", TD-007, TD-012).

create table blobs (
  id uuid primary key default uuidv7(),
  sha256 text not null,
  size bigint not null,
  media_type text not null,
  storage blob_storage not null default 'db',
  -- Path or object key when `storage` is not 'db'.
  locator text,
  data bytea,
  created_at timestamptz not null default now(),
  constraint blobs_payload_matches_storage check (
    (storage = 'db' and data is not null and locator is null)
    or (storage <> 'db' and locator is not null and data is null)
  )
);

-- Not unique: the same bytes may legitimately be stored under two media types or two backends.
create index blobs_sha256_idx on blobs (sha256);

-- One row per completed SDK message, plus one coalesced `stream_block` row per content block
-- (TD-007). Partial deltas are never stored individually. Payloads over 1 MB go to `blobs`.
create table run_messages (
  run_id uuid not null references runs (id) on delete cascade,
  seq integer not null,
  created_at timestamptz not null default now(),
  kind transcript_kind not null,
  subtype text,
  parent_tool_use_id text,
  tool_use_id text,
  tool_name text,
  payload jsonb not null,
  blob_id uuid references blobs (id) on delete set null,
  -- Compact, already-redacted text extracted for full-text search (TD-012 runs first).
  search_text text,
  search tsvector generated always as (to_tsvector('simple', coalesce(search_text, ''))) stored,
  size_bytes integer not null default 0,
  redaction_count integer not null default 0,
  -- The partition key must be part of the key; range scans still start at (run_id, seq).
  primary key (run_id, seq, created_at),
  constraint run_messages_seq_positive check (seq >= 1)
) partition by range (created_at);

-- Indexes declared on the parent are created on every partition, present and future.
create index run_messages_search_idx on run_messages using gin (search);
create index run_messages_tool_use_idx on run_messages (run_id) where tool_use_id is not null;
create index run_messages_created_at_idx on run_messages (created_at);

-- Append-only counterpart of run_messages.redaction_count (TD-012): which rule fired where.
-- No surrogate key — the same rule may legitimately match a message more than once.
create table redaction_log (
  run_id uuid not null,
  seq integer not null,
  rule_id text not null,
  created_at timestamptz not null default now()
) partition by range (created_at);

create index redaction_log_run_idx on redaction_log (run_id, seq);
create index redaction_log_rule_idx on redaction_log (rule_id, created_at);

-- retention_days stays null here: the migrate entrypoint writes the operator's
-- APP_TRANSCRIPT_RETENTION_DAYS into it, and null means keep forever (Q13).
insert into platform_table_policy (table_name, app_access, partition_column, retention_scope)
values ('run_messages', 'append_only', 'created_at', 'transcripts');

insert into platform_table_policy (table_name, app_access, partition_column)
values ('redaction_log', 'append_only', 'created_at');
