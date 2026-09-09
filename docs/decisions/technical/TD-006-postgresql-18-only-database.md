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
