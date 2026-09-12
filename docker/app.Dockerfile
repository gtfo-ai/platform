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
# runs Vite and the result is copied to `/app/apps/web/dist`. Nothing in `apps/server` serves it
# yet — that route is technical/09's "served as a static bundle by the app process" and it does not
# exist; the bundle is in the image so the service that gains the route needs no new build step,
# and the gap is recorded in PROGRESS rather than papered over with an env var nothing reads.
ARG BASE_IMAGE=platform-base:dev

# ── The SPA bundle ───────────────────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS web
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
RUN pnpm --filter @platform/web run build

# ── Production dependencies ──────────────────────────────────────────────────────────────────────
# `--prod` and the server's sub-graph only: no vitest, no biome, no playwright, no vite.
#
# The Agent SDK's per-platform binary (`@anthropic-ai/claude-agent-sdk-linux-*`, 217 MB) **stays**.
# technical/11 says to "remove the unused musl/glibc SDK platform package", and on this Debian base
# pnpm resolves the glibc one only, so there is no second copy to remove — and the remaining one is
# not removable: the SDK checks the executable exists on *this* side before it hands the command to
# `spawnClaudeCodeProcess` ("Claude Code executable not found at …"), so a platform process without
# it cannot start a run even though the binary that actually executes is the run container's.
FROM ${BASE_IMAGE} AS deps
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
 && pnpm store prune

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
RUN mkdir -p /var/lib/app/exports /var/lib/app/knowledge \
 && chown -R agentic:agentic /var/lib/app

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
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT}/healthz" || exit 1

ENTRYPOINT ["node", "--import", "./scripts/ts-source-resolver.mjs"]
CMD ["apps/server/src/main.ts"]

LABEL org.opencontainers.image.title="platform" \
      org.opencontainers.image.description="The agentic platform: API, workers, SSE and migrations." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/gtfo-ai/platform"
