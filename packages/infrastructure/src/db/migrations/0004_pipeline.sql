-- 0004 — pipeline aggregates (technical/03 § "Pipeline").

create table tasks (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  ticket_provider text not null,
  ticket_key text not null,
  ticket_url text not null,
  -- Template and stage ids are slugs, not enums: `.agentic/pipeline.yml` may define more
  -- (technical/12).
  template text not null,
  mode task_mode not null default 'normal',
  state task_state not null default 'queued',
  current_stage text,
  size task_size,
  -- The provider's own priority label ("High"), not a platform scale.
  priority text,
  requested_by_user_id uuid references users (id) on delete set null,
  requested_by_identity jsonb,
  template_snapshot jsonb,
  config_snapshot_hash text,
  branch text,
  mr_ref jsonb,
  workpad_ref jsonb,
  iteration_counters jsonb not null default '{}'::jsonb,
  cost_actual numeric(12, 6) not null default 0,
  cost_estimated numeric(12, 6) not null default 0,
  estimate_usd numeric(12, 6),
  risk_classes text[] not null default '{}',
  blocked_by text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (project_id, ticket_key, mode)
);

create index tasks_project_state_idx on tasks (project_id, state);
create index tasks_project_created_at_idx on tasks (project_id, created_at desc);

create table task_stages (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  stage text not null,
  attempt integer not null default 1,
  -- State, outcome and return reason are free-form until WP-15 fixes the interpreter's vocabulary.
  state text not null,
  entered_at timestamptz not null default now(),
  exited_at timestamptz,
  outcome text,
  return_reason text,
  caused_by_event_id uuid,
  constraint task_stages_attempt_positive check (attempt >= 1),
  unique (task_id, stage, attempt)
);

create index task_stages_task_id_entered_at_idx on task_stages (task_id, entered_at);

create table runs (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  task_stage_id uuid references task_stages (id) on delete set null,
  project_id uuid not null references projects (id) on delete cascade,
  role agent_role not null,
  mode run_mode not null default 'normal',
  attempt integer not null default 1,
  -- Memoisation key: the same spec must never be executed twice (technical/03).
  run_key text,
  session_id text,
  model text not null,
  effort effort not null default 'high',
  -- Agent SDK permission mode; the SDK owns the value set (technical/04).
  permission_mode text,
  provider_mode provider_mode not null default 'api',
  prompt_version text not null,
  system_prompt text,
  user_prompt text,
  settings_snapshot jsonb not null default '{}'::jsonb,
  settings_hash text,
  allowed_tools text[] not null default '{}',
  disallowed_tools text[] not null default '{}',
  mcp_servers jsonb not null default '{}'::jsonb,
  skills text[] not null default '{}',
  status run_status not null default 'created',
  terminal_reason run_terminal_reason,
  exit_detail jsonb,
  started_at timestamptz,
  ended_at timestamptz,
  last_output_at timestamptz,
  -- Lease held by the worker currently driving the run (TD-003).
  lease_owner text,
  lease_expires_at timestamptz,
  num_turns integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_write_5m_tokens bigint not null default 0,
  cache_write_1h_tokens bigint not null default 0,
  cache_read_tokens bigint not null default 0,
  -- Provider-reported cost is the truth; the estimate is what the price list says (BD-011).
  usd_reported numeric(12, 6),
  usd_estimated numeric(12, 6) not null default 0,
  price_list_id uuid,
  wall_ms bigint not null default 0,
  redaction_count integer not null default 0,
  created_at timestamptz not null default now(),
  constraint runs_attempt_positive check (attempt >= 1),
  unique (run_key)
);

create index runs_task_id_idx on runs (task_id);
create index runs_project_started_at_idx on runs (project_id, started_at desc);
create index runs_active_idx on runs (status) where status in ('created', 'starting', 'running');

create table run_model_usage (
  run_id uuid not null references runs (id) on delete cascade,
  model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_write_5m bigint not null default 0,
  cache_write_1h bigint not null default 0,
  cache_read bigint not null default 0,
  usd_estimated numeric(12, 6) not null default 0,
  primary key (run_id, model)
);

create table run_context_pack (
  run_id uuid not null references runs (id) on delete cascade,
  tier smallint not null,
  source_path text not null,
  reason context_pack_reason,
  score real,
  tokens integer not null default 0,
  validated boolean not null default true,
  kb_commit_sha text,
  primary key (run_id, source_path),
  constraint run_context_pack_tier_range check (tier between 0 and 9)
);

create table artifacts (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  type artifact_type not null,
  version integer not null default 1,
  markdown text,
  data jsonb not null,
  schema_version text not null,
  produced_by_run_id uuid references runs (id) on delete set null,
  created_at timestamptz not null default now(),
  constraint artifacts_version_positive check (version >= 1),
  unique (task_id, type, version)
);

create index artifacts_task_id_idx on artifacts (task_id);

create table questions (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  task_stage_id uuid references task_stages (id) on delete set null,
  run_id uuid references runs (id) on delete set null,
  -- Agent-authored text. Rendered, never executed (BD-022).
  text text not null,
  options jsonb,
  blocking boolean not null default true,
  status question_status not null default 'open',
  asked_at timestamptz not null default now(),
  deadline_at timestamptz,
  reminders_sent integer not null default 0,
  answer text,
  answered_by_user_id uuid references users (id) on delete set null,
  answered_via answer_channel,
  answered_at timestamptz,
  escalated_at timestamptz
);

create index questions_task_id_idx on questions (task_id);
create index questions_status_deadline_idx on questions (status, deadline_at);

create table approvals (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  kind approval_kind not null,
  status approval_status not null default 'pending',
  requested_at timestamptz not null default now(),
  deadline_at timestamptz,
  decided_by_user_id uuid references users (id) on delete set null,
  decided_at timestamptz,
  reason text
);

create index approvals_task_id_idx on approvals (task_id);
create index approvals_status_deadline_idx on approvals (status, deadline_at);

create table workspaces (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  runner_id text,
  path text not null,
  status workspace_status not null default 'provisioning',
  base_commit text,
  disk_bytes bigint,
  retention_until timestamptz,
  exported_blob_id uuid,
  created_at timestamptz not null default now(),
  destroyed_at timestamptz
);

create index workspaces_task_id_idx on workspaces (task_id);
create index workspaces_retention_idx on workspaces (retention_until) where destroyed_at is null;

-- Append-only: every human action on a task is auditable (technical/03, technical/08).
create table human_actions (
  id uuid primary key default uuidv7(),
  task_id uuid references tasks (id) on delete cascade,
  user_id uuid references users (id) on delete set null,
  action text not null,
  params jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index human_actions_task_id_idx on human_actions (task_id, created_at desc);

insert into platform_table_policy (table_name, app_access)
values ('human_actions', 'append_only');
