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
| `dco.yml` | `pull_request`, `push: main`, `merge_group` | DCO check. Implemented as the `dco` and `commitlint` jobs of `ci.yml`: both walk the commit range of the event (`before..after` on a push, `base..head` otherwise) and fail when the range cannot be determined, so a direct push to `main` is gated exactly like a pull request |
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

## Amendment (WP-22, 2026-09-12) — as built

Recorded from the implementation, because five of the statements above are now false in a way a
reader would otherwise take as a plan rather than as history. Docs win over code (standing rule 8),
so the differences are written here rather than left in the files.

**Five Dockerfiles, not two.** `docker/base.Dockerfile`, `docker/runtime.Dockerfile`,
`docker/egress.Dockerfile`, `docker/app.Dockerfile`, `docker/launcher.Dockerfile`. The three extra
ones are the images TD-021 requires and this document never listed: the run container, the egress
sidecar, and the launcher — which must be its own container, not a `ROLE`, for the reasons TD-021's
WP-15g amendment ranks.

**The bundled CLIs moved from `platform-base` to `platform-runtime`, and it was measured rather
than preferred.** With `glab`, `gh`, `acli`, `jira`, `logcli`, `sentry-cli` and `@sentry/mcp-server`
in the base, that image is **1.0 GB**, so the product image built on it cannot meet the ≤ 1 GB size
check this document asks for — while the run container, the only thing that uses them, would carry
the platform's server dependencies. They are declared in the code as *agent* tooling
(`AgentTooling.cli` is "what an agent may be handed inside a run") and no platform process shells
out to one; every provider adapter speaks HTTP. Without them the base is **547 MB** and both
budgets hold.

**The size check is per image, and 1 GB is not one number.** `scripts/build-images.mjs --size-check`
holds each image to its own ceiling, roughly a third above what it measures — budget (measured):
base **750 MB** (547 MB), runtime **1.8 GB** (1.32 GB), egress **64 MB** (13.2 MB), product
**1.4 GB** (1.1 GB), launcher **1.4 GB** (966 MB). The run image cannot meet 1 GB and should not
try: TD-021 puts the `claude` binary in it (217 MB) beside the six agent CLIs (260 MB), which is
half a gigabyte before anything of ours; the product image carries the same `claude` binary because
the SDK's optional platform package comes with it (207 MB of its 1.1 GB).

**And they bound the *unpacked* size, which is not the number two obvious commands return.** On a
containerd image store `docker image inspect --format '{{.Size}}'` and `docker save … | wc -c` both
report the **compressed content** — measured here, `130 357 549` and `130 378 240` bytes for the
image `docker images` calls `547MB` — while on a classic store the same commands return the unpacked
size. WP-22's first round checked the compressed number against ceilings derived from the unpacked
one, so every budget was loose by about 4×. The script reads `docker images --format '{{.Size}}'`,
which is the unpacked total on both stores, and says so at the line (standing rule 64).

**The product image runs the TypeScript sources, not a `dist/`.** There is no build step for the
server rings — `pnpm dev` and `pnpm db:migrate` run the sources through
`scripts/ts-source-resolver.mjs`, Node 24 strips the types — and this work package is where that
packaging decision was due. It is taken the way that keeps one code path: the image runs what CI
tested, byte for byte, with no second module-resolution scheme to keep true. The entrypoint is
`node --import ./scripts/ts-source-resolver.mjs apps/server/src/main.ts`, and `migrate` is the same
entrypoint with `apps/server/src/migrate.ts`. `apps/web` **is** built, by Vite, into
`/app/apps/web/dist`: a browser needs a bundle. Nothing serves that bundle yet — technical/09's
"served as a static bundle by the app process with SPA fallback" has no implementation — and the
gap is in PROGRESS rather than hidden behind an environment variable nothing reads.

**Compose: an override file for local mode, a profile for the backup, and a socket proxy.** The
services are `db`, `migrate`, `app`, `docker-socket-proxy`, `launcher` and (profile `backup`)
`db-backup`; local mode is `-f compose.yml -f compose.local.yml`, exactly the layout above.

WP-22 first tried `COMPOSE_PROFILES=local` with a second `app-local` service and **that was wrong**:
a service *without* `profiles` always runs, so enabling the profile started both, each publishing
`${APP_PORT}:8080`, and the second could not bind. Compose has no "instead of" for profiles; an
override changes the service that exists. `test/e2e/compose/compose-config.e2e.test.ts` now asserts
the service set and the port publishers under the default, the override and an enabled `local`
profile, so the next profile-gated service is a deliberate edit rather than a bind error at
`docker compose up`. Two consequences worth stating:

- the **socket is in `docker-socket-proxy` only**, on an `internal: true` network that only
  `launcher` joins, with `CONTAINERS`/`NETWORKS`/`VOLUMES`/`IMAGES`/`POST` on and `EXEC`/`BUILD`/
  `SECRETS` off. `app` — which serves `/webhooks/*` unauthenticated — has no socket, no
  `DOCKER_HOST` and no route to the proxy;
- local mode does **not** mount `${CLAUDE_BINARY}` and `${CLAUDE_CONFIG_DIR}` from the
  host, as the sketch above imagined. The CLI runs in the per-run `platform-runtime` container,
  which technical/05 forbids giving any host mount, and the launcher has no variable that would add
  one. Local mode here means the platform authenticates as a subscription; the binary is the run
  image's.

**`image.yml` and `base-image.yml`, as built.** Native runners for both architectures
(`ubuntu-latest`, `ubuntu-24.04-arm`), a per-architecture tag each, and one `imagetools create` per
image to merge them — a tag rather than a digest, because five images' digests would otherwise be
passed between jobs. The build itself is `scripts/build-images.mjs`, so the workflow holds no second
copy of which Dockerfile makes which image (standing rule 7). A pull request builds and size-checks
and never pushes. `base-image.yml` **builds and does not push**: publishing from a schedule would
put an image in the registry that no commit produced, and what the weekly run buys is the signal
that a pin has rotted.

**Signing needed no credential.** This repository has no secrets and no environments, so the
`gh secret list` check that would normally end in a blocker brief ended instead in
`actions/attest-build-provenance`, whose identity is the workflow's OIDC token against Sigstore's
public instance. Provenance is attested and pushed to the registry for each merged manifest list;
`gh attestation verify oci://ghcr.io/<owner>/platform --repo <owner>/platform` is the operator's
check. **Not** done, and not claimable: an SBOM attestation. BuildKit can produce one
(`--sbom=true`), but only when the image is *pushed by buildx*, and these images are pushed by
`docker push` after a plain build so that one script builds everywhere. That is a stated gap, not a
silent one.
