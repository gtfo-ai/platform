# 01 — Architecture overview

> Round 2 design. Every choice here is a TD record (see `../decisions/technical/README.md`). Product constraints: BD-001…BD-030.

## System context

```
 Jira Cloud ──webhooks/poll──►┐                                     ┌──► GitLab (MRs, CI, webhooks)
 Slack (Socket Mode) ◄──────►│   Agentic instance (one organisation) │──► Sentry / Loki (read)
 Humans (browser) ◄─SSE/HTTP─►│                                       │──► Anthropic API (or local Claude binary)
                              └───────────────────────────────────────┘
```

## Containers (Compose)

| Service | Image | Role | Notes |
|---|---|---|---|
| `db` | `postgres:18` | system of record, event log, transcripts, jobs, KB index | TD-006 |
| `migrate` | `platform` | one-shot migrations (advisory lock) | TD-019 |
| `app` | `platform` (`ROLE=all` or split `api`/`worker`/`runner`/`indexer`) | HTTP API + SPA + SSE, event dispatcher, pipeline interpreter, pg-boss workers, Agent SDK runner, Slack Socket Mode, indexer | TD-001/002/003/004 |
| `launcher` | `platform-launcher` (tiny) | creates run containers/networks/volumes via `docker-socket-proxy`; git credential broker | TD-021 |
| `docker-socket-proxy` | Tecnativa | filtered Docker API for the launcher only | TD-021 |
| `caddy` (optional) | caddy | TLS + HTTP/2 termination | TD-014 |
| `db-backup` | postgres-backup-local | `pg_dump` rotation | TD-006 |
| per run: `ws-<id>` + `egress-<id>` | `platform-runtime` (Claude binary + CLIs) / tinyproxy | isolated workspace on `internal` network with allow-listed egress | TD-021 |
Profile `local`: mounts the operator's Claude binary/config for `APP_PROVIDER_MODE=local` (BD-004).

## Code structure (pnpm monorepo, clean architecture)

```
packages/
  domain/         # aggregates, value objects, domain events, state machines, policies — no I/O, 90% coverage
  application/    # use cases, event handlers (priorities), sagas (pipeline interpreter, question, batcher, budget, knowledge, shadow, maintenance), ports
  contracts/      # zod schemas: events, artifacts, .agentic config/pipeline, API DTOs, TranscriptEvent — shared with the UI
  infrastructure/ # postgres (drizzle), event store, jobs (pg-boss), broadcast (NOTIFY), claude-sdk runner, workspace providers (docker, fake), search/indexer, code map, redaction, secrets
  integrations/   # <type>/port + fake + contract tests; providers/{jira-cloud, gitlab, slack, sentry, loki}
  prompts/        # roles: prompt.md, schema.json, evals/
apps/
  server/         # Fastify composition root: routes, SSE, webhooks, auth, ROLE bootstrap
  web/            # React SPA
  launcher/       # workspace provider service (dockerode)
docker/ schemas/ compose.yml .github/
```
Dependency rule: `domain ← application ← infrastructure/integrations ← apps`. `contracts` is leaf-level and shared.

## Key runtime flows

**Ticket → task.** Webhook (or poll) → `inbox` (dedup, signature) → `ticket.matched` → Intake handler (WIP check, template snapshot, estimate) → `task.created` → workpad comment, Slack thread, board update → `task.stage.entered(refinement)` → `stage.execute` job.

**Stage run.** Job → StageExecutor builds `RunSpec` (context pack, prompt layers, tools, policy, limits, schema) → Runner: `WorkspaceProvider.create/attach` → Agent SDK `query()` streaming-input mode with `spawnClaudeCodeProcess` → hooks/canUseTool on the platform → every message redacted and appended to `run_messages` + broadcast to SSE topic `run:<id>` → `result` → artifact validated and stored → `run.finished` → cost ledger + rollups → `task.stage.completed` → pipeline interpreter picks the next stage from the task's template snapshot (or returns/escalates per counters).

**Human waits.** Question/approval created → ticket comment + Slack buttons + inbox; pg-boss timers for reminders/timeouts; answer from any channel (mapped user) → `question.answered` → pipeline resumes. MR comments batched (2-minute window, opened by the first comment; the handler re-reads every unresolved thread when it fires) → return to Implementation. Merge → `mr.merged` → Merged gate → Retrospective → Librarian → proposals.

**Budgets.** Cost entries fold into `budget_windows`; thresholds emit notifications; exhaustion blocks new runs (never kills running ones); per-run `maxBudgetUsd` from effective config.

**Take-over / steer.** Steer pushes a user message into the run's input stream (audited); take-over interrupts, exports the workspace (push branch, transcript copy), posts the resume command; hand-back re-enters a chosen stage.

## Cross-cutting
- **Events:** append-only `events` (outbox) + priority dispatcher + `handler_executions` (TD-005).
- **Jobs/timers:** pg-boss (TD-004). **Real-time:** SSE with replay (TD-014).
- **Security:** per-run isolation (TD-021), config from default branch and command policy (BD-025), external text as data (BD-022), redaction at write (TD-012), RBAC (TD-022).
- **Observability:** pino, Prometheus, optional OTel/Sentry (TD-023). **Testing:** TD-015/016. **CI/CD, images, release:** TD-017/018/019.

## Scaling path
Single `app` process → split roles across containers (same image, `ROLE` env) → multiple `api`/`worker` replicas (LISTEN/NOTIFY + polling; NATS/Valkey behind the `Broadcast` port if needed) → Kubernetes provider for workspaces → per-customer instances for hosting (BD-009).
