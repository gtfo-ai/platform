# syntax=docker/dockerfile:1.19
#
# `platform` — the product image (BD-020, technical/11 § Images).
#
# One image, several containers: `ROLE` selects `all | api | worker | runner | indexer`, and the
# `migrate` service runs the same entrypoint `pnpm db:migrate` does.
#
# ## It runs the TypeScript sources, and that is a decision rather than an omission
#
# technical/11 wrote this image as `dist/` plus `node dist/main.js`. There is **no build step for
# the server rings** in this repository — CLAUDE.md states it, `pnpm dev` and `pnpm db:migrate` run
# the sources through `scripts/ts-source-resolver.mjs`, which maps the repository's `.js`
# specifiers onto the `.ts` files on disk — and WP-22 is the work package technical/11 left that
# packaging decision to. It is taken the way that keeps one code path: the image runs what a
# developer runs, so a `tsc` emit cannot be subtly different from the tested sources, and there is
# no second module-resolution scheme to keep true. Node 24 strips the types itself.
#
# What it costs, stated: the image carries `.ts` sources (a few MB) and every start pays type
# stripping (milliseconds, cached by Node). What it buys is that the thing CI tests and the thing
# the image runs are the same bytes. The amendment is recorded in technical/11.
#
# **`apps/web` is the exception and is built**, because a browser needs a bundle: the `web` stage
# runs Vite and the result is copied to `/app/apps/web/dist`. **`apps/server` serves it from there
# since WP-15j** — technical/09's "served as a static bundle by the app process with SPA fallback",
# on the same origin as `/api` and `/events`. The path is stated once, in
# `apps/server/src/web/bundle.ts`, and `apps/server/src/web/bundle-path.test.ts` reads the `COPY`
# below to hold the two equal: moving either fails a test instead of 404ing only inside the image.
# `APP_WEB_ROOT` overrides it for an operator serving a patched bundle from a mounted volume.
ARG BASE_IMAGE=platform-base:dev
# The pg-boss schema version `runMigrations` installs (TD-032 decision 2, WP-272), for the
# `org.platform.pgboss-schema` label below. A `LABEL` cannot take a value a `RUN` computed, so this
# is the one place the number is written — and it is never trusted: the `deps` stage checks it
# against the installed pg-boss's own `pgboss.schema` and fails the build on a mismatch, and
# `packages/infrastructure/src/db/image-labels.test.ts` compares it with the version pg-boss writes
# into its own construction plan. Bump it with pg-boss; nothing else should ever set it.
ARG PGBOSS_SCHEMA=40

# ── The SPA bundle ───────────────────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS web
# A build stage: nothing runs as this stage, so ending it as root is not DL3002's concern
# (`.hadolint.yaml` has the reasoning; the final stage still ends `USER agentic` and is checked).
# hadolint ignore=DL3002
USER root
WORKDIR /src
RUN corepack enable pnpm
# Every workspace manifest: `--frozen-lockfile` compares the lockfile against the importers it
# finds on disk, so a missing `package.json` reads as a lockfile that is out of date.
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/application/package.json packages/application/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/integrations/package.json packages/integrations/
COPY packages/prompts/package.json packages/prompts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/launcher/package.json apps/launcher/
COPY apps/runlet/package.json apps/runlet/
RUN pnpm install --frozen-lockfile --filter @platform/web... --ignore-scripts
COPY packages/contracts packages/contracts
COPY apps/web apps/web
# The build's commit, compiled into the bundle (WP-154 (d), PROGRESS backlog 487): the same
# `APP_COMMIT` the final stage hands `GET /api/version`, so an open tab can tell an upgraded server
# from a contract defect. `vite.config.ts` reads it; empty is `dev`. Declared here, after the
# install, so a new commit re-runs only the build, and held by `scripts/web-build-commit.test.ts`.
ARG APP_COMMIT=
RUN APP_COMMIT="${APP_COMMIT}" pnpm --filter @platform/web run build

# ── Production dependencies ──────────────────────────────────────────────────────────────────────
# `--prod` and the server's sub-graph only: no vitest, no biome, no playwright, no vite.
#
# The Agent SDK's per-platform binary (`@anthropic-ai/claude-agent-sdk-linux-*`) is **removed**
# after the install (WP-82, PROGRESS backlog 34). The SDK resolves its own bundled binary only when
# `pathToClaudeCodeExecutable` is unset, and a containerised run always sets it to the path the
# launcher verified inside the run image (`options.ts`), so this process never executes, stats or
# resolves that package. This comment used to say the opposite — that the SDK checks the executable
# exists on this side before `spawnClaudeCodeProcess` — which is false for 0.3.267: the only
# `existsSync` is in the message it builds *after* a local spawn failed. Measured rather than read:
# `node scripts/launcher-control-plane-check.mjs --runner-image platform:dev` runs a run end to end
# with this image's own tree as the runner, with no such package in it. The `claude` a run executes
# is `platform-runtime`'s, which installs the package in its own build (`runtime.Dockerfile`).
FROM ${BASE_IMAGE} AS deps
# A build stage (see `web` above).
# hadolint ignore=DL3002
USER root
WORKDIR /src
RUN corepack enable pnpm
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json tsconfig.base.json ./
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/application/package.json packages/application/
COPY packages/infrastructure/package.json packages/infrastructure/
COPY packages/integrations/package.json packages/integrations/
COPY packages/prompts/package.json packages/prompts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/launcher/package.json apps/launcher/
COPY apps/runlet/package.json apps/runlet/
# `@node-rs/argon2` and the SDK ship per-OS binaries, which is why this install happens here and
# never on a developer's host.
# `--ignore-scripts`: the only lifecycle scripts in this workspace are the root's
# `prepare` (`lefthook install`, a git hook installer that is not in a `--prod` tree and
# exits 127 here) and `@b12k/gitleaks`'s binary download — both developer tooling, neither
# a runtime dependency. `@node-rs/argon2` and the Agent SDK ship prebuilt per-platform
# binaries and run no script at all.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @platform/server... \
 && pnpm store prune \
 && rm -rf node_modules/.pnpm/@anthropic-ai+claude-agent-sdk-linux-*
# The label's pg-boss schema version, derived: read off the pg-boss this image installed — the one
# `packages/infrastructure` resolves, so the one `runMigrations` runs — and compared with the
# global `PGBOSS_SCHEMA` the label is written from (WP-272).
ARG PGBOSS_SCHEMA
RUN set -eu; \
    installed="$(node -p "require(require.resolve('pg-boss/package.json',{paths:['./packages/infrastructure']})).pgboss.schema")"; \
    if [ "$installed" != "${PGBOSS_SCHEMA}" ]; then \
      echo "PGBOSS_SCHEMA=${PGBOSS_SCHEMA}, but the installed pg-boss installs schema ${installed}: set the global ARG at the top of docker/app.Dockerfile to it" >&2; \
      exit 1; \
    fi

# ── The image ────────────────────────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS app
USER root
WORKDIR /app

# `node_modules` first (it changes with the lockfile), sources after (they change every commit).
COPY --from=deps --chown=agentic:agentic /src/node_modules ./node_modules
COPY --from=deps --chown=agentic:agentic /src/packages ./packages
COPY --from=deps --chown=agentic:agentic /src/apps ./apps
COPY --chown=agentic:agentic package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY --chown=agentic:agentic scripts/ts-source-resolver.mjs ./scripts/
COPY --chown=agentic:agentic packages ./packages
COPY --chown=agentic:agentic apps/server ./apps/server
COPY --chown=agentic:agentic schemas ./schemas
COPY --from=web --chown=agentic:agentic /src/apps/web/dist ./apps/web/dist

# Where the launcher writes take-over export tarballs (`APP_WORKSPACE_EXPORT_DIR`) and where the
# knowledge indexer keeps its per-project bare mirrors (`APP_KNOWLEDGE_MIRROR_ROOT`, TD-026). Both
# are data: the compose file gives each a named volume. Created here so the directory exists and is
# owned by the uid the process runs as, rather than appearing as `root:root` on first mount.
# WP-284 (TD-032 decision 3): the worker compose template, baked in so the core renders the bytes of
# the build it runs (`GET /api/worker/v1/compose.yml`) and an updater reads it from a verified new
# image, never from the core. Root-owned and read-only: nothing at run time writes it.
COPY compose.worker.yml /opt/platform/compose.worker.yml

# `/var/lib/platform/*` are a remote worker's two volumes (`compose.worker.yml`): a named volume
# takes the ownership of the directory it is first mounted over, so the image's `agentic` owns them.
RUN mkdir -p /var/lib/app/exports /var/lib/app/knowledge \
      /var/lib/platform/worker-state /var/lib/platform/launcher-token \
 && chown -R agentic:agentic /var/lib/app /var/lib/platform

# Build metadata, reported by `GET /api/version` (`runtime.ts` § buildInfo). Empty in a checkout.
ARG APP_VERSION=
ARG APP_COMMIT=
ARG APP_BUILT_AT=
ENV APP_VERSION=${APP_VERSION} \
    APP_COMMIT=${APP_COMMIT} \
    APP_BUILT_AT=${APP_BUILT_AT} \
    NODE_ENV=production \
    ROLE=all \
    HOST=0.0.0.0 \
    PORT=8080

USER agentic
EXPOSE 8080

# `/healthz` and never `/readyz` (TD-023's amendment): readiness is 503 for ever on `ROLE=all`
# until a pipeline can be composed, and a container platform that restarted this process for that
# would be restarting an instance that is working as designed.
# The shell form is deliberate and DL3025 does not apply: hadolint reads a `HEALTHCHECK CMD` as a
# `CMD`, and this one needs a shell to expand `${PORT}` and to turn a failed `curl` into `exit 1`.
# hadolint ignore=DL3025
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["node", "--import", "./scripts/ts-source-resolver.mjs"]
CMD ["apps/server/src/main.ts"]

# What the updater reads before it rolls this build back to (TD-032 decision 2, WP-272): the
# schema guard's version (2 starts on an all-additive unknown future), the rollback floor (raised by
# every row that changes what existing rows mean to the runtime; `migrations:check` holds a
# `raises-rollback-floor` migration to it) and the pg-boss schema version `runMigrations` installs.
# `migrate --plan` prints the same three from `packages/infrastructure/src/db/image-labels.ts`, and
# `image-labels.test.ts` holds this block to that module.
ARG PGBOSS_SCHEMA
LABEL org.platform.schema-guard="2" \
      org.platform.rollback-floor="4" \
      org.platform.pgboss-schema="${PGBOSS_SCHEMA}"

LABEL org.opencontainers.image.title="platform" \
      org.opencontainers.image.description="The agentic platform: API, workers, SSE and migrations." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/gtfo-ai/platform"
