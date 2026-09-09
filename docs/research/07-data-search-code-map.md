# Research: data layer — Postgres, transcripts, search, embeddings, repo map, aggregates, ORM, redaction (2026-09-09)

> Versions/licences checked 2026-09-09; measured numbers come from 423 real Claude Code session transcripts on the founder's machine. Informs TD-006…TD-011 and technical/03, /07.

## Postgres
- **PG 18** (18.6 current; 19 is beta, GA expected autumn 2026 — do not target). Relevant: built-in `uuidv7()`, async I/O, B-tree skip scan, `RETURNING old.*/new.*`, checksums default on, **virtual generated columns are default → declare `tsvector` columns `STORED`**. https://www.postgresql.org/docs/release/18.0/
- **Docker gotcha:** `postgres:18` image moved `PGDATA` to `/var/lib/postgresql/18/docker` and the volume to `/var/lib/postgresql`; mounting the old `/var/lib/postgresql/data` silently loses data on restart. https://github.com/docker-library/postgres/issues/1370
- Event log: `events(position identity, stream_type, stream_id, stream_seq, type, payload jsonb, meta, occurred_at, xact_id)` with `UNIQUE(stream_type, stream_id, stream_seq)`; global `position` is not gapless and can become visible out of commit order — consumers track per-stream seq or fence on `pg_snapshot_xmin(pg_current_snapshot())`; a transactional counter row dropped throughput 1 600 → 120 writes/s in measurements. https://dev.to/kspeakman/event-storage-in-postgres-4dk2 . `REVOKE UPDATE, DELETE` for the app role.
- JSONB: values > ~2 KB go to TOAST; **an UPDATE of a TOASTed JSONB rewrites the whole value** → never keep mutable counters/status inside large documents. https://www.evanjones.ca/postgres-large-json-performance.html
- Partitioning: monthly RANGE partitions on `run_messages` and `events`; create the next partitions from the app at boot/daily (no `pg_partman` needed). Retention "forever" default; optional purge = `DROP PARTITION` (instant, no bloat). Storage gauge = `pg_total_relation_size`.
- Backups in Compose: `prodrigestivill/postgres-backup-local` sidecar (pg_dump rotation) for phase 1; pgBackRest/WAL-G profile later.

## Transcripts (measured)
| Metric | Value |
|---|---|
| Sessions measured | 423 |
| Mean size | 1.39 MB (max 29.5 MB; 249 of 423 between 0.5 and 2 MB) |
| Composition of a 15 MB session | tool results 79% of bytes (395 rows × avg 31 KB); assistant 656 rows × 3.4 KB; 46 rows > 100 KB |
| Capacity at 1 000 runs/month | ~1.5–2 GB and 2–3 M rows/month → ~20 GB/year |

Options: **row per SDK message, monthly partitions (recommended)**; one JSONB doc per run (rejected: O(n²) TOAST rewrites during append); files + metadata (two things to back up); S3 (MinIO community effectively dead since Oct 2025 — https://bizety.com/2025/12/06/minio-in-maintenance-mode-open-source-alternatives/ ; SeaweedFS/Garage exist; defer with a `blobs` indirection). Access: `run_messages(run_id, seq)` PK; tail = range scan + `NOTIFY run_<id>` with `{seq}` only (payload ≤ 8 000 bytes, coalesced per tx). Persist completed assistant messages; stream partial deltas to the UI only (or one coalesced row per content block). The SDK `sessionStore` is a best-effort mirror (failures surface as `mirror_error`) — use it for cross-host resume; the audit writer must be our own consumer of the stream. https://code.claude.com/docs/en/agent-sdk/session-storage

## Search
| Engine | Facts | Verdict |
|---|---|---|
| Postgres tsvector/GIN | no BM25 (ts_rank lacks IDF/length norm) | **Phase 1** for KB and transcript `search_text` |
| `pg_textsearch` (Tiger Data) | 1.4.0, PostgreSQL licence, PG 17/18, real BM25, needs `shared_preload_libraries`, no Docker image (needs own Postgres image) https://github.com/timescale/pg_textsearch | Phase 2 candidate if measured to beat tsvector |
| ParadeDB `pg_search` | 0.25.6, **AGPL-3.0** | works, heavier, licence caveat |
| pgvector | 0.8.6, PostgreSQL licence, PG 18 support, HNSW, `halfvec`, iterative scans; `pgvector/pgvector:pg18` image | **Phase 2 vectors**, hybrid via RRF in SQL |
| SQLite FTS5 + sqlite-vec | pre-v1 | second engine for no gain once Postgres exists |
| LanceDB | 0.38, Apache-2.0, native FTS + hybrid | best embedded option *without* Postgres; fallback |

Plan: `kb_chunks` per heading section with `project / path / H1 > H2` prefix, `search tsvector STORED` (config `simple` for Czech/English mix), GIN, `websearch_to_tsquery`, path/frontmatter boosts; transcripts index a compact `search_text` (assistant text, tool names, paths), not raw tool results. Phase 2: `halfvec(1024)` HNSW + RRF (`1/(60+rank)`), evaluate `pg_textsearch` with the per-project eval set.

## Embeddings runtime
- **transformers.js** `@huggingface/transformers` 4.2.0 (Apache-2.0; Node/Bun/Deno; ONNX Runtime CPU/WebGPU), `onnxruntime-node` 1.29 (~200 MB optional dep) — in-process default for phase 2; model weights downloaded to a named volume on first use, not baked into the image.
- Models: **Qwen3-Embedding-0.6B** ONNX (Apache-2.0, 1024 dims, int8 ≈ 614 MB) https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX ; EmbeddingGemma-300m ONNX (<200 MB quantised, 768 dims Matryoshka, needs prompt prefixes) but **Gemma Terms licence, not OSI** → not the default; nomic-embed-text-v1.5 (Apache-2.0), bge-m3 (MIT) as alternatives. Ollama sidecar (MIT) and Voyage API (voyage-4-nano open weights in the same space) as opt-in providers.
- No trustworthy CPU throughput numbers for Node → phase-2 spike must benchmark chunks/s on 4 vCPU. Store `embedding_model` + `dims` on the index; switching triggers a rebuild.

## Repo map / code map
| Tool | Facts |
|---|---|
| universal-ctags 6.2.1 | `ctags --output-format=json -R` definitions for 100+ languages; zero packaging effort; licence GPL-2.0 `[unverified]` (CLI in image, executed not linked) |
| `@ast-grep/napi` 0.45.3 (MIT) | prebuilt N-API, rule-based matching for references |
| `tree-sitter` node 0.25.1 / `web-tree-sitter` 0.27 (MIT) | native addon vs WASM; grammar packaging effort |
| aider RepoMap | no maintained JS/TS port → write ~300 lines: tags → symbol graph → personalised PageRank biased to task files → fill token budget. https://aider.chat/docs/repomap.html |
| `repomix --compress` 1.18 (MIT) | ~70% token cut, all-or-nothing packing; an agent tool, not a ranked map |

Plan: phase 1 ctags + cheap reference pass → PageRank → 1–4k-token map; cache per blob SHA (re-tag only changed files) and rendered map per `(commit, focus_paths_hash, token_budget)`; phase 3 tree-sitter/LSP.

## Aggregates and price table
- TimescaleDB continuous aggregates are under the Timescale License (Community), and volumes are thousands of runs/month → **plain Postgres rollup tables** `cost_rollup_daily(org, project, template, stage, model, day, mode, runs, tokens by kind, usd_actual, usd_estimated, wall_ms, turns)` maintained with `INSERT … ON CONFLICT DO UPDATE` on run finish; nightly self-heal recompute; week/month = SUM at query time.
- `price_list(model_id, effective_from, effective_to, input, output, cache_write_5m, cache_write_1h, cache_read, batch_multiplier, fast_input, fast_output, source_url, verified_at)`; never mutate rows. Current: Opus 5 $5/$25, Sonnet 5 $2/$10, Haiku 4.5 $1/$5, Fable 5.1 $10/$50; cache write 1.25×/2×, read 0.1× (0.025× Fable 5.1); Opus 5 fast mode $10/$50; batch 50%. SDK `usage.cache_creation` splits `ephemeral_5m_input_tokens`/`ephemeral_1h_input_tokens` — store both. `model_usage` per model → `run_model_usage` rows.

## ORM
| | Facts | Verdict |
|---|---|---|
| **Drizzle** | drizzle-orm 0.45.2 (Apache-2.0; 1.0.0-rc.5 on `rc`), drizzle-kit 0.31.10; SQL-file migrations, hand-written DDL for partitions/GIN/tsvector; `jsonb().$type<T>()` | **Recommended** (pin version; expect custom SQL migrations) |
| Kysely 0.29.5 (MIT) | thinnest typed builder, no migrations built in | runner-up |
| Prisma 7.10 | DSL fights partitions, generated columns, extensions | pass |
| `pg` 8.23 / postgres.js 3.4 | drivers; LISTEN via `client.on('notification')` | under Drizzle |
| Python | SQLAlchemy 2.0.52 + Alembic 1.19 | if Python |

## Secret redaction
- gitleaks 8.30.1 (MIT, 222 RE2 rules in `config/gitleaks.toml`; "feature complete — security patches only") — reuse the rule set; secretlint 13.0.5 (MIT, Node, preset includes Anthropic/OpenAI keys; file-oriented API `[check string API]`); detect-secrets stale; Presidio (PII) out of scope.
- Pattern: pure function in the single persistence path, three layers — exact match of every secret value the platform injected (`[REDACTED:integration:<name>]`), regex rules from gitleaks/secretlint subset, optional entropy heuristic — with `[REDACTED sha256:ab12cd]` placeholders, `redaction_count` per row and a `redaction_log`; never persist originals (BD-003 forbids rewriting rows later).

## Proposed logical data model → adopted in technical/03-data-model.md
