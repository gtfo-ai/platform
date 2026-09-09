# Technical design (Round 2) — working area

> **Status: Round 2 complete (2026-08-28).** All 16 candidate decisions below are recorded as TD-001…TD-024 in `../decisions/technical/README.md`. Documents: 01 architecture overview · 02 domain model and events · 03 data model · 04 agent runtime · 05 workspaces and security · 06 integrations architecture · 07 knowledge and search · 08 API and realtime · 09 UI architecture · 10 testing strategy · 11 CI/CD, Docker, release · 12 configuration and schemas · 13 implementation plan · `CLAUDE.md.proposed`. Open technical uncertainties are verification items in `../TODO.md`; Q33 in `../OPEN-QUESTIONS.md` flags the one design assumption that needs a spike (WP-13).

Summary of the stack: TypeScript on Node 24 · Fastify 5 + awilix + zod · PostgreSQL 18 only (event log, transcripts, pg-boss jobs, FTS; pgvector in phase 2) · Postgres-native pipeline interpreter (no workflow engine) · Claude Agent SDK in streaming-input mode with the CLI spawned in a per-run hardened container behind an egress proxy · SSE with replay · React 19 + Vite + TanStack + shadcn/Base UI · Better Auth + own RBAC · pino/Prometheus/optional OTel · Vitest 5, PGlite/Testcontainers, nock, fast-check, promptfoo · GitHub Actions with native arm64, attestations, release-please, Renovate, gitleaks, DCO · two Docker images + Compose with a `local` profile.

The original checklist is kept below for traceability.

## Constraints inherited from Round 1

| Constraint | Source |
|---|---|
| Claude Agent SDK is the single LLM integration; provider modes `api` and `local`; no claude.ai login | BD-004 |
| Event-driven core: immutable events, handlers with priorities, chaining; integrations by type contract | BD-017, product/04 |
| Everything auditable: prompts, settings snapshot, transcripts, tokens, cost, events | BD-003 |
| Knowledge = markdown in repo; indexes derived and rebuildable | BD-012 |
| Single-tenant instance, multi-project | BD-009 |
| Docker only; base image with CLIs + product image; 12-factor; env config; stdout logs; health endpoints; compose for a full instance | BD-020 |
| Isolated disposable workspaces per task; least-privilege tools per stage; blocked destructive git ops; network allow-list | BD-021 |
| Real-time UI: live transcript streaming, board, agents view | BD-015, product/10 |
| Budgets enforced via SDK `maxBudgetUsd` per run + platform gating for org/project/task | BD-010, BD-011 |
| No public URL required for a working instance (Slack Socket Mode, polling fallbacks) | product/08 |
| Rename-friendly identifiers | BD-014 |
| GitHub Actions CI testing business logic; secret scanning | BD-002 |
| No secrets in repo; `.env.example` only | BD-002 |

## Candidate decisions to make in Round 2 (with the evidence to gather)

1. **Language and SDK flavour**: TypeScript (`@anthropic-ai/claude-agent-sdk`, richer hook set per research/04) vs Python (`claude-agent-sdk`). Evaluate: SDK feature parity, ecosystem for Slack Bolt / GitLab / Jira clients, team fluency, one-language-for-UI-and-backend argument.
2. **Event bus / job execution**: in-process outbox + Postgres-backed queue vs Redis streams vs NATS vs Temporal-style workflow engine. Requirements: at-least-once, ordering per task, priorities, retries, idempotency, replay for audit, no extra ops burden for self-hosters.
3. **Database**: Postgres (likely) — schema for events, tasks, runs, artifacts, cost aggregates, audit; transcript storage (DB vs object storage vs files).
4. **Workspace isolation**: container-per-run (Docker socket / sidecar runner / Kubernetes jobs) vs git worktrees in a shared runner container with user separation. Requirements from BD-021; SDK `cwd` per run; network allow-listing.
5. **Real-time transport**: SSE vs WebSocket for transcript streaming; how `StreamEvent`s are persisted and replayed.
6. **UI stack**: SPA framework, component library, real-time state; design language (frontend-design / ui-ux skills available in this environment for Round 2).
7. **Search index**: full-text (Postgres FTS / SQLite FTS5 / LanceDB) for phase 1; hybrid in phase 2; embedding provider abstraction (local Apache-2.0 model vs Voyage) per research/02.
8. **Repo map / code intelligence**: tree-sitter based repo map generation; optional LSP later.
9. **Auth**: local accounts + sessions for MVP; OIDC later; role model from product/11.
10. **Secrets**: env vars + optional file mounts; encryption at rest for integration tokens stored via UI; redaction library for transcripts.
11. **Integration clients**: REST thin clients (own code) vs SDKs; webhook verification per provider; Slack Bolt Socket Mode.
12. **Docker images**: base (Debian slim + Node/Python + git + `glab` + `gh` + `acli` + `jira` + `logcli` + `sentry-cli` + `@sentry/mcp-server` + SDK binary) and product image; multi-arch; pinned versions; rebuild schedule (research/03 has the install snippet).
13. **Testing**: unit tests for domain (pipeline state machine, budgets, cost), contract tests per integration type with fakes, recorded-fixture tests per provider, prompt evals with recorded transcripts, end-to-end smoke in CI with a fake Claude (SDK mock) — all in GitHub Actions.
14. **Config**: env var naming (prefix from the product constant), `.agentic/config.yml` schema + validation, precedence implementation.
15. **Observability of the platform itself**: structured logs to stdout, metrics endpoint, optional OpenTelemetry.
16. **Versioning/release**: semver, changelog, image tags, migration strategy for DB and `.agentic` schema.

## Reading for Round 2
- research/04 (SDK features), research/03 (integration tooling + Dockerfile snippet), research/02 (KB indexes, token patterns), research/01 (competitors: what to borrow technically).
