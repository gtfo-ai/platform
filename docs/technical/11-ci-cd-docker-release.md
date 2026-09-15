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
| `ci.yml` | `pull_request`, `push: main`, `merge_group` | **as built**: lint, typecheck, bundle budget, unit + contract (coverage upload), ui, web e2e (playwright), integration, e2e-fake-claude, secret scan, commitlint, dco — eleven jobs, and the four `verify:*` groups are one command each (`scripts/verify-targets.ts`, held to this workflow by `scripts/verify.test.ts`). **actionlint, hadolint and zizmor are not among them**: nothing in this repository runs any of the three (WP-42 measured it; the pin check TD-019 wants is `scripts/release.test.ts` instead, over every `uses:` in every workflow) |
| ~~`integration.yml`~~ | — | **absorbed**: the `integration` and `e2e-fake-claude` jobs of `ci.yml`. The e2e tier runs whole `apps/server` instances against the Testcontainers database rather than `docker compose` (the reasoning is in `vitest.config.ts`) |
| `evals.yml` | as designed | **not built — WP-33**, blocked on a model credential (`pnpm eval` says so and exits 1). A release cut without it ships prompts no tier has measured against a model, which `scripts/changelog.mjs` states in the release notes *because* this file is absent |
| `nightly-llm.yml` | as designed | **not built — WP-33**, same blocker, same sentence in the release notes |
| `image.yml` | `push: main`, tags `v*`, `pull_request` (build only), `workflow_dispatch` | native amd64 + arm64 runners, manifest merge; tags `X.Y.Z`, `X.Y`, `X`, `sha-<7>`, `edge` **and `latest` on a tag** (as built — TD-019 says “never `latest` in docs” and the docs name versions, but the registry tag is published; WP-42 files the divergence rather than changing WP-22's file); provenance attestation, **no SBOM** (WP-22 amendment); size check per image. A release reaches it by **`push: tags`** when the tag was created with an administrator's token and by **`workflow_dispatch`** when it was created with `GITHUB_TOKEN` — see `release.yml` below |
| `base-image.yml` | weekly, `workflow_dispatch`, paths `docker/base.Dockerfile` | rebuild base with pinned CLIs |
| `codeql.yml` | default setup | **not built, and no work package owns it** (WP-42 finding) |
| ~~`secrets-scan.yml`~~ | — | **absorbed**: the `secret scan` job of `ci.yml`, gitleaks over the full history. trufflehog is not run |
| `release.yml` | `push: main` | **built at WP-42**: release-please v5 grooms a release PR; a human merges it, which creates `vX.Y.Z`. How the tag reaches `image.yml` depends on the token that created it: with `RELEASE_PLEASE_TOKEN` set the tag push starts `image.yml` by itself and the release **watches that run**; on the `GITHUB_TOKEN` fallback the tag starts nothing — `workflow_dispatch` is the documented exception — so the release dispatches `image.yml` on the tag ref and watches that. Either way the image build's verdict is the release job's. The workflow also appends the upgrade note (migration required or not, derived from the migration files) to the release body. **Never run** — see the amendment below |
| `mutation.yml` | weekly | **not built, and no work package owns it** (WP-42 finding). Mutation testing has been done by hand, per work package |
| `dco.yml` | `pull_request`, `push: main`, `merge_group` | DCO check. Implemented as the `dco` and `commitlint` jobs of `ci.yml`: both walk the commit range of the event (`before..after` on a push, `base..head` otherwise) and fail when the range cannot be determined, so a direct push to `main` is gated exactly like a pull request |
All `uses:` pinned to SHAs — enforced since WP-42 by `scripts/release.test.ts`, over every
`uses:` in every workflow git tracks, because the lint job that was supposed to enforce it runs no
actionlint and no zizmor. Renovate keeps them current. Required checks and merge queue are
configured as a ruleset on `main`; the list of checks an administrator applies is in
`CONTRIBUTING.md` § Branch protection and is held to `ci.yml`'s job names in both directions by the
same test.

**Four of the eleven rows above are still absent**: `evals.yml` and `nightly-llm.yml` are WP-33's
and blocked on a human credential; `codeql.yml` and `mutation.yml` have **no owner at all** and are
filed as discovered work rather than quietly dropped. Six of the others were absorbed into `ci.yml`
as jobs, which is why this table now says which.

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

**How `.env` reaches the process, amended at WP-50.** The `app` and `migrate` services take
`env_file: [{path: .env, required: false}]`, so `.env` **is** the container's environment; only what
compose computes or the topology pins stays in `environment:` (`DATABASE_URL`, `HOST`, `PORT` and
the two in-container data paths), and `environment:` wins over `env_file:`. The hand-written list
this replaced delivered eighteen names while the server reads fifty-nine, so twenty were silently
dropped — including `APP_INTEGRATION_SECRET_ENV`, without which no integration can be created, and
every `<NAME>_FILE` variant, which made the sentence above untrue for every variable. A curated list
cannot be complete in principle: `APP_INTEGRATION_SECRET_ENV` is operator-declared, so the set of
credential names the server must read is unknowable when this file is written. The comparison is
`test/e2e/compose/compose-config.e2e.test.ts`, in both directions, and the live instance is
`scripts/compose-stock-check.mjs`, run from `image.yml` beside `web-compose-check.mjs`. The
`launcher` keeps a list of its own: it is the one container with a route to the daemon (TD-021), and
what it reads is a short fixed set rather than an unknowable one.

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
`/app/apps/web/dist`: a browser needs a bundle. **WP-15j serves it from there**, which is
technical/09's "served as a static bundle by the app process with SPA fallback" and the reason the
image needs no web server in front of it: `/` and every deep link answer the shell, the hashed
assets answer from `assets/`, and `/api`, `/events`, `/webhooks/*` and the probes are untouched
because the fallback answers only paths whose first segment the SPA's own route tree declares. The
directory is stated once (`apps/server/src/web/bundle.ts`) and held to the `COPY` above by
`apps/server/src/web/bundle-path.test.ts`; `APP_WEB_ROOT` overrides it for a patched bundle on a
mounted volume, and a directory that is not there is named in a warning while the API keeps
serving. `node scripts/web-compose-check.mjs` is the daemon-side measurement, beside
`scripts/runlet-container-check.mjs` — and like that one it **runs in CI**: the `build` job of
`image.yml` calls it with `--tag ci --no-build` after the images are built, on both architectures,
so what is measured is the artefact that job is about to publish rather than a second build of the
same tree. The compose project name carries the run id, the attempt and the architecture, the
published port is chosen free, and the teardown is repeated in an `always` step because a cancelled
step has no `finally`. It also asserts what the image puts **on the wire**: the hashed asset arrives
`content-encoding: gzip` for a client that accepts it and decodes to the same bytes, and the shell
carries the framing headers.

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

## Amendment (WP-42, 2026-09-15) — the release mechanism, as built

The workflow table above is corrected in place. What follows is the part of the **Release** section
that turned out to be a plan rather than a description, and one thing it never said.

**One product version, moved by configuration.** TD-019 does not say whether a monorepo releases one
version or one per package, and that choice fell to this work package. It is **one**: every one of
the eleven manifests is `private: true` and nothing is published to a registry, so a per-package
version would be a number with no consumer and eleven chances to disagree. release-please runs in
manifest mode with a **single component at the root** (`release-please-config.json`), and the ten
workspace manifests are `extra-files` of it — so a release moves all eleven in one commit.
`scripts/release.test.ts` reads the manifest set from **git** and fails when one is not covered, and
when the eleven version strings are not the same string.

**They are still `0.0.0`, and that is the bootstrap rather than an omission.** release-please's
manifest reader skips an entry whose value is exactly `0.0.0` (`src/manifest.ts` at v17.6.0), so the
first release PR takes its version from `initial-version` — which is `0.1.0`. Without that key the
first release would be **`1.0.0`**: `initialReleaseVersion()` in `src/strategies/base.ts` returns
`1.0.0` when no previous release is found, and the node strategy does not override it. Moving the
eleven files by hand now would have made the release PR propose `0.2.0` and left `0.1.0` untagged.

**How the tag reaches `image.yml` is a property of the token that created it, and both paths are
built.** An event triggered by `GITHUB_TOKEN` starts no workflow run — `workflow_dispatch` and
`repository_dispatch` are the documented exceptions — and the same page's remedy, a PAT or a GitHub
App installation token, is release-please's own documented reason for recommending one. So with
`RELEASE_PLEASE_TOKEN` set the tag is an ordinary push and `image.yml`'s `push: tags: ['v*']` starts
the build **by itself**; `release.yml` dispatches nothing on that path and watches the run the tag
started. On the `GITHUB_TOKEN` fallback it dispatches `image.yml` on the tag ref and watches that.
The branch is `secrets.RELEASE_PLEASE_TOKEN != ''`, the same expression that chooses the token, so
the two cannot disagree. Dispatching on **both** paths — which the first version of this work
package did — would start a second run on the same ref, and `image.yml`'s
`concurrency: image-<ref>` cancels in progress only for `pull_request`: the second run queues behind the first,
rebuilds five images on two architectures, republishes identical tags, and is waited for under the
same `timeout-minutes: 120`, so a healthy release can go red on that cap. Either way
`GITHUB_REF_TYPE` is `tag` and the existing tag path publishes `X.Y.Z`, `X.Y`, `X`, `sha-<7>` — and
`latest`, which is the divergence Q89 files. No copy of the tag scheme was made. The run is
**watched to its verdict** (`gh run watch --exit-status`): `gh workflow run` returns as soon as the
dispatch is accepted, so a step that only dispatched would report success for a release whose images
never built. **Which** run is watched is decided against a baseline taken *before* release-please
runs — the `image.yml` runs that already existed at this commit — because afterwards an older
`workflow_dispatch` run, or the `push: main` build of the commit being released, is indistinguishable
from the release's own and watching it reports a finished run's verdict. That shell is the one
executable part of the workflow and `scripts/release.test.ts` runs it against a stub `gh` on both
paths, including "an older run exists and the new one is late".

**The same rule applies to the release pull request, and that half needs a credential.** A pull
request opened with `GITHUB_TOKEN` starts no workflow run either, so none of `ci.yml`'s eleven jobs —
`dco` among them — reports on the release PR, which the required checks then make unmergeable.
`release.yml` takes `secrets.RELEASE_PLEASE_TOKEN` (a fine-grained PAT or a GitHub App installation
token, created by an administrator; the name only, never a value — BD-002) and falls back to
`GITHUB_TOKEN` **with the consequence stated in its own header**: no checks on the PR, a
close-and-reopen re-trigger, and a `dco` verdict reachable only through `merge_group` or the
`push: main` run after the merge. Recorded as **Q90**, with the administrator's two steps in
`CONTRIBUTING.md` § *What an administrator sets up once*.

**"Release notes state whether a migration is required" is derived, not written.** `pnpm changelog`
(`scripts/changelog.mjs`) reads `packages/infrastructure/src/db/migrations/` and the previous release
tag; the same script states whether the prompts have been measured against a model by asking whether
`evals.yml` and `nightly-llm.yml` exist, so that sentence retires itself when WP-33 lands. Both
answers are appended to the release body by `release.yml`. `CHANGELOG.md` is generated by the same
command and its current section is a **preview**: release-please writes the released one when the
PR is merged, inserting it above the preview's heading (its updater's documented insertion rule),
and the release PR is where the preview is deleted.

**TD-019's "the app refuses to start when the DB schema is newer than the code" now has a caller.**
`findUnknownMigrations` existed from WP-03 and nothing called it; `startRuntime` now asks
`assertSchemaIsKnown` before it composes anything, and a database carrying a migration this build
does not know is a named refusal rather than a `/readyz` line on a process that is already serving.
Both directions are asserted against a real PostgreSQL in
`test/integration/db/schema-guard.integration.test.ts`.

**None of `release.yml` has ever run**, and it cannot be run from a checkout. Every claim in its
header was read out of a pinned source — the action at `45996ed`, release-please 17.6.0, GitHub's
own documentation — and `scripts/release.test.ts` asserts only what is a property of the files. The
one prediction that is load-bearing and unmeasured is the identity release-please's commits carry,
which the `signoff` key has to match or the `dco` job fails the release commit — on the pull request
when an administrator's token opened it, and otherwise not until the `push: main` run after the
merge, which is too late to stop the tag (standing rule 86: it is labelled a prediction where it
lives, and the key changes with the token, Q90).

**The hygiene list is complete.** `CODE_OF_CONDUCT.md` (Contributor Covenant 2.1),
`.github/CODEOWNERS` and `.github/ISSUE_TEMPLATE/` (bug, feature, integration request, and the
chooser) were the three TD-019 named and this repository did not have. The layout block at the top
of this document still lists `dependabot.yml (security only)`, which does not exist and is not
planned: `renovate.json` is what keeps the pins current.

