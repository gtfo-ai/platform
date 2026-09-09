# 11 — CI/CD, Docker images, release

> Round 2 design. Decisions: TD-017 (GitHub Actions), TD-018 (Docker images and Compose), TD-019 (release engineering). Source: research/09, research/03, BD-002, BD-020.

## Repository layout (CI-relevant)
```
.github/workflows/  ci.yml integration.yml evals.yml nightly-llm.yml image.yml base-image.yml release.yml codeql.yml secrets-scan.yml mutation.yml dco.yml
.github/ISSUE_TEMPLATE/  bug.yml feature.yml integration-request.yml config.yml ; PULL_REQUEST_TEMPLATE.md ; CODEOWNERS ; dependabot.yml (security only)
renovate.json lefthook.yml commitlint.config.js .editorconfig .gitleaks.toml
docker/base.Dockerfile docker/app.Dockerfile compose.yml compose.local.yml .env.example
THIRD_PARTY_NOTICES.md LICENSE CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md
```

## Workflows
| Workflow | Trigger | Jobs |
|---|---|---|
| `ci.yml` | `pull_request`, `push: main`, `merge_group` | lint (Biome + actionlint + hadolint + zizmor), typecheck, unit+contract (coverage upload), ui, build |
| `integration.yml` | same | Testcontainers Postgres suite; provider replay suites; fake-Claude e2e via `docker compose` |
| `evals.yml` | `pull_request` paths `prompts/**`, `packages/claude-sdk/**` (same-repo PRs only), `workflow_dispatch` | promptfoo with cache restore, artifact upload, PR comment; budget `EVAL_MAX_USD`; environment `llm-ci` |
| `nightly-llm.yml` | `schedule 03:00 UTC`, `workflow_dispatch` | real-LLM smoke; cost summary; opens/updates a failure issue |
| `image.yml` | `push: main`, tags `v*`, `pull_request` (build only) | native amd64 + arm64 runners, manifest merge; tags `X.Y.Z`, `X.Y`, `X`, `sha-<7>`, `edge`; registry cache on main, gha cache on PRs; provenance + SBOM attestations (SLSA Build L2); size check ≤ 1 GB |
| `base-image.yml` | weekly, `workflow_dispatch`, paths `docker/base.Dockerfile` | rebuild base with pinned CLIs |
| `codeql.yml` | default setup | JS/TS security-extended |
| `secrets-scan.yml` | PR/push; weekly | gitleaks (full history); trufflehog verified-only |
| `release.yml` | `push: main` | release-please release PR; on merge: tag → `image.yml` |
| `mutation.yml` | weekly | Stryker on domain |
| `dco.yml` | `pull_request` | DCO check |
All `uses:` pinned to SHAs; Renovate keeps them current. Required checks and merge queue configured as a ruleset on `main`.

## Images
- **`platform-base`** (`docker/base.Dockerfile`): `node:24-trixie-slim` pinned by digest; `git jq bash ripgrep ca-certificates openssh-client curl`; pinned CLIs with `TARGETARCH` switches: `glab`, `gh`, `acli`, `jira`, `logcli`, `sentry-cli`, `@sentry/mcp-server`; user `agentic` (uid 1000); `THIRD_PARTY_NOTICES.md` copied in. Rebuilt weekly.
- **`platform`** (`docker/app.Dockerfile`): stages `deps` (pnpm, `onlyBuiltDependencies` for the SDK packages, never `--omit=optional`; remove the unused musl/glibc SDK platform package), `build` (server + web), final `FROM platform-base`: copy `node_modules` + `dist`, `USER agentic`, `HEALTHCHECK` via `node dist/healthcheck.js`, `ENTRYPOINT ["node","dist/main.js"]`, `ROLE` env selects `all | api | worker | runner | indexer`. Start-up doctor verifies the Claude binary (`local` mode: the mounted one).
- Multi-arch amd64/arm64; digests published in release notes; `gh attestation verify` documented.

## Compose
```yaml
services:
  db:       image: postgres:18 (volume /var/lib/postgresql) ; healthcheck
  migrate:  image: platform ; command: node dist/migrate.js ; depends_on: db: service_healthy
  app:      image: platform ; ROLE=all ; depends_on: migrate: service_completed_successfully ; ports 8080
  runner:   image: platform ; ROLE=runner ; volumes: workspaces ; (isolation per TD-021)
  db-backup: prodrigestivill/postgres-backup-local ; volume backups
profiles:
  local:    runner-local: mounts ${CLAUDE_BINARY} and ${CLAUDE_CONFIG_DIR}; APP_PROVIDER_MODE=local; passes CLAUDE_CODE_OAUTH_TOKEN
```
Secrets via env or `<NAME>_FILE`. `.env.example` lists every variable with defaults (no secret values).

## Release
- release-please (conventional commits → release PR → tag `vX.Y.Z`); commitlint enforced by lefthook and CI; agents sign off commits (DCO).
- Migrations forward-only, run by the `migrate` service with an advisory lock; the app refuses to start when the DB schema is newer than the code; release notes state whether a migration is required; `pg_dump` before upgrade documented.
- `.agentic` schema `version` with JSON Schemas under `schemas/` served by the app for editor validation; N-1 upcast in memory + migration proposal.
- Hygiene: CONTRIBUTING, CODE_OF_CONDUCT, SECURITY (private reporting), CODEOWNERS, issue forms, PR template with a "no secrets" checkbox, lefthook (lint, typecheck, gitleaks, commitlint, unit on push), DCO.
