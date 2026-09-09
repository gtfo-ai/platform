# 13 — Implementation plan (handoff to the implementation orchestrator)

> This is the work breakdown for a Claude Code orchestrator and its agent team. Product scope: product/14 (v0.1 = M1 loop, M2 trust, M3 show-the-value). Every work package (WP) lists inputs, outputs, acceptance criteria and dependencies. The orchestrator should run WPs as tickets through its own process: plan → implement → review (fresh context) → tests green → merge.

## Ground rules for the implementer
1. Read `docs/README.md`, all `docs/product/*`, all decisions, then `docs/technical/*`. The docs are the spec; product questions go to `docs/OPEN-QUESTIONS.md`, not into code comments.
2. Follow the code structure in technical/01; dependency rule `domain ← application ← infrastructure ← apps`.
3. Tests per technical/10 are part of each WP's definition of done; contract tests for every integration port; golden fixtures for SDK streams.
4. No secrets anywhere; `.env.example` maintained with every new variable; gitleaks pre-commit.
5. Conventional commits with `Signed-off-by`; small MRs; each WP ends with docs updates (CHANGELOG via release-please, ADR if a decision changed).
6. Install `docs/technical/CLAUDE.md.proposed` as `CLAUDE.md` at repository root in WP-00 and keep it under 200 lines.

## Milestone M1 — the loop

| WP | Title | Depends on | Acceptance criteria |
|---|---|---|---|
| WP-00 | Repo scaffold: pnpm monorepo, TS strict, Biome, Vitest 5 projects, lefthook, commitlint, CI `ci.yml`, CLAUDE.md, CONTRIBUTING, licence files, `.env.example`, Renovate, gitleaks | — | `pnpm test` runs empty suites green in CI; secret scan active; DCO check |
| WP-01 | `packages/contracts`: zod schemas for events, artifacts, `.agentic/config.yml` + `pipeline.yml` (technical/12), API DTOs, `TranscriptEvent`; JSON Schemas published under `schemas/` | WP-00 | Schema tests; `pnpm schemas` regenerates; unknown keys rejected |
| WP-02 | `packages/domain`: aggregates (Task, Run, Question, Approval, Budget, Project config merge), state machines, policies (iteration limits, WIP, budgets, autonomy presets, command policy evaluation), permissions `can()` | WP-01 | fast-check model tests for state machines; 90/85 coverage; exhaustive role×action test |
| WP-03 | Postgres schema + Drizzle + migrations (technical/03): partitions, event store, `handler_executions`, `inbox`, pg-boss install, price list seed, rollup tables; `migrate` entrypoint with advisory lock | WP-00 | Testcontainers migration test; partition auto-creation job; `REVOKE` verified |
| WP-04 | Event store + priority dispatcher + outbox job (TD-005) with `EventBus`, idempotency, chaining, `stop()`; Broadcast port (NOTIFY) | WP-02, WP-03 | property tests: at-least-once + idempotent handlers → exactly-once effects; ordering per stream |
| WP-05 | Jobs port on pg-boss: timers, cron, singleton/coalesced jobs; working-day calendar for question timeouts | WP-03 | timer accuracy tests; coalescing test |
| WP-06 | Fastify server skeleton (TD-002): config (zod), pino, Prometheus, health, Better Auth (email/password, sessions, admin), RBAC middleware, OpenAPI, SSE endpoint with topics and replay (TD-014), `ROLE` bootstrap, graceful shutdown | WP-04 | e2e: login, SSE replay after reconnect, shutdown drains SSE; OpenAPI generated |
| WP-07 | Integration ports + fakes + contract test suites for all five types (technical/06); `IntegrationActionExecutor` (shadow null adapter, idempotency, rate limits, audit) | WP-04 | contract suites green against fakes |
| WP-08 | Jira Cloud provider: thin client, ADF conversion, webhook verification + normaliser, polling fallback, transitions with runtime resolution, workpad upsert, questions, setup guide, recorded fixtures | WP-07 | contract suite green in replay mode; webhook golden tests |
| WP-09 | GitLab provider (gitlab.com + self-managed): thin client, MR/discussions/pipelines/coverage/CODEOWNERS, webhooks (legacy + Standard Webhooks), token minting/revocation, protected branch check, `listMergedMergeRequests`, setup guide | WP-07 | contract suite in replay; token minting tested against fixtures |
| WP-10 | Slack provider: Bolt Socket Mode, task threads, question/approval Block Kit, answer capture, identity mapping, digest job | WP-07 | contract suite; manifest file |
| WP-11 | Sentry + Loki providers: thin clients, pre-fetch for bug tasks, agent tooling specs (sentry-mcp/logcli), setup guides | WP-07 | contract suites |
| WP-12 | Claude SDK runner (technical/04): RunSpec → `query()` streaming input; hooks (policy, path guards, truncation, redaction, compaction markers); `canUseTool` → Question; platform MCP tools; session store; structured output validation; cost extraction; `ClaudeRunner` port + `FakeClaudeRunner` + fake `spawnClaudeCodeProcess`; transcript normaliser → `TranscriptEvent` with golden fixtures | WP-04, WP-05 | fixtures for all scenarios; redaction tests; budget-exceeded and stall handling tests |
| WP-13 | **Spike:** `spawnClaudeCodeProcess` over dockerode attach inside a hardened container with internal network + egress sidecar (TD-021); resume; exit codes; DNS behaviour | WP-12 | written spike report in `docs/research/12-spike-spawn-in-container.md`; go/no-go for option C vs B |
| WP-14 | Launcher service + `WorkspaceProvider` (docker + fake): mirror, clone, hardening, sidecar, broker, export, retention | WP-13 | e2e in CI with a fixture repo container; security flags asserted |
| WP-15 | Pipeline interpreter + stage executor + sagas (technical/02): templates feature/bug/chore, gates (CI, rebase, merged), returns, counters, escalation, questions/approvals, batching, budgets, WIP scheduler, workpad updates, status mapping | WP-04…WP-12 | fake-Claude e2e: one feature and one bug ticket through the whole loop; property tests on interpreter |
| WP-16 | Context packs + KB indexer (phase 1 FTS) + code map (ctags + PageRank) + `kb_search` tool | WP-03, WP-12 | retrieval tests on a fixture vault; token budget respected |
| WP-17 | Role prompts + artifact schemas + eval sets (product/13, TD-016): triager, product manager, investigator, architect, developer, reviewer, acceptance tester, facilitator, librarian, discovery; platform skills | WP-12 | promptfoo evals green on fixtures within budget |
| WP-18 | Librarian pipeline + proposals + apply policy + knowledge MR flow + nightly hygiene | WP-16, WP-17 | proposals appear in UI; thresholds honoured; commits carry provenance |
| WP-19 | Cost ledger, rollups, budgets projection, price table maintenance job, estimates | WP-04 | reconciliation test: sum of entries = rollups; budget pause behaviour |
| WP-20 | Web app foundation (TD-013): auth screens, layout, theme, realtime client, Query bridge, board, task detail, run detail with transcript renderer, agents view, inbox, settings, integrations setup, pipeline settings, budgets, statistics, audit log, knowledge browser + proposals | WP-06 | Playwright e2e with fake SSE; bundle budget check |
| WP-21 | Onboarding wizard steps 1–5 incl. discovery agent and readiness evaluation (product/06, /17) | WP-16, WP-17, WP-20 | wizard completes on fixture repo; readiness report produced |
| WP-22 | Docker images (base, runtime, launcher, product), Compose (profiles `local`), `image.yml`, `base-image.yml`, size checks, attestations | WP-14 | `docker compose up` on a clean VM yields a working instance; images signed |
| WP-23 | Docs: operator guide (install, integrations setup, upgrade, backup), user guide, `THIRD_PARTY_NOTICES.md` | WP-22 | a stranger installs in < 1 hour (dogfood test) |

## Milestone M2 — trust
WP-24 review-only mode; WP-25 ticket readiness linter; WP-26 rebase gate + conflict warnings; WP-27 steer + take-over/hand-back (export, resume instructions); WP-28 cost estimate + budget approval; WP-29 human time accounting; WP-30 autonomy dial + wizard step 4 + settings mirror; WP-31 ask-the-task; WP-32 digest + quiet hours; WP-33 nightly real-LLM smoke + evals in CI (`llm-ci` environment).

## Milestone M3 — show the value
WP-34 shadow mode (closed tickets) + ShadowReport + UI; WP-35 history bootstrap; WP-36 maintenance pipeline; WP-37 risk classes + reviewer routing (CODEOWNERS); WP-38 dependency policy + Checks panel (licence/maintenance status); WP-39 coverage delta; WP-40 epic split (spike variant); WP-41 statistics deep-dive (readiness attribution, clean-first-MR rate, estimate accuracy); WP-42 release 0.1.0 (release-please, changelog, migration notes).

## Suggested agent team for the orchestrator
- **Architect (this role, read-only)** for questions about decisions; **Backend developer** (domain/application/infrastructure), **Integrations developer** (providers + contract tests), **Runner/security developer** (SDK runner, launcher, isolation), **Frontend developer** (SPA), **Prompt engineer** (roles, evals), **Reviewer** (fresh context, security checklist), **Docs writer**. Sequence M1 WPs by dependencies; WP-13 (spike) early because it can change the runner design.

## Definition of done (per WP)
Tests per technical/10 green in CI; coverage thresholds met; contract/golden fixtures added; docs updated; no new `[unverified]` claims in docs without a TODO entry; reviewer approval; conventional commits with DCO.
