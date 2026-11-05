-- migration-class: additive
-- 0099 — what a remote run's calls to the core leave behind (WP-282, TD-031 decisions 5, 10a and
-- 10b, §9's `tools/:name`, `approvals` and `session` verbs).
--
-- **Why a migration, when the plan row says none.** The row's three stores were assumed to exist and
-- do not: a mutating tool's answer keyed `(run_id, tool_use_id)` (TD-031 §9: "tool calls are
-- idempotent by `(run_id, tool_use_id)`") has no table — `command_idempotency` is keyed by a user and
-- stores no answer, `integration_idempotency` is the executor's and keyed by a binding; a tool
-- approval opened by one API replica and delivered by another's heartbeat needs a row both read —
-- `approvals` is a task's plan or merge decision with its own enum, and `run_commands`' `kind` check
-- admits no new value without a `contract` migration (TD-031 §14); and the SDK session mirror (TD-007)
-- has never had a production store at all (`session-mirror.ts` composes over a port nothing
-- implemented). 0098 is left to the TD-031 mint-retry ruling the orchestrator reserved it for.
--
-- **`run_tool_calls`** — one row per mutating platform tool call of a remote run, keyed by the run
-- and the SHA-256 of the SDK's `tool_use_id` (a digest, so the stored key is secret-free whatever a
-- worker sends). A row with `completed_at` null is a **claim**: a call is performing, or its process
-- died; the application takes over a claim older than five minutes, because the provider effect
-- under it is the executor's own idempotency (`open_mr:<task>:<branch>`). `result` is the answer the
-- model was given, already redacted by the run's redactor.
--
-- **`run_tool_approvals`** — one row per approval a remote run asked for, unique per `(run_id,
-- tool_use_digest)` so a retried open answers the same id; the decision is written once, and a
-- heartbeat stamps `delivered_at` when it hands the decision to the worker. The request's text is
-- not stored: it is the model's, and the port it is handed to decides in memory.
--
-- **`run_session_lines`** — the SDK session mirror of a remote run, one row per JSONL line at its
-- position, redacted on ingest (TD-031 §9); a retried upload is idempotent by position.
--
-- All three cascade with their run, so a purged task leaves nothing behind. **Additive** (TD-032
-- §1 and its 2026-11-04 amendment): three tables this file creates, their checks, their registry rows
-- (A), and every reference to an existing table states its `on delete` (B). The previous build never
-- names them.
create table run_tool_calls (
  run_id uuid not null references runs (id) on delete cascade,
  tool_use_digest text not null,
  tool_name text not null,
  input_digest text not null,
  lease_epoch integer not null,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  result jsonb,
  is_error boolean,
  redaction_count integer not null default 0,
  primary key (run_id, tool_use_digest),
  constraint run_tool_calls_digest_shape check (tool_use_digest ~ '^[0-9a-f]{64}$'),
  constraint run_tool_calls_input_digest_shape check (input_digest ~ '^[0-9a-f]{64}$'),
  constraint run_tool_calls_tool_name_shape check (length(tool_name) between 1 and 64),
  constraint run_tool_calls_epoch_positive check (lease_epoch > 0),
  constraint run_tool_calls_answer_with_completion check (
    (completed_at is null and result is null and is_error is null)
    or (completed_at is not null and result is not null and is_error is not null)
  ),
  constraint run_tool_calls_redaction_count_nonnegative check (redaction_count >= 0)
);

create table run_tool_approvals (
  id uuid primary key,
  run_id uuid not null references runs (id) on delete cascade,
  tool_use_digest text not null,
  tool_name text not null,
  lease_epoch integer not null,
  requested_at timestamptz not null default now(),
  decision text,
  reason text,
  question_id uuid references questions (id) on delete set null,
  decided_at timestamptz,
  delivered_at timestamptz,
  constraint run_tool_approvals_digest_shape check (tool_use_digest ~ '^[0-9a-f]{64}$'),
  constraint run_tool_approvals_tool_name_shape check (length(tool_name) between 1 and 256),
  constraint run_tool_approvals_epoch_positive check (lease_epoch > 0),
  constraint run_tool_approvals_decision_known check (decision in ('allow', 'deny')),
  constraint run_tool_approvals_decided_whole check (
    (decided_at is null and decision is null and reason is null)
    or (decided_at is not null and decision is not null and reason is not null)
  ),
  constraint run_tool_approvals_reason_bound check (length(reason) <= 4096),
  constraint run_tool_approvals_delivered_after_decision check (
    delivered_at is null or decided_at is not null
  )
);

create unique index run_tool_approvals_one_per_tool_use
  on run_tool_approvals (run_id, tool_use_digest);

-- A heartbeat's read: the run's decided approvals no heartbeat has delivered yet.
create index run_tool_approvals_undelivered_idx on run_tool_approvals (run_id)
  where decided_at is not null and delivered_at is null;

create table run_session_lines (
  run_id uuid not null references runs (id) on delete cascade,
  session_id text not null,
  line_no integer not null,
  line text not null,
  redaction_count integer not null default 0,
  created_at timestamptz not null default now(),
  primary key (run_id, session_id, line_no),
  constraint run_session_lines_session_shape check (length(session_id) between 1 and 256),
  constraint run_session_lines_line_no_nonnegative check (line_no >= 0),
  constraint run_session_lines_redaction_count_nonnegative check (redaction_count >= 0)
);

-- `read_write`: a claim is completed in place, a decision and its delivery are stamped in place;
-- the session mirror is insert-only but cascades with its run.
insert into platform_table_policy (table_name, app_access)
values
  ('run_tool_calls', 'read_write'),
  ('run_tool_approvals', 'read_write'),
  ('run_session_lines', 'read_write');

comment on table run_tool_calls is
  'A remote run''s mutating platform tool calls (WP-282, TD-031 §10b), keyed by the run and the SHA-256 of the SDK tool_use_id: a claim before the call, the redacted answer after it, so a retried call answers the stored answer and performs nothing.';

comment on table run_tool_approvals is
  'Tool approvals a remote run asked for (WP-282, TD-031 §9): the decision written once by the process that asked the ToolApprovalPort, delivered once on the run''s heartbeat (delivered_at).';

comment on table run_session_lines is
  'The SDK session mirror of a remote run (WP-282, TD-007, TD-031 §9): one row per JSONL line at its position, redacted on ingest, idempotent by position.';
