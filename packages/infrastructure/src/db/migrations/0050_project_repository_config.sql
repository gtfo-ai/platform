-- 0050 — the repository layer of the effective configuration (WP-63, PROGRESS backlog 44, Q94).
--
-- technical/12's `effective = merge(defaults, org, project, repo)` had no producer for `repo`: the
-- platform never read a repository's own `.agentic/config.yml` back. This table is the last reading
-- of that file on the project's **default branch** (BD-025 §1), written by
-- `refreshRepositoryConfig` (`packages/application/src/config/repository-config.ts`) after every
-- knowledge index run — pinned to the commit that run read — and by
-- `POST /api/projects/:project_id/config/refresh`. It is read by the pipeline's settings port and by
-- `GET /api/projects/:project_id/config`.
--
-- **One row per project, replaced on every reading.** It is derived state (BD-012): the file on the
-- default branch is the truth and a re-read rebuilds the row, so there is no history here — the
-- repository's own history is the history.
--
-- Three statuses, and `unread` is the **absence of a row**, not a fourth value:
--   `absent`  — the default branch has no such file (a legitimate project);
--   `valid`   — it parsed; `config` is the file minus `version` and minus what `not_applied` names
--               (`policies.autonomy` — the dial is moved in the platform, BD-027:14);
--   `invalid` — it did not; `detail` names the key paths, redacted and bounded, and every run of the
--               project is refused until a later reading is not `invalid` (WP-63 criterion 4).
--
-- A reading that could not reach the repository writes **nothing**, so a row always describes a
-- commit that was actually read (TD-026 decision 4's rule, one table over).
create table project_repository_config (
  project_id uuid primary key references projects (id) on delete cascade,
  status text not null,
  commit_sha text not null,
  config jsonb,
  not_applied jsonb not null default '[]'::jsonb,
  detail text,
  read_at timestamptz not null,
  constraint project_repository_config_status_known check (
    status in ('absent', 'valid', 'invalid')
  ),
  -- The values exist exactly when the file parsed, and a refusal always says why.
  constraint project_repository_config_valid_has_config check ((status = 'valid') = (config is not null)),
  constraint project_repository_config_invalid_has_detail check (
    (status = 'invalid') = (detail is not null)
  ),
  -- `MAX_REPOSITORY_CONFIG_DETAIL_CHARS`: a list of key paths, not a document.
  constraint project_repository_config_detail_bounded check (
    detail is null or char_length(detail) <= 600
  ),
  constraint project_repository_config_commit_is_sha check (commit_sha ~ '^[0-9a-f]{7,64}$')
);

insert into platform_table_policy (table_name, app_access)
values ('project_repository_config', 'read_write');
