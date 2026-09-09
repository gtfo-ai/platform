-- 0003 — identity and configuration (technical/03 § "Identity and configuration").

create table organizations (
  id uuid primary key default uuidv7(),
  name text not null,
  timezone text not null default 'UTC',
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table organizations is 'Exactly one row per instance (BD-009).';

create table users (
  id uuid primary key default uuidv7(),
  email text not null unique,
  name text not null,
  role user_role not null default 'member',
  -- Null for an account that only authenticates through an external identity.
  password_hash text,
  -- Free-form until WP-06 chooses the account lifecycle (Better Auth, TD-022).
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Sessions are a placeholder shape: WP-06 introduces Better Auth (TD-022) and owns the columns it
-- needs. Only what technical/03 names is created here.
create table sessions (
  id uuid primary key default uuidv7(),
  user_id uuid not null references users (id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index sessions_user_id_idx on sessions (user_id);
create index sessions_expires_at_idx on sessions (expires_at);

create table user_identities (
  provider text not null,
  external_id text not null,
  user_id uuid not null references users (id) on delete cascade,
  email text,
  display_name text,
  created_at timestamptz not null default now(),
  primary key (provider, external_id)
);

comment on table user_identities is
  'External identities mapped to platform users by email (BD-006). Unmapped authors are recorded, never acted on (BD-022).';

create index user_identities_user_id_idx on user_identities (user_id);

create table projects (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations (id) on delete restrict,
  key text not null unique,
  name text not null,
  repo_url text not null,
  default_branch text not null default 'main',
  agentic_dir text not null default '.agentic',
  knowledge_dir text not null default '.agentic/knowledge',
  -- Effective configuration and, per key, which layer of the precedence chain produced it
  -- (technical/12 § "Effective configuration").
  config jsonb not null default '{}'::jsonb,
  config_source jsonb not null default '{}'::jsonb,
  config_hash text,
  autonomy_level autonomy_level not null default 'supervised',
  readiness_level smallint not null default 0,
  status project_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint projects_readiness_level_range check (readiness_level between 0 and 5)
);

create index projects_org_id_idx on projects (org_id);

create table project_members (
  project_id uuid not null references projects (id) on delete cascade,
  user_id uuid not null references users (id) on delete cascade,
  role user_role not null default 'member',
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

create index project_members_user_id_idx on project_members (user_id);

create table secrets (
  id uuid primary key default uuidv7(),
  -- Envelope-encrypted with APP_SECRET_KEY; never joined into an API response (technical/03).
  ciphertext bytea not null,
  key_id text not null,
  created_at timestamptz not null default now(),
  rotated_at timestamptz
);

create table integrations (
  id uuid primary key default uuidv7(),
  org_id uuid not null references organizations (id) on delete cascade,
  type integration_type not null,
  provider text not null,
  name text not null,
  config jsonb not null default '{}'::jsonb,
  secret_ids uuid[] not null default '{}',
  health jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, type, name)
);

create index integrations_org_id_type_idx on integrations (org_id, type);

create table bindings (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  integration_id uuid not null references integrations (id) on delete cascade,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, integration_id)
);

create index bindings_integration_id_idx on bindings (integration_id);

-- Append-only, monthly partitions. Secret values appear as the literal "changed" (technical/03).
create table config_audit (
  id uuid not null default uuidv7(),
  entity_type text not null,
  entity_id uuid,
  user_id uuid references users (id) on delete set null,
  diff jsonb not null,
  created_at timestamptz not null default now(),
  primary key (id, created_at)
) partition by range (created_at);

create index config_audit_entity_idx on config_audit (entity_type, entity_id, created_at desc);
create index config_audit_created_at_idx on config_audit (created_at desc);

insert into platform_table_policy (table_name, app_access, partition_column)
values ('config_audit', 'append_only', 'created_at');
