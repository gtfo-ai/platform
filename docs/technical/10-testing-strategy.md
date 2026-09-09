# 10 — Testing strategy

> Round 2 design. Decisions: TD-015 (test pyramid and tooling), TD-016 (prompt evals). Source: research/09.

## Levels

| Level | Scope | Tooling | Runs on |
|---|---|---|---|
| **Unit** | domain ring: state machines, policies, budgets, cost math, redaction, config merge, markdown→ADF, template validation | Vitest 5 project `unit`; fast-check property/model-based tests (`fc.commands`) for the task/run/question state machines (every event sequence leaves a legal state; iteration limits and WIP limits never exceeded; budgets never overspent) | every PR, pre-push hook |
| **Integration (DB)** | repositories, event store, dispatcher, projections, pg-boss timers, LISTEN/NOTIFY, migrations, FTS | PGlite per test file for repository/handler tests; Testcontainers Postgres 18 for migrations, extensions, locking, NOTIFY | every PR (`integration.yml`) |
| **Contract** | each integration type's port (`TaskManagementContract`, `GitProviderContract`, `CommunicationContract`, `LogsContract`, `ErrorsContract`) | `describe.each(providers)` against the in-memory fake (PR) and each real adapter in nock **replay** mode with scrubbed recorded fixtures (`test/fixtures/http/<provider>/`); webhook normaliser golden tests from sample payloads | every PR |
| **SDK adapter** | `packages/claude-sdk`: mapping SDK messages → `RunEvent`, hooks, canUseTool policy, budgets, structured output handling | fake `spawnClaudeCodeProcess` replaying recorded NDJSON transcripts (init, success, `error_max_budget_usd`, crash, `permission_denied`, missing structured output) | every PR; small suite because the wire protocol is unstable |
| **Application e2e (fake Claude)** | one ticket through the whole pipeline: webhook → intake → stages → MR events → retro → KB proposal, with `FakeClaudeRunner` replaying scenario fixtures and fake providers | Vitest project `e2e-fake-claude` against `docker compose` (app + db) in CI | every PR (merge queue) |
| **UI** | reducers, components, transcript normaliser (golden fixtures), Playwright e2e with fake SSE backend | Vitest 5 (+ browser mode), Playwright 1.63 | every PR |
| **Prompt evals** | each role prompt against 5–10 recorded cases with schema + field assertions; regression baseline | promptfoo (Agent SDK provider, `max_budget_usd`, JSON schema output) | PRs touching `prompts/**` or the SDK package (environment `llm-ci`, same-repo PRs only); nightly |
| **Real-LLM smoke** | 2–3 tickets end-to-end on a fixture repo with real Claude, Haiku/Sonnet by default | `nightly-llm.yml` + `workflow_dispatch`; cost summary; fails above `LLM_CI_MAX_USD` | nightly on main |
| **Mutation** | `packages/core/src/domain/**` | StrykerJS 10 + vitest runner, `break: 70` | weekly |
| **Security** | dependency and secret scanning, SAST | gitleaks (pre-commit + CI), trufflehog weekly, CodeQL default, Renovate | continuous |

## Fixtures and fakes (first-class code)
- `FakeClaudeRunner`: replays `test/fixtures/claude/<scenario>.jsonl` (our normalised `RunEvent`s incl. a `result` with usage/cost/`structured_output`); scripted `ask_human`, tool policy prompts, budget stops, stalls; used by application tests, the UI dev server and the e2e job.
- `Fake<Type>` providers: in-memory Jira/GitLab/Slack/Sentry/Loki with webhook emitters; exported from the integration packages; also power **shadow mode** (null adapter variant).
- Recording tools: `pnpm record:http --provider gitlab` (nock.back record with redaction hook), `pnpm record:claude --scenario feature-happy-path` (real SDK run → scrubbed fixture). Fixtures must contain only obviously fake secrets; a gitleaks rule scans `test/fixtures/**`.
- Golden transcripts cover: sub-agents, compaction, denied tools, budget stop, structured output failure, steer, interrupt.

## Coverage and gates
- Thresholds in `vitest.config.ts`: domain 90 % lines / 85 % branches / 90 % functions; overall 80 %; `coverage.include` explicit. Codecov for visibility (not required).
- Required checks on `main` (ruleset + merge queue): lint, typecheck, unit, contract, integration, e2e-fake-claude, ui, dco, commitlint.
- Flake policy: `--repeats` nightly; a flaky test is quarantined with an issue within a day.

## Test data rules
- Never real customer tickets/diffs; synthetic fixture repos under `test/fixtures/repos/` (a small TS service with tests and CI config; a Python one later).
- Fixture repos double as onboarding demo projects and shadow-mode demo material.
