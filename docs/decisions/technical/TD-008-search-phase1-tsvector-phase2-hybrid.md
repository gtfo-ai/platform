# TD-008 — Search: Postgres full-text (phase 1), pgvector hybrid with RRF (phase 2), BM25 extension only if measured

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/02, research/07, technical/07, BD-012

## Decision
Phase 1: `kb_chunks.search tsvector STORED` (config `simple` for mixed Czech/English), GIN, `websearch_to_tsquery`, kind/confidence boosts and path-glob matching; transcripts index a compact `search_text`. Phase 2: pgvector `halfvec(1024)` HNSW + RRF in SQL, gated by per-project eval sets; evaluate `pg_textsearch` (PostgreSQL licence, needs our own Postgres image) at the same time; ParadeDB rejected (AGPL). No SQLite/LanceDB second engine.

## Consequences
- Search quality is measured, not assumed (eval set per project, product/05).
