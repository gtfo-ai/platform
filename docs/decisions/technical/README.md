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
| [TD-026](TD-026-knowledge-vault-read-path.md) | Knowledge vault read path: platform-side bare mirror + git plumbing, never a working tree | accepted |
| [TD-027](TD-027-stage-scoped-command-defaults.md) | Command defaults per stage: the merge is a `conflict_resolution` stage layer, never the implementation maximum | accepted |
| [TD-028](TD-028-launcher-control-plane.md) | The launcher's transport is split: an authenticated HTTP control plane on an internal network, the run's stdio unchanged on TD-025's control socket | accepted |
| [TD-029](TD-029-ticket-lifecycle-slots-returns-and-mr-threads.md) | Ticket lifecycle slots live on the task-management binding; one claim before admission; one human-return window over four signals; review threads found again by marker | accepted |
| [TD-030](TD-030-command-scanner-reading-contract.md) | The command scanner's reading contract: three tiers, one grading rule, and what a scanner row may be | accepted |
| [TD-031](TD-031-run-offers-and-remote-workers.md) | Agent runs are offers in one pool; the server runner and remote workers claim with one SQL claim, one lease and an epoch fence; a short-poll HTTPS worker protocol and a run package the core decides | accepted |
| [TD-032](TD-032-automatic-updates-and-migration-classes.md) | Automatic updates: additive/contract migration classes, an older build accepts an all-additive schema, a mandatory pre-update backup, one updater with self/external/worker modes | accepted |
| [TD-033](TD-033-visual-design-language.md) | Visual design language: GitHub's grammar in the sign-in page's colours, one activity vocabulary, three live visualisations (amended: one dark theme; whole-row click targets) | accepted |
| [TD-034](TD-034-desktop-app-tauri-shell.md) | The desktop app is a Tauri v2 shell in `apps/desktop`: an allow-list of Docker verbs over a bundle in its own data directory, the worker's page in a window with no IPC, signed and attested releases on a `desktop-stable` channel release the updater reads (planned; build after the worker is verified) | proposed |
| [TD-035](TD-035-approval-subject-and-reasons.md) | An approval records its subject and its reasons at the gate; the decide command echoes the subject it was shown; the reasons are a closed vocabulary the UI words | accepted |
