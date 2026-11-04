-- migration-class: additive
-- 0097 — `project_execution_settings` and `server_claimants`: where a project's agent runs execute,
-- and whether this core has a server claimant at all (WP-278, TD-031 decision 8, BD-032 decisions 3
-- and 5).
--
-- **`project_execution_settings`** is one row per project an administrator configured through
-- `PUT /api/projects/:id/execution` (`project.settings.write`). It is **in the database, never in
-- `.agentic/config.yml`**: where code runs and whose subscription pays is an administrator's choice
-- that a pushed commit must not change (BD-025's config-trust reasoning), so the repository file's
-- strict schema refuses an `execution` key by name. **No row is the defaults** of TD-031 §8:
-- `hybrid`, `prefer: server`, `assignee_window` 120 s, `offer_timeout` 24 h. `fallback_after_seconds`
-- null is *the default for the preference* — 15 s when the server is preferred, 5 min when workers
-- are — so a project that flips its preference gets the other default rather than keeping the first
-- one's number. The durations are whole seconds (TD-031 writes `15s`, `5m`, `120s`, `24h`); a
-- `durationSchema` string has no seconds unit, and an integer has one reading. The audit is the
-- `human_actions` row the write leaves, so the table carries no `updated_by`.
--
-- **`server_claimants`** is one row per process running the server claimant
-- (`packages/application/src/pipeline/claimant.ts`), renewed on its poll and deleted when it stops,
-- fresh while `expires_at > now()` — both halves on the database's clock, the shape
-- `held_connection_liveness` (0054) set. It answers TD-031 §8's *"a core with no claimant composed
-- for the server"* for the **instance**: the process that writes an offer is any worker, and in the
-- compose topology the `app` process plans and offers while only the `runner` process claims, so a
-- process's own configuration cannot answer it. A holder that dies leaves its row to expire; a
-- renewal deletes rows expired for more than a day, so the table is bounded by the live processes.
--
-- **Additive** (TD-032 §1 and its 2026-11-04 amendment): two tables this file creates, with their
-- checks and registry rows (A), and the one reference to an existing table states `on delete
-- cascade` (B). The previous build never names either table.
create table project_execution_settings (
  project_id uuid primary key references projects (id) on delete cascade,
  mode text not null default 'hybrid',
  prefer text not null default 'server',
  -- Null: the default for `prefer` (15 s for `server`, 300 s for `workers`).
  fallback_after_seconds integer,
  assignee_window_seconds integer not null default 120,
  offer_timeout_seconds integer not null default 86400,
  updated_at timestamptz not null default now(),
  constraint project_execution_settings_mode_known
    check (mode in ('server_only', 'workers_only', 'hybrid')),
  constraint project_execution_settings_prefer_known check (prefer in ('server', 'workers')),
  constraint project_execution_settings_fallback_bounds
    check (fallback_after_seconds between 0 and 86400),
  constraint project_execution_settings_assignee_window_bounds
    check (assignee_window_seconds between 0 and 3600),
  constraint project_execution_settings_offer_timeout_bounds
    check (offer_timeout_seconds between 60 and 2592000)
);

create table server_claimants (
  holder text primary key,
  renewed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  constraint server_claimants_holder_shape check (length(holder) between 1 and 200),
  constraint server_claimants_expires_after_renewal check (expires_at > renewed_at)
);

-- `read_write`: an administrator's row is replaced in place; a claimant's row is renewed in place
-- and deleted by its holder.
insert into platform_table_policy (table_name, app_access)
values ('project_execution_settings', 'read_write'), ('server_claimants', 'read_write');

-- The expiry recovery's scan (TD-031 §1): open offers past their `expires_at`.
create index run_offers_open_expiry_idx on run_offers (expires_at)
  where state = 'open' and expires_at is not null;

comment on table project_execution_settings is
  'Where a project''s agent runs execute (WP-278, TD-031 decision 8): mode, preference, fallback, the assignee''s head start and the offer timeout. Written only through the project settings API by an administrator; no row is the defaults. Never in .agentic/config.yml.';

comment on table server_claimants is
  'One row per process running the server claimant (WP-278, TD-031 decision 8), renewed on its poll, deleted when it stops; fresh while expires_at > now(). Whether the instance has a server claimant at offer time.';
