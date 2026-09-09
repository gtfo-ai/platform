# TD-011 — Drizzle ORM with SQL-file migrations; hand-written DDL for partitions, generated columns and indexes

- **Status:** accepted (conditional on TD-001 = TypeScript)
- **Date:** 2026-08-28
- **Relates to:** research/07, technical/03

## Decision
`drizzle-orm` (Apache-2.0) + `drizzle-kit` migrations as SQL files; typed JSONB via `$type<T>()`; `pg` driver (LISTEN via `client.on('notification')`); partitions, GIN/HNSW indexes, generated `tsvector` columns, `REVOKE` statements and pg-boss schema live in custom migration SQL. Pin the Drizzle version (1.0 is at RC). Kysely is the fallback; Prisma rejected (DSL fights partitions/extensions). If TD-001 selects Python: SQLAlchemy 2 + Alembic.
