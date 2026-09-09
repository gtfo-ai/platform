# 03 — Data model and storage

> Round 2 design. Decisions: TD-005 (event store), TD-006 (PostgreSQL 18), TD-007 (transcripts as partitioned rows), TD-011 (Drizzle), TD-012 (redaction). Evidence: research/07, research/06.

## Principles
- **PostgreSQL 18 is the only database.** Events, state, transcripts, cost, audit, KB indexes, jobs — one backup, one restore, one `DATABASE_URL`.
- **Append-only where the audit demands it** (`events`, `run_messages`, `cost_entries`, `integration_actions`, `config_audit`, `redaction_log`): `REVOKE UPDATE, DELETE` from the application role; partition by month; purge only by dropping partitions and only when the operator configures a retention window (default: never — Q13).
- **Typed columns for anything filtered or aggregated; JSONB only for opaque payloads.** Never keep mutable status or counters inside a large JSONB document (TOAST rewrite cost).
- **`uuidv7()` primary keys** (time-ordered, PG 18 built-in) on all entity tables.
- **Derived data is rebuildable** (KB index rows, code maps, rollups) and carries the commit/model/price-list version it was built from.

## Schema (logical; DDL written by the implementer with Drizzle + hand-written SQL migrations for partitions, GIN, generated columns)

### Identity and configuration
- `organizations(id, name, timezone, settings jsonb, created_at, updated_at)` — one row.
- `users(id, email unique, name, role enum(admin|maintainer|member|viewer), password_hash nullable, status, created_at)`; `sessions(id, user_id, expires_at, …)`.
- `user_identities(user_id, provider, external_id, email, display_name)` — PK `(provider, external_id)`.
- `projects(id, org_id, key unique, name, repo_url, default_branch, agentic_dir, knowledge_dir, config jsonb, config_source jsonb, config_hash, autonomy_level, readiness_level, status, created_at, updated_at)`.
- `project_members(project_id, user_id, role)`.
- `integrations(id, org_id, type, provider, name, config jsonb, secret_ids uuid[], health jsonb, created_at, updated_at)`; `bindings(id, project_id, integration_id, config jsonb)`.
- `secrets(id, ciphertext bytea, key_id, created_at, rotated_at)` — encrypted with `APP_SECRET_KEY` (envelope); never joined into API responses.
- `config_audit(id, entity_type, entity_id, user_id, diff jsonb, created_at)` — append-only; secret values appear as `"changed"`.

### Pipeline
- `tasks(id, project_id, ticket_provider, ticket_key, ticket_url, template, mode enum(normal|shadow), state, current_stage, size, priority, requested_by_user_id, requested_by_identity jsonb, template_snapshot jsonb, config_snapshot_hash, branch, mr_ref jsonb, workpad_ref jsonb, iteration_counters jsonb, cost_actual numeric(12,6), cost_estimated numeric(12,6), estimate_usd numeric(12,6), risk_classes text[], blocked_by text[], created_at, updated_at, completed_at)` — idx `(project_id, state)`, `(project_id, created_at)`, `UNIQUE(project_id, ticket_key, mode)`.
- `task_stages(id, task_id, stage, attempt, state, entered_at, exited_at, outcome, return_reason, caused_by_event_id)`.
- `runs(id, task_id, task_stage_id, project_id, role, mode, attempt, run_key, session_id, model, effort, permission_mode, provider_mode, prompt_version, system_prompt text, user_prompt text, settings_snapshot jsonb, settings_hash, allowed_tools text[], disallowed_tools text[], mcp_servers jsonb, skills text[], status, terminal_reason, exit_detail jsonb, started_at, ended_at, last_output_at, lease_owner, lease_expires_at, num_turns, input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens, usd_reported numeric(12,6) null, usd_estimated numeric(12,6), price_list_id, wall_ms, redaction_count, created_at)` — idx `(task_id)`, `(project_id, started_at)`, `(status) WHERE status IN ('queued','running')`, `UNIQUE(run_key)` for memoisation.
- `run_model_usage(run_id, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read, usd_estimated)` PK `(run_id, model)`.
- `run_context_pack(run_id, tier smallint, source_path, reason, score real, tokens int, validated bool, kb_commit_sha)` PK `(run_id, source_path)`.
- `artifacts(id, task_id, type, version int, markdown text, data jsonb, schema_version, produced_by_run_id, created_at)` — `UNIQUE(task_id, type, version)`.
- `questions(id, task_id, task_stage_id, run_id, text, options jsonb, blocking bool, status, asked_at, deadline_at, reminders_sent int, answer text, answered_by_user_id, answered_via, answered_at, escalated_at)` — idx `(status, deadline_at)`.
- `approvals(id, task_id, kind, status, requested_at, deadline_at, decided_by_user_id, decided_at, reason)`.
- `workspaces(id, task_id, runner_id, path, status, base_commit, disk_bytes, retention_until, exported_blob_id, created_at, destroyed_at)`.
- `human_actions(id, task_id, user_id, action, params jsonb, created_at)` — append-only.

### Event log and jobs
- `events(position bigint generated always as identity, stream_type, stream_id uuid, stream_seq int, type, payload jsonb, actor jsonb, cause_event_position bigint null, correlation_id uuid, occurred_at timestamptz, xact_id xid8 default pg_current_xact_id())` — **partitioned by range on `occurred_at` (monthly)**; PK `(occurred_at, position)`; `UNIQUE(stream_type, stream_id, stream_seq)`; idx `(type, occurred_at)`, `(correlation_id)`. Append-only. Consumers track per-stream `stream_seq` or fence on `pg_snapshot_xmin(pg_current_snapshot())` (research/07: global position is not gapless).
- `handler_executions(event_position, handler, priority, status, attempts, error, started_at, finished_at)` PK `(event_position, handler)` — idempotency guard for the dispatcher.
- `inbox(provider, delivery_id, integration_id, received_at, headers jsonb, payload jsonb, processed_at, error)` PK `(provider, delivery_id)` — webhook dedup and raw audit.
- `pgboss.*` — pg-boss's own schema (jobs, timers, cron) in the same database (TD-004).

### Transcripts
- `run_messages(run_id uuid, seq int, created_at timestamptz, kind enum(system|assistant|user|result|stream_block|hook|steer|compaction), subtype text, parent_tool_use_id text null, tool_use_id text null, tool_name text null, payload jsonb, blob_id uuid null, search_text text, search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(search_text,''))) STORED, size_bytes int, redaction_count int)` — PK `(run_id, seq)` with partition key `created_at` included; **monthly range partitions**; GIN on `search` per partition; partial idx `(run_id) WHERE tool_use_id IS NOT NULL`.
- Rule: one row per completed SDK message (assistant, user/tool-result, system, result) plus one coalesced `stream_block` row per content block with `first_delta_at/last_delta_at` in payload; partial deltas are never stored individually. Payloads > 1 MB go to `blobs`.
- `blobs(id, sha256, size, media_type, storage enum(db|file|s3), locator text, data bytea null, created_at)`.
- `redaction_log(run_id, seq, rule_id, created_at)` append-only.

### Cost and governance
- `cost_entries(id, run_id, task_id, project_id, stage, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read, usd numeric(12,6), is_estimate bool, price_list_id, created_at)` — append-only ledger (one per run per model).
- `price_list(id, model_id, effective_from, effective_to null, input, output, cache_write_5m, cache_write_1h, cache_read, batch_multiplier, fast_input null, fast_output null, source_url, verified_at)` — never mutated; pick the row with `effective_from <= run.started_at`.
- `cost_rollup_daily(org_id, project_id, template, stage, model, day date, mode enum(actual|estimated), runs, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read, usd numeric(14,6), wall_ms bigint, turns int)` PK `(project_id, day, template, stage, model, mode)` — `INSERT … ON CONFLICT DO UPDATE` on run finish; nightly recompute of yesterday.
- `budgets(id, scope, scope_id, window, limit_usd, notify_pct int[], created_by, updated_at)`; `budget_windows(budget_id, window_start, spent_usd, notified_pct int[])` projection.
- `human_time_entries(task_id, kind enum(review|question|approval), user_id null, started_at, ended_at, minutes)` derived from events by a projector.
- `integration_actions(id, integration_id, task_id null, direction enum(in|out), action, payload jsonb, result jsonb, status, duration_ms, created_at)` append-only.

### Knowledge and code (derived; rebuildable)
- `kb_documents(id, project_id, path, commit_sha, type, kind, status, confidence, scope, paths text[], trigger text, expires date null, last_confirmed date null, frontmatter jsonb, content_hash, tokens int, updated_at)` — `UNIQUE(project_id, path)`; GIN on `paths`.
- `kb_chunks(id, document_id, heading_path text, ordinal int, text, tokens, search tsvector STORED, embedding halfvec(1024) null, embedding_model text null)` — GIN on `search`; HNSW on `embedding` (phase 2, pgvector).
- `kb_links(from_document_id, to_path, resolved_document_id null, kind)`.
- `kb_proposals(id, project_id, task_id null, run_id null, source, kind, type, target_path, delta text, evidence jsonb, significance real, status, decided_by, decided_at, applied_commit_sha null, created_at)`.
- `kb_index_state(project_id, commit_sha, fts_built_at, embeddings_built_at, embedding_model)`.
- `code_files(project_id, blob_sha, path, language, symbols jsonb)` PK `(project_id, blob_sha)`; `code_maps(project_id, commit_sha, focus_hash, token_budget, map_text, created_at)`.
- `readiness_evaluations(id, project_id, level, criteria jsonb, evaluated_at, source)`.
- `shadow_reports(task_id, human_mr_ref jsonb, comparison jsonb, created_at)`.

## Storage sizing (from research/07 measurements)
~1–2 MB and 1–3 k rows per run; 1 000 runs/month ≈ 2 GB and 3 M rows/month. Partitioning from day 1; storage gauge = `pg_total_relation_size('run_messages')` on the org dashboard (Q13-b).

## Retention and backups
- Default keep forever. Optional `APP_TRANSCRIPT_RETENTION_DAYS` drops whole `run_messages` partitions older than N days; metadata, artifacts, events, cost stay.
- Compose ships a `db-backup` sidecar (`pg_dump` daily/weekly/monthly rotation) with a documented restore; pgBackRest/WAL-G as a later profile.
- Docker: mount `/var/lib/postgresql` (not `/data`) for the `postgres:18` image (research/07 gotcha).

## Redaction (TD-012)
Single persistence path function applied to `run_messages`, `integration_actions`, `events.payload`, `config_audit`: (1) exact match of every secret value the platform injected into the run, (2) regex rules derived from gitleaks' rule set (generic API keys, private keys, cloud/provider tokens, JWTs, connection strings), (3) optional entropy heuristic; placeholders `[REDACTED sha256:ab12cd]`; counts and `redaction_log` rows; originals never stored.
