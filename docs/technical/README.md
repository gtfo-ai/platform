# Technical design (Round 2) — working area

> **Status: Round 2 complete (2026-08-28).** All 16 candidate decisions below are recorded as TD-001…TD-024 in `../decisions/technical/README.md`. Documents: 01 architecture overview · 02 domain model and events · 03 data model · 04 agent runtime · 05 workspaces and security · 06 integrations architecture · 07 knowledge and search · 08 API and realtime · 09 UI architecture · 10 testing strategy · 11 CI/CD, Docker, release · 12 configuration and schemas · 13 implementation plan · 14 orchestration protocol · `PROGRESS.md` ledger · `CLAUDE.md.proposed`. Open technical uncertainties are verification items in `../TODO.md`; the CLI-in-container spawn transport is decided in TD-025 (run shim over a control socket), verified in WP-13. **TD-026 (2026-09-12)** adds one decision taken during implementation: the knowledge vault is read from a platform-side bare mirror with git plumbing and no working tree, which is the checkout WP-18's indexer job could not otherwise get (PROGRESS backlog 26); TD-021 carries the matching amendment and technical/05 §1 and technical/07 § Source of truth and sync now say which mirror is whose. **TD-027 (2026-09-13)** makes command defaults stage-scoped and add-only. **TD-028 (2026-09-15)** decides Q52: the launcher's transport is split — an authenticated HTTP control plane on an internal network for the five request/response verbs, TD-025 §2's unchanged control socket for the run's stdio — with the control volume on a second product container and `stage.execute` subscribed by configuration rather than by `ROLE`.

> **Status line (session 11, 2026-10-03): milestone M7 is written and its last row is in progress.** M6 is delivered (WP-101…WP-118; WP-78 and WP-33 BLOCKED). **M7 — "ready to dogfood"** is `13-implementation-plan.md` § "Milestone M7 — ready to dogfood": WP-119…WP-131 (WP-131 was added during the milestone); every row but WP-130, the documents row, is delivered. Its decisions are TD-012's and TD-004's M7 amendments and Q112, implemented as (a). No open backlog entry is graded major or blocker. Every open backlog entry and question is dispositioned in `PROGRESS.md` § "Architect ruling (M7, session 11)"; Q99, Q106 and Q108 stay open for the founder, Q112 and Q113 are implemented per their recommendations and await the founder's confirmation, and Q107, Q109, Q110 and Q111 were answered by the founder in session 10 and are built.

> **Status line (session 9, 2026-09-30): milestone M6 is written.** M5 is delivered (WP-79…WP-100; WP-78 BLOCKED upstream). **M6 — "the record and the run agree"** is `13-implementation-plan.md` § "Milestone M6 — the record and the run agree": WP-101…WP-117. Its decisions are TD-028's and TD-012's M6 amendments and the switch of Q109 to (b). No open backlog entry is graded major. Every open backlog entry and question is dispositioned in `PROGRESS.md` § "Architect ruling (M6, session 9)"; Q99, Q106 and Q108 stay open for the founder, and Q107, Q109, Q110 and Q111 await the founder's confirmation.

> **Status line (session 8, 2026-09-27): milestone M5 is written.** M4 is delivered (WP-47…WP-77, WP-73 in four tranches). **M5 — "no side doors"** is `13-implementation-plan.md` § "Milestone M5 — no side doors": WP-79…WP-98, plus WP-78 behind an upstream StrykerJS precondition (`../research/14-stryker-vitest5-typescript7.md`). Its decisions are TD-028's and TD-012's M5 amendments. Every open backlog entry and question is dispositioned in `PROGRESS.md` § "Architect ruling (M5, session 8)", and Q106–Q108 are open for the founder.
>
> **Status line (session 6, 2026-09-15): milestone M4 is written.** M1–M3 are delivered and merged except **WP-33** (blocked on a human model credential). **M4 — "a real installation"** is `13-implementation-plan.md` § "Milestone M4 — a real installation": **thirty-one rows** (WP-43…WP-46, whose numbers were already bound to their content, plus WP-47…WP-73) built from the 94 open entries of `PROGRESS.md` § "Open findings backlog" and Q63–Q90, ordered so that the four **blockers** and twenty-seven **majors** that can spend money or brick a row land before anything visible. Every entry's disposition, the ordering argument, the in-row rulings and what M4 deliberately omits are in `PROGRESS.md` § "Architect ruling (M4, session 6)"; the M4 status table sits after M3's. Five product questions were filed as **Q91–Q95** with recommendations; one technical decision was taken as **TD-028**. No source file, test or workflow was touched by this pass.

Summary of the stack: TypeScript on Node 24 · Fastify 5 + awilix + zod · PostgreSQL 18 only (event log, transcripts, pg-boss jobs, FTS; pgvector in phase 2) · Postgres-native pipeline interpreter (no workflow engine) · Claude Agent SDK in streaming-input mode with the CLI spawned in a per-run hardened container behind an egress proxy · SSE with replay · React 19 + Vite + TanStack + shadcn/Base UI · Better Auth + own RBAC · pino/Prometheus/optional OTel · Vitest 5, PGlite/Testcontainers, nock, fast-check, promptfoo · GitHub Actions with native arm64, attestations, versions computed from the conventional commits and applied as a retag behind one switch (WP-71; release-please was deleted), Renovate, gitleaks, DCO · five images (`platform-base`, `platform-runtime`, `platform-egress`, `platform`, `platform-launcher`) + Compose, with the `local` provider mode as the `compose.local.yml` override rather than a profile.

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
