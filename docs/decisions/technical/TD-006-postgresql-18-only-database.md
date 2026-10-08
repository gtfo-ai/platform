# TD-006 — PostgreSQL 18 is the only database

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/07, technical/03

## Decision
PostgreSQL 18 (official image, volume mounted at `/var/lib/postgresql`) holds events, state, transcripts, cost ledger and rollups, audit, KB indexes, code maps and the job queue. Native monthly range partitions managed by the app (no pg_partman). `uuidv7()` keys. No Redis, no TimescaleDB, no object store in v1 (a `blobs` indirection allows S3-compatible storage later; MinIO community is effectively dead, SeaweedFS/Garage are the candidates).

## Rationale
Measured volumes (≈ 2 GB and 3 M rows per 1 000 runs) are Postgres-sized; one backup/restore story for self-hosters; PG 18 gives uuidv7, async I/O, skip scans.

## Consequences
- Custom Postgres image only if `pg_textsearch`/pgvector are adopted in phase 2 (pgvector has an official image).
- Backups: `pg_dump` sidecar in Compose; PITR profile later.

## Amendment (2026-10-08, M10 architect pass — PROGRESS backlog 528)
*`uuidv7()` keys* describes the **column default**, not the ids the application writes. Every composition root builds the `ids` port as Node's `randomUUID()`, which is a version-4 uuid (`apps/server/src/knowledge.ts:214`, and the other roots that build an `ids` port), and the stores insert that id, so the default runs only for SQL that omits `id`. This pass does not change either half. Moving the port to uuidv7 is not needed by any reader today, and it is a decision of its own. **The rule that follows: no code may derive an order, a uniqueness claim or a time from an id's version or from a prefix of an id.** An order is read from a timestamp column with the id as the tie-break, and a name that must be unique uses the whole id. `knowledgeBranchName` broke this rule and is corrected at WP-166. technical/03's sentence about `uuidv7()` primary keys is read with this amendment.
