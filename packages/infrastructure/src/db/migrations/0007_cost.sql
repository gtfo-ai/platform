-- 0007 — cost ledger, price list, rollups and governance
-- (technical/03 § "Cost and governance", BD-011).

-- Prices are USD per million tokens. Rows are superseded rather than edited: a new price gets a
-- new row and the previous row's effective_to is closed. That single UPDATE is why the table is
-- not registered append-only, even though technical/03 calls it "never mutated".
create table price_list (
  id uuid primary key default uuidv7(),
  model_id text not null,
  effective_from timestamptz not null,
  effective_to timestamptz,
  input numeric(12, 6) not null,
  output numeric(12, 6) not null,
  cache_write_5m numeric(12, 6) not null,
  cache_write_1h numeric(12, 6) not null,
  cache_read numeric(12, 6) not null,
  batch_multiplier numeric(6, 4) not null default 0.5,
  fast_input numeric(12, 6),
  fast_output numeric(12, 6),
  source_url text not null,
  verified_at timestamptz not null,
  created_at timestamptz not null default now(),
  unique (model_id, effective_from),
  constraint price_list_window_ordered check (effective_to is null or effective_to > effective_from)
);

create index price_list_lookup_idx on price_list (model_id, effective_from desc);

alter table runs
  add constraint runs_price_list_id_fkey
  foreign key (price_list_id) references price_list (id) on delete set null;

-- Append-only ledger: one row per run per model (technical/03).
create table cost_entries (
  id uuid not null default uuidv7(),
  run_id uuid not null references runs (id),
  task_id uuid not null references tasks (id),
  project_id uuid not null references projects (id),
  stage text not null,
  model text not null,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_write_5m bigint not null default 0,
  cache_write_1h bigint not null default 0,
  cache_read bigint not null default 0,
  usd numeric(12, 6) not null,
  is_estimate boolean not null default false,
  price_list_id uuid references price_list (id),
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

create index cost_entries_run_idx on cost_entries (run_id);
create index cost_entries_project_created_at_idx on cost_entries (project_id, created_at desc);
create index cost_entries_task_idx on cost_entries (task_id);

-- Rollup written with INSERT … ON CONFLICT DO UPDATE when a run finishes, and recomputed nightly
-- for the previous day (technical/03).
create table cost_rollup_daily (
  org_id uuid not null references organizations (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  template text not null,
  stage text not null,
  model text not null,
  day date not null,
  mode cost_mode not null,
  runs integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  cache_write_5m bigint not null default 0,
  cache_write_1h bigint not null default 0,
  cache_read bigint not null default 0,
  usd numeric(14, 6) not null default 0,
  wall_ms bigint not null default 0,
  turns integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, day, template, stage, model, mode)
);

create index cost_rollup_daily_org_day_idx on cost_rollup_daily (org_id, day desc);

create table budgets (
  id uuid primary key default uuidv7(),
  scope budget_scope not null,
  -- Null for the organisation scope, which has exactly one subject.
  scope_id uuid,
  -- Quoted: WINDOW is a reserved word in PostgreSQL.
  "window" budget_window not null,
  limit_usd numeric(12, 6) not null,
  notify_pct integer[] not null default '{50,80,100}',
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint budgets_limit_positive check (limit_usd > 0),
  -- NULLS NOT DISTINCT so the single org-scoped budget per window cannot be inserted twice.
  unique nulls not distinct (scope, scope_id, "window")
);

-- Projection over the cost ledger; rebuildable (technical/03).
create table budget_windows (
  budget_id uuid not null references budgets (id) on delete cascade,
  window_start timestamptz not null,
  spent_usd numeric(14, 6) not null default 0,
  notified_pct integer[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (budget_id, window_start)
);

-- Derived from events by a projector (technical/03, product/19 § human time).
create table human_time_entries (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  kind human_time_kind not null,
  user_id uuid references users (id) on delete set null,
  started_at timestamptz not null,
  ended_at timestamptz,
  minutes numeric(10, 2),
  created_at timestamptz not null default now()
);

create index human_time_entries_task_idx on human_time_entries (task_id);
create index human_time_entries_user_idx on human_time_entries (user_id, started_at desc);

-- Append-only audit of every call in and out of an integration (technical/03, technical/06).
-- Payload and result are redacted before they are written (TD-012).
create table integration_actions (
  id uuid not null default uuidv7(),
  integration_id uuid not null references integrations (id),
  task_id uuid references tasks (id),
  direction integration_direction not null,
  action text not null,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  status text not null,
  duration_ms integer,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

create index integration_actions_integration_idx
  on integration_actions (integration_id, created_at desc);
create index integration_actions_task_idx on integration_actions (task_id, created_at desc);

insert into platform_table_policy (table_name, app_access, partition_column)
values
  ('cost_entries', 'append_only', 'created_at'),
  ('integration_actions', 'append_only', 'created_at');
