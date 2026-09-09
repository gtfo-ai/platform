# PROGRESS — implementation ledger

> Maintained by the orchestrator (docs/technical/14-orchestration-protocol.md). Statuses: TODO · IN_PROGRESS · REVIEW · DONE · BLOCKED. Keep entries short; details go in the WP's notes section below.

## Resume note

(none yet — first run starts at WP-00)

## Blocker briefs needing a human

(none)

## Milestone M1 — the loop

| WP | Title | Depends | Parallel-safe | Status | Commit | Notes |
|---|---|---|---|---|---|---|
| WP-00 | Repo scaffold | — | no | TODO | — | |
| WP-01 | `packages/contracts` | WP-00 | no | TODO | — | |
| WP-02 | `packages/domain` | WP-01 | no | TODO | — | |
| WP-03 | Postgres schema + Drizzle + migrations (technical/03) | WP-00 | no | TODO | — | |
| WP-04 | Event store + priority dispatcher + outbox job (TD-005) | WP-02, WP-03 | no | TODO | — | |
| WP-05 | Jobs port on pg-boss | WP-03 | no | TODO | — | |
| WP-06 | Fastify server skeleton (TD-002) | WP-04 | no | TODO | — | |
| WP-07 | Integration ports + fakes + contract test suites | WP-04 | no | TODO | — | |
| WP-08 | Jira Cloud provider | WP-07 | yes | TODO | — | |
| WP-09 | GitLab provider (gitlab.com + self-managed) | WP-07 | yes | TODO | — | |
| WP-10 | Slack provider | WP-07 | yes | TODO | — | |
| WP-11 | Sentry + Loki providers | WP-07 | yes | TODO | — | |
| WP-12 | Claude SDK runner (technical/04) | WP-04, WP-05 | no | TODO | — | |
| WP-13 | Run shim `agentic-runlet` (TD-025) | WP-12 | no | TODO | — | |
| WP-14 | Launcher service + `WorkspaceProvider` (docker + fake) | WP-13 | no | TODO | — | |
| WP-15 | Pipeline interpreter + stage executor + sagas (technical/02) | WP-04…WP-12 | no | TODO | — | |
| WP-16 | Context packs + KB indexer (phase 1 FTS) + code map (ctags + PageRank) | WP-03, WP-12 | no | TODO | — | |
| WP-17 | Role prompts + artifact schemas + eval sets (product/13, TD-016) | WP-12 | yes | TODO | — | |
| WP-18 | Librarian pipeline + proposals + apply policy + knowledge MR flow + ni | WP-16, WP-17 | no | TODO | — | |
| WP-19 | Cost ledger, rollups, budgets projection, price table maintenance job, | WP-04 | no | TODO | — | |
| WP-20 | Web app foundation (TD-013) | WP-06 | yes | TODO | — | |
| WP-21 | Onboarding wizard steps 1–5 incl. discovery agent and readiness evalua | WP-16, WP-17, WP-20 | no | TODO | — | |
| WP-22 | Docker images (base, runtime, launcher, product), Compose (profiles `l | WP-14 | no | TODO | — | |
| WP-23 | Docs | WP-22 | yes | TODO | — | |

## Milestone M2 — trust

| WP | Title | Status | Commit | Notes |
|---|---|---|---|---|
| WP-24 | review-only mode | TODO | — | |
| WP-25 | ticket readiness linter | TODO | — | |
| WP-26 | rebase gate + conflict warnings | TODO | — | |
| WP-27 | steer + take-over/hand-back (export, resume instructions) | TODO | — | |
| WP-28 | cost estimate + budget approval | TODO | — | |
| WP-29 | human time accounting | TODO | — | |
| WP-30 | autonomy dial + wizard step 4 + settings mirror | TODO | — | |
| WP-31 | ask-the-task | TODO | — | |
| WP-32 | digest + quiet hours | TODO | — | |
| WP-33 | nightly real-LLM smoke + evals in CI (`llm-ci` environment). | TODO | — | |

## Milestone M3 — show the value

| WP | Title | Status | Commit | Notes |
|---|---|---|---|---|
| WP-34 | shadow mode (closed tickets) + ShadowReport + UI | TODO | — | |
| WP-35 | history bootstrap | TODO | — | |
| WP-36 | maintenance pipeline | TODO | — | |
| WP-37 | risk classes + reviewer routing (CODEOWNERS) | TODO | — | |
| WP-38 | dependency policy + Checks panel (licence/maintenance status) | TODO | — | |
| WP-39 | coverage delta | TODO | — | |
| WP-40 | epic split (spike variant) | TODO | — | |
| WP-41 | statistics deep-dive (readiness attribution, clean-first-MR rate, estimate accuracy) | TODO | — | |
| WP-42 | release 0.1.0 (release-please, changelog, migration notes). | TODO | — | |

## WP notes (decisions, assumptions, reviewer findings)

### WP-00
(none)

## Discovered work (not in plan)

(none)

## Milestone notes

(none)
