# Technical decisions (TD)

Same template as business decisions (see `../README.md`). Index is filled during Round 2.

| ID | Title | Status |
|---|---|---|
| [TD-001](TD-001-typescript-node24.md) | Backend language and runtime: TypeScript on Node 24 LTS | accepted |
| [TD-002](TD-002-fastify-application-framework.md) | Application framework: Fastify 5 + awilix + zod + SSE plugin; own event bus | accepted |
| [TD-003](TD-003-postgres-native-pipeline-runtime.md) | Pipeline runtime: Postgres-native interpreter over per-task template snapshots; no workflow engine | accepted |
| [TD-004](TD-004-pg-boss-jobs-and-timers.md) | pg-boss for jobs, delayed timers, cron, coalesced wake-ups | accepted |
| [TD-005](TD-005-event-store-and-dispatch.md) | Own append-only event store + in-process priority dispatcher | accepted |
| [TD-006](TD-006-postgresql-18-only-database.md) | PostgreSQL 18 is the only database | accepted |
| [TD-007](TD-007-transcripts-as-partitioned-rows.md) | Transcripts as partitioned rows per SDK message | accepted |
| [TD-008](TD-008-search-phase1-tsvector-phase2-hybrid.md) | Search: tsvector phase 1, pgvector hybrid phase 2 | accepted |
| [TD-009](TD-009-embedding-provider-port.md) | Embedding provider port; local Qwen3 default (phase 2) | proposed |
| [TD-010](TD-010-code-map-ctags-pagerank.md) | Code map: ctags + PageRank, cached per blob/commit | accepted |
| [TD-011](TD-011-drizzle-orm.md) | Drizzle ORM with SQL migrations | accepted |
| [TD-012](TD-012-secret-redaction-at-write.md) | Secret redaction at write time | accepted |
| [TD-013](TD-013-ui-stack.md) | UI stack: React + Vite + TanStack + shadcn/Base UI | accepted |
| [TD-014](TD-014-sse-realtime-transport.md) | Real-time: multiplexed SSE with replay | accepted |
| [TD-015](TD-015-test-strategy-tooling.md) | Test strategy tooling | accepted |
| [TD-016](TD-016-promptfoo-prompt-evals.md) | Prompt evals with promptfoo | accepted |
| [TD-017](TD-017-github-actions-layout.md) | GitHub Actions layout, pinning, Renovate, scanning, attestations | accepted |
| [TD-018](TD-018-docker-images-and-compose.md) | Docker images and Compose | accepted |
| [TD-019](TD-019-release-engineering.md) | Release engineering | accepted |
| [TD-020](TD-020-configuration-and-env-naming.md) | Configuration and env naming | accepted |
| [TD-021](TD-021-workspace-isolation.md) | Workspace isolation: container-per-run via socket-proxied launcher; SDK on platform side | accepted (spike) |
| [TD-022](TD-022-auth-sessions-rbac.md) | Auth: Better Auth + Argon2id; own RBAC; OIDC-ready schema | accepted |
| [TD-023](TD-023-config-logging-metrics-otel.md) | Config (zod), logging (pino), metrics (Prometheus), optional OTel/Sentry, health | accepted |
| [TD-024](TD-024-thin-http-clients.md) | Thin HTTP clients + official Slack Bolt; in-house webhook verification | accepted |
| [TD-025](TD-025-run-shim-spawn-transport.md) | Spawning the CLI in the run container: in-container run shim over a Unix socket on a per-run control volume | accepted |
