# Research: testing, prompt evals, GitHub Actions, Docker, release, hygiene (2026-09-09)

> Versions verified against npm/GitHub on 2026-09-09. Informs TD-015…TD-020 and technical/10, /11.

## Test tooling (TypeScript)
| Package | Version | Licence | Note |
|---|---|---|---|
| vitest / @vitest/coverage-v8 | 5.0.0 (2026-09-03), Node ≥ 22.12 | MIT | `test.projects` (unit, integration, contract, e2e-fake-claude); `vi.when()`, `--repeats` for flake detection; 4.1 as fallback. https://vitest.dev/blog/vitest-5 |
| @electric-sql/pglite | 0.5.8 | Apache-2.0 | real Postgres in WASM, per-file instance; single-user mode, few extensions |
| testcontainers / @testcontainers/postgresql | 12.1.0 | MIT | migrations, FTS/extensions, LISTEN/NOTIFY, locking tests; Docker available on `ubuntu-latest` |
| nock | 14.0.17 | MIT | native `fetch` supported since 14.0.0; `nock.back` record/replay (`lockdown` in CI); Polly.js unmaintained (2023) |
| fast-check | 4.9.0 | MIT | `fc.commands` model-based tests for the pipeline state machine, budgets, redaction |
| @stryker-mutator/core + vitest-runner | 10.0.0 | Apache-2.0 | weekly, scoped to `domain/**`; incremental-mode bug #6004 open |
| typescript | 7.0.2 (Go compiler) | Apache-2.0 | verify toolchain compatibility, else 6.x |

Coverage: v8 provider, explicit `coverage.include`, thresholds domain 90/85, overall 80; Codecov action v7 for PR diffs (not a required check). Python equivalents: pytest 9.1, hypothesis 6.168, respx 0.23, vcrpy 8.3, mutmut 3.7, testcontainers 4.15.

## Testing code that uses the Agent SDK (verified from SDK 0.3.266 tarball + docs)
- **No official mock** for `query()`. Test-oriented exports: `InMemorySessionStore` (alpha). The official seam is **`spawnClaudeCodeProcess?: (options: SpawnOptions) => SpawnedProcess`** ("run Claude Code in VMs, containers, or remote environments"): NDJSON over stdin/stdout with an **undocumented, unstable control protocol** (`initialize`, `can_use_tool`, `hook_callback`, `mcp_message`, `set_permission_mode`, …). https://github.com/anthropics/claude-code/issues/24594 , third-party notes https://github.com/Roasbeef/claude-agent-sdk-go/blob/main/docs/cli-protocol.md
- Three layers: (1) our own `ClaudeRunner` port + `FakeClaudeRunner` replaying normalised JSONL fixtures for all business logic; (2) SDK adapter tests injecting a fake `SpawnedProcess` replaying a recorded raw transcript (keep small: init, success, `error_max_budget_usd`, crash, `permission_denied`, missing structured output); (3) gated real-LLM runs.
- Real-LLM gating (OpenHands pattern, verified in `software-agent-sdk/.github/workflows/integration-runner.yml`): label-triggered `pull_request_target` — accept only for same-repo PRs, prefer `workflow_dispatch` + nightly on main; GitHub environment `llm-ci` with `ANTHROPIC_API_KEY` from a dedicated Console workspace with a spend limit (https://platform.claude.com/docs/en/manage-claude/workspaces); `maxBudgetUsd` per query; job timeout; sum `total_cost_usd` into the job summary and fail above `LLM_CI_MAX_USD`; authoritative spend via the Usage and Cost API. `total_cost_usd` is a client-side estimate; `structured_output` may be undefined with `subtype: success` → treat as failure. https://code.claude.com/docs/en/agent-sdk/troubleshooting
- pnpm: add `@anthropic-ai/claude-agent-sdk` and `@anthropic-ai/claude-code` to `pnpm.onlyBuiltDependencies`; never `--omit=optional` (native binary). https://pnpm.io/supply-chain-security

## Prompt evals
- **promptfoo 0.122** (MIT; acquired by OpenAI 2026-03, "will remain open source") has an `anthropic:claude-agent-sdk` provider with `working_dir`, `setting_sources`, `append_system_prompt`, `allowed tools`, `mcp`, `max_turns`, **`max_budget_usd`**, **`output_format` json_schema**, caching; assertions `is-json` (schema), `javascript`, `llm-rubric`; GitHub Action `promptfoo/promptfoo-action@v1`. https://www.promptfoo.dev/docs/providers/claude-agent-sdk/ . Its `apiKeyRequired: false` mode uses the local Claude session — must not be used in CI (BD-004).
- Braintrust/LangSmith: SaaS, results off-repo → poor fit for build-in-public.
- Anthropic guidance (https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents): code graders > model graders > humans; 20–50 tasks from real failures; unambiguous pass/fail; regression suite at ~100% separate from capability evals; read transcripts.
- Layout: `prompts/<role>/prompt.md`, `schema.json`, `evals/cases.yaml` (5–10 recorded tickets/diffs, scrubbed), `evals/baseline.json` committed nightly; PR job fails if a previously passing hard case fails or pass rate drops > 5 pp. Prompt version = hash(prompt + schema) in the run audit.

## GitHub Actions
- Latest majors (all Node 24; **Node 20 removed from hosted runners 2026-09-23**): checkout v7, setup-node v7, pnpm/action-setup v6, docker/* v4–v7, `docker/github-builder` v1 reusable multi-platform workflow, attest-build-provenance v4, attest-sbom v4, anchore/sbom-action v0.24, gitleaks-action v3 (org repos need a free licence key), trufflehog v3.97, codecov v7, release-please v5, KineticCafe/actions-dco v3, actionlint, hadolint, zizmor.
- **Native arm64 runners are free for public repos** (`ubuntu-24.04-arm`) → no QEMU. https://github.blog/changelog/2025-08-07-arm64-hosted-runners-for-public-repositories-are-now-generally-available/
- Workflows: `ci.yml` (lint/typecheck/unit/contract; `pull_request`, `push: main`, `merge_group`), `integration.yml` (Testcontainers + provider replay + fake-Claude e2e via compose), `evals.yml` (paths `prompts/**`, environment `llm-ci`, same-repo PRs only), `nightly-llm.yml`, `image.yml` (main + tags; registry cache for main, gha cache for PRs; tags `X.Y.Z`, `X.Y`, `X`, `sha-<7>`, `edge`; provenance + SBOM attestations = SLSA Build L2), `base-image.yml` (weekly rebuild), `codeql.yml` (default setup), `secrets-scan.yml` (gitleaks on PR/push, trufflehog weekly, push protection on), `release.yml`, `mutation.yml` (weekly), `dco.yml`. Rulesets on `main` with merge queue. Pin `uses:` to SHAs.
- Dependencies: **Renovate** (`config:best-practices`, weekly, custom regex managers for `ARG *_VERSION` in the base Dockerfile) + Dependabot security alerts only. https://docs.renovatebot.com/upgrade-best-practices/
- Licence compliance: `pnpm licenses list --prod --json` against an allow-list; `THIRD_PARTY_NOTICES.md` incl. bundled binaries (logcli AGPL-3.0 — executed via CLI only, GPL FAQ "mere aggregation"; acli proprietary `[verify redistribution]`; sentry-mcp FSL; Claude Code binary Anthropic proprietary `[verify image redistribution; fallback: install at build from the signed apt repo or at first start]`).

## Docker
- Claude Code supports Debian 10+/Ubuntu 20.04+/Alpine 3.19+ (musl needs extra libs), x64/arm64, 4 GB RAM; signed apt/dnf/apk repos; **refuses bypass-permissions mode as root** → non-root runner user. https://code.claude.com/docs/en/setup , https://github.com/anthropics/claude-code/issues/9184
- Base: `node:24-trixie-slim` (Debian 13, 85 MB compressed, multi-arch; Node 24 Active LTS until Oct 2027) + git, jq, bash, ripgrep, openssh-client + pinned CLIs; user `agentic` uid 1000. Product image installs the Agent SDK (pins the Claude binary to the SDK version). **Not distroless** (agents need a shell). Size target base 350–450 MB, product ≤ 1 GB (CI check). Start-up doctor step runs a binary check.
- Compose: `db` (Postgres, healthcheck), `migrate` one-shot (`depends_on: db: service_healthy`), `app` (`depends_on: migrate: service_completed_successfully`), `runner`; profile `local` adds a runner mounting the operator's binary and `~/.claude` with `CLAUDE_CODE_OAUTH_TOKEN` (BD-004). Secrets via `<NAME>_FILE` (compose secrets). https://docs.docker.com/compose/how-tos/profiles/
- Env naming: integration credentials keep tool-native names the CLIs read (`GITLAB_TOKEN`, `JIRA_API_TOKEN`, `LOKI_ADDR`, `SENTRY_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`); platform config under one prefix (decided in TD-020 as `APP_`, rename-friendly per BD-014).

## Release
- **release-please v5** (conventional commits → release PR → tag `vX.Y.Z`; human merges the release PR) + commitlint 21 in lefthook `commit-msg` and CI; changesets only if npm packages are published; semantic-release rejected (releases on every push).
- Forward-only migrations run by the one-shot `migrate` service with an advisory lock; app refuses to start if DB schema is newer than the code; release notes state "requires migration". `.agentic` files carry `version`; JSON Schemas published under `schemas/` and served by the app; loader upcasts N-1 in memory and proposes a migration (BD-018), never rewrites the user's repo.

## Hygiene
CONTRIBUTING, CODE_OF_CONDUCT (Contributor Covenant 2.1), SECURITY (private vulnerability reporting), CODEOWNERS (`/prompts/`, `/docs/decisions/`, `/.github/`), issue forms, PR template with "no secrets" checkbox, **lefthook 2.1** (pre-commit: lint, typecheck, `gitleaks protect --staged`; commit-msg: commitlint; pre-push: unit), `.editorconfig`, `packageManager` (pnpm 12), **DCO not CLA** (Apache-2.0, no relicensing intent; agent commits add `Signed-off-by`). https://tenthirtyam.org/dispatches/2026/04/08/dco-vs-cla-managing-contribution-agreements-in-open-source/
