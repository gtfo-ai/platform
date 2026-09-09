-- 0008 — knowledge base, code map and reports (technical/03 § "Knowledge and code").
-- Everything here is derived and rebuildable, and carries the commit it was built from.

create table kb_documents (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  path text not null,
  commit_sha text,
  -- type/kind/status/scope are the knowledge front-matter vocabulary; WP-16 and WP-18 own the
  -- value sets, so they stay text here.
  type text,
  kind text,
  status text,
  confidence real,
  scope text,
  paths text[] not null default '{}',
  "trigger" text,
  expires date,
  last_confirmed date,
  frontmatter jsonb not null default '{}'::jsonb,
  content_hash text,
  tokens integer not null default 0,
  updated_at timestamptz not null default now(),
  unique (project_id, path),
  constraint kb_documents_confidence_range check (confidence is null or confidence between 0 and 1)
);

create index kb_documents_paths_idx on kb_documents using gin (paths);
create index kb_documents_project_idx on kb_documents (project_id);

create table kb_chunks (
  id uuid primary key default uuidv7(),
  document_id uuid not null references kb_documents (id) on delete cascade,
  heading_path text,
  ordinal integer not null default 0,
  "text" text not null,
  tokens integer not null default 0,
  -- Phase 1 is lexical only (TD-008). The 'simple' configuration matches run_messages: no
  -- stemming, so identifiers and code fragments survive.
  -- Phase 2 adds `embedding halfvec(1024)` plus an HNSW index; that needs the pgvector extension
  -- and therefore a custom image (TD-006), so it lands with the phase-2 migration, not here.
  search tsvector generated always as (to_tsvector('simple', "text")) stored,
  unique (document_id, ordinal)
);

create index kb_chunks_search_idx on kb_chunks using gin (search);

create table kb_links (
  from_document_id uuid not null references kb_documents (id) on delete cascade,
  to_path text not null,
  kind text not null,
  resolved_document_id uuid references kb_documents (id) on delete set null,
  primary key (from_document_id, to_path, kind)
);

create index kb_links_resolved_idx on kb_links (resolved_document_id);

create table kb_proposals (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  task_id uuid references tasks (id) on delete set null,
  run_id uuid references runs (id) on delete set null,
  source knowledge_proposal_source not null,
  kind knowledge_proposal_kind not null,
  type knowledge_proposal_type not null,
  target_path text not null,
  delta text not null,
  evidence jsonb not null default '[]'::jsonb,
  significance real not null,
  status knowledge_proposal_status not null default 'scored',
  decided_by uuid references users (id) on delete set null,
  decided_at timestamptz,
  applied_commit_sha text,
  created_at timestamptz not null default now(),
  constraint kb_proposals_significance_range check (significance between 0 and 1)
);

create index kb_proposals_project_status_idx on kb_proposals (project_id, status, created_at desc);

create table kb_index_state (
  project_id uuid primary key references projects (id) on delete cascade,
  commit_sha text,
  fts_built_at timestamptz,
  embeddings_built_at timestamptz,
  embedding_model text
);

create table code_files (
  project_id uuid not null references projects (id) on delete cascade,
  blob_sha text not null,
  path text not null,
  language text,
  symbols jsonb not null default '[]'::jsonb,
  primary key (project_id, blob_sha)
);

create index code_files_project_path_idx on code_files (project_id, path);

create table code_maps (
  project_id uuid not null references projects (id) on delete cascade,
  commit_sha text not null,
  focus_hash text not null,
  token_budget integer not null,
  map_text text not null,
  created_at timestamptz not null default now(),
  primary key (project_id, commit_sha, focus_hash)
);

create table readiness_evaluations (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  level smallint not null,
  criteria jsonb not null default '[]'::jsonb,
  evaluated_at timestamptz not null default now(),
  source text not null,
  constraint readiness_evaluations_level_range check (level between 0 and 5)
);

create index readiness_evaluations_project_idx
  on readiness_evaluations (project_id, evaluated_at desc);

create table shadow_reports (
  task_id uuid primary key references tasks (id) on delete cascade,
  human_mr_ref jsonb,
  comparison jsonb not null,
  created_at timestamptz not null default now()
);
