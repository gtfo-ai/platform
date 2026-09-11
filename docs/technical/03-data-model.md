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
- `secrets(id, ciphertext bytea, key_id, created_at, rotated_at)` — encrypted with `APP_SECRET_KEY` (envelope); never joined into API responses. **One row is one credential**, and its plaintext is the JSON document `{"field", "value"}` — the provider config field the value belongs to travels *with* it, because `integrations.secret_ids` is a `uuid[]` with no names in it and an operator reordering that array must not be able to swap a webhook secret for an API token (WP-15a, `packages/infrastructure/src/secrets/postgres-secret-store.ts`). The envelope is a per-row AES-256-GCM data key wrapped under a key derived from `APP_SECRET_KEY` by HKDF; `key_id` is a fingerprint of the *derived* key, so a half-finished rotation is a readable state rather than a corrupt one, and a row sealed under another key is refused by name rather than reported as a bad tag.
- `config_audit(id, entity_type, entity_id, user_id, diff jsonb, created_at)` — append-only; secret values appear as `"changed"`.

### Pipeline
- `tasks(id, project_id, ticket_provider, ticket_key, ticket_url, template, mode enum(normal|shadow), state, current_stage, size, priority, requested_by_user_id, requested_by_identity jsonb, template_snapshot jsonb, config_snapshot_hash, branch, mr_ref jsonb, workpad_ref jsonb, iteration_counters jsonb, cost_actual numeric(12,6), cost_estimated numeric(12,6), estimate_usd numeric(12,6), risk_classes text[], blocked_by text[], created_at, updated_at, completed_at)` — idx `(project_id, state)`, `(project_id, created_at)`, `UNIQUE(project_id, ticket_key, mode)`.
- `task_stages(id, task_id, stage, attempt, state, entered_at, exited_at, outcome, return_reason, caused_by_event_id)`.
- `runs(id, task_id, task_stage_id, project_id, role, mode, attempt, run_key, session_id, model, effort, permission_mode, provider_mode, prompt_version, system_prompt text, user_prompt text, settings_snapshot jsonb, settings_hash, allowed_tools text[], disallowed_tools text[], mcp_servers jsonb, skills text[], status, terminal_reason, exit_detail jsonb, started_at, ended_at, last_output_at, lease_owner, lease_expires_at, num_turns, input_tokens, output_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens, usd_reported numeric(12,6) null, usd_estimated numeric(12,6), price_list_id, wall_ms, redaction_count, created_at)` — idx `(task_id)`, `(project_id, started_at)`, `(status) WHERE status IN ('created','starting','running')` *(corrected at WP-03: `queued` is not a value of the `run_status` enum; the live index uses the three non-terminal states)*, `UNIQUE(run_key)` for memoisation.
- `run_model_usage(run_id, model, input_tokens, output_tokens, cache_write_5m, cache_write_1h, cache_read, usd_estimated)` PK `(run_id, model)`.
- `run_context_pack(run_id, tier smallint, source_path, reason, score real, tokens int, validated bool, kb_commit_sha)` PK `(run_id, source_path)`.
- `artifacts(id, task_id, type, version int, markdown text, data jsonb, schema_version, produced_by_run_id, created_at)` — `UNIQUE(task_id, type, version)`.
- `questions(id, task_id, task_stage_id, run_id, text, options jsonb, blocking bool, status, asked_at, deadline_at, reminders_sent int, answer text, answered_by_user_id, answered_via, answered_at, escalated_at)` — idx `(status, deadline_at)`.
> **`events.id` and `cause_event_id` (added at WP-04, migration `0010`).** This column list originally had
> neither, while technical/02 requires an event id and a cause *by event id* — so a stored event could not
> be parsed against its own published schema. `position` remains the physical order and the idempotency key
> for `handler_executions` (see technical/02); `id` is the stable public identity that leaves the database
> in APIs, SSE frames and `cause_event_id`. Note for operators: `0010` adds `id` with a **volatile** default,
> so applying it rewrites every `events` partition under ACCESS EXCLUSIVE — trivial pre-deployment, not
> trivial on a populated table.

> **Stage nullability (clarified at WP-03).** `runs.task_stage_id` and `questions.task_stage_id` are
> nullable: not every run or question belongs to a pipeline stage (discovery during onboarding,
> ask-the-task, librarian and maintenance runs do not). The `stage` field on `RunRecord` and
> `QuestionRecord` in `packages/contracts` is therefore **nullable** too — it is a stage *slug*
> resolved by joining `task_stages`, not a stored column. WP-01 typed it non-nullable; WP-04 corrects
> the contract.

- `feedback(id, task_id, project_id, source, external_ref, author, body text, sentiment, received_at, processed_at)` — idx `(task_id)`, `(project_id, received_at)`. *(Added at WP-03: technical/02 defines the `feedback.received` event and `contracts/records.ts` defines `feedbackRecordSchema`, but this document had no table. The table is created by the WP that first persists feedback; the row shape is fixed here so the contract and the schema cannot diverge.)*
- `approvals(id, task_id, kind, status, requested_at, deadline_at, decided_by_user_id, decided_at, reason)`.
- `workspaces(id, task_id, runner_id, path, status, base_commit, disk_bytes, retention_until, exported_blob_id, created_at, destroyed_at)`.
- `human_actions(id, task_id, user_id, action, params jsonb, created_at)` — append-only.

### Event log and jobs
- `events(position bigint generated always as identity, id uuid not null default uuidv7(), stream_type, stream_id uuid, stream_seq int, type, payload jsonb, actor jsonb, cause_event_id uuid null, cause_event_position bigint null, correlation_id uuid, occurred_at timestamptz, xact_id xid8 default pg_current_xact_id())` — **partitioned by range on `occurred_at` (monthly)**; PK `(occurred_at, position)`; `UNIQUE(stream_type, stream_id, stream_seq)`; idx `(type, occurred_at)`, `(correlation_id)`. Append-only. Consumers track per-stream `stream_seq` or fence on `pg_snapshot_xmin(pg_current_snapshot())` (research/07: global position is not gapless).
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
- `integration_actions(id, integration_id, project_id null, task_id null, direction enum(in|out), action, payload jsonb, result jsonb, status, duration_ms, redaction_count, attempts, created_at)` append-only.
> **Three columns added at WP-15b (migration `0013`).** `IntegrationActionEntry` (WP-07) has carried
> `projectId`, `redactionCount` and `attempts` since the port was written, and the table created at
> migration `0007` had no home for any of them — so the first adapter of `IntegrationAuditLog` needed a
> migration as well as code. Each earns its column:
> - **`project_id`** because an action is scoped to a project even when it has no task: a binding health
>   check or an inbound normalisation belongs to a project's audit, and `task_id` is nullable precisely
>   for those. Reconstructing it through `integrations` would be wrong — one integration serves many
>   projects.
> - **`redaction_count`** because it is the only signal that a row which *should* have hidden something
>   did not (TD-012). A redactor that silently stops working writes rows that look exactly like clean
>   ones; a zero next to a payload that carried a credential is the discrepancy an auditor can see. It is
>   a **count on the row**, never part of an identity (the idempotency *key* is refused rather than
>   redacted — technical/06 § "Outbound: actions").
> - **`attempts`** because "the provider was called and it worked" and "the provider was called four
>   times and the fourth worked" are different facts about an integration's health, and the executor's
>   retry loop is the only place that knows.
>
> **`task_id` and `project_id` carry no foreign key** — `task_id`'s was dropped by the same
> migration. An audit row commits in a transaction of its own (with its event, per BD-003) while the
> *caller* is usually still inside one: technical/06 says actions are triggered by event handlers,
> and the intake saga reads the repository's default branch in the same transaction that inserts the
> task. A referential constraint refuses that row **because the caller has not committed**, making
> the audit the thing that fails the action — measured, as an e2e that died on its first event. The
> residual is stated: `task_id` may name a task that no longer exists, or that a rolled-back
> transaction never created, which is still the honest record because the provider call really
> happened. Dropping it is also what lets a project be deleted at all, since a RESTRICT from an
> append-only table nobody may delete from is permanent. `integration_id` keeps its foreign key: a
> binding is always committed before a call is made through it.
>
> Both `redaction_count` and `attempts` are `not null` **with no default**: an INSERT that omits either is
> refused by the database rather than recorded as a zero, because "nothing was redacted" and "nobody wrote
> the column" must not be spelled the same way (standing rule 18). `platform_table_policy` keeps the table
> `append_only` on `created_at`, unchanged.

- `integration_idempotency(storage_key pk, integration_id, action, result jsonb, created_at)` — the
  `IdempotencyStore` port's table (WP-15b). `storage_key` is `idempotencyStorageKey(scope)`, the one
  composition of `(integration_id, action, key)` the port exports so no adapter invents its own; the
  parts are stored beside it so an operator can read the table without decoding the key. `result` is
  `jsonb not null` and holds the **redacted** remembered result, so a JSON `null` (a legitimate remembered
  value) stays distinguishable from "never seen", which is the absence of the row. Not append-only and not
  partitioned: nothing expires a key today, and when something does it will delete rows.

### Knowledge and code (derived; rebuildable)
- `kb_documents(id, project_id, path, commit_sha, type, kind, status, confidence, scope, paths text[], trigger text, expires date null, last_confirmed date null, frontmatter jsonb, content_hash, tokens int, updated_at)` — `UNIQUE(project_id, path)`; GIN on `paths`.
> **`kb_documents.confidence` is a weight, and product/05's `confidence` is a label (clarified at
> WP-16).** product/05's lesson schema writes `confidence: proposed | confirmed | contested`; this
> column is `real` bounded to `[0, 1]`, because technical/07 § "Retrieval" *boosts* a candidate by
> confidence and a boost needs a number. Both are right and neither moves: the authored label
> survives in `kb_documents.frontmatter`, and the column stores `kbConfidenceWeight` of it
> (`@platform/contracts`), which is what the ranking multiplies by. A document with **no**
> `confidence` is written at `proposed`'s weight rather than at zero — most of a vault carries no
> frontmatter at all, and zero would rank the human-written core below every machine proposal
> (standing rule 16: a missing number is not zero).
>
> **The layer a document belongs to is derived, not stored (WP-16).** product/05's layers
> (`business/`, `technical/`, `decisions/`, `lessons/`, plus `.agentic/rules/`) are a function of
> the path, so there is no column for them: a column would give the value two writers. It is
> carried inside `frontmatter` under a platform-owned key and recomputed by the parser on every
> index run.

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
