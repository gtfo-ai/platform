# syntax=docker/dockerfile:1.19
#
# `platform-launcher` — the only component that reaches the Docker daemon (TD-021).
#
# ## Why this is an image of its own rather than a `ROLE` of `platform`
#
# TD-021's WP-15g amendment settles it, and it is the reason this file exists at all: *"No process
# that composes the pipeline or serves `/webhooks/*` may construct a Docker client"*, and the only
# arrangement that survives an RCE in the API process is a **separate container** — not a separate
# `ROLE` (the shipped default is `ROLE=all`, which would put the daemon beside the platform's only
# unauthenticated endpoint), not a separate package (`@platform/infrastructure` is already a
# dependency of `apps/server`). `apps/launcher/src/docker-access.test.ts` holds the repository half
# as a census over `git ls-files`; this file and `compose.yml` are the deployment half.
#
# The image therefore contains `apps/launcher` and **not** `apps/server`. That is a weaker
# statement than it looks — both import `@platform/infrastructure`, so the Docker client's *code*
# is in both images — and it is stated plainly rather than implied: what the split buys is that the
# process with the socket is not the process with the HTTP surface, and what enforces it is the
# absence of `DOCKER_HOST` and of any route to the socket proxy from the `app` service.
#
# ## It talks to a proxy, not to the socket
#
# `compose.yml` gives it `DOCKER_HOST=tcp://docker-socket-proxy:2375` and binds no socket into this
# container at all. `DOCKER_HOST` has **no default** (`readLauncherConfig`): absent is a startup
# error, because an absent value that selected `/var/run/docker.sock` would grant exactly the
# unfiltered daemon the proxy is deployed to remove.
ARG BASE_IMAGE=platform-base:dev

# ── Production dependencies ──────────────────────────────────────────────────────────────────────
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
# `--ignore-scripts`: the only lifecycle scripts in this workspace are the root's
# `prepare` (`lefthook install`, a git hook installer that is not in a `--prod` tree and
# exits 127 here) and `@b12k/gitleaks`'s binary download — both developer tooling, neither
# a runtime dependency. `@node-rs/argon2` and the Agent SDK ship prebuilt per-platform
# binaries and run no script at all.
RUN pnpm install --frozen-lockfile --prod --ignore-scripts --filter @platform/launcher... \
 && pnpm store prune

# ── The image ────────────────────────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS launcher
USER root
WORKDIR /app

COPY --from=deps --chown=agentic:agentic /src/node_modules ./node_modules
COPY --from=deps --chown=agentic:agentic /src/packages ./packages
COPY --from=deps --chown=agentic:agentic /src/apps ./apps
COPY --chown=agentic:agentic package.json pnpm-workspace.yaml tsconfig.base.json tsconfig.json ./
COPY --chown=agentic:agentic scripts/ts-source-resolver.mjs ./scripts/
COPY --chown=agentic:agentic packages ./packages
COPY --chown=agentic:agentic apps/launcher ./apps/launcher

# The control volume's mount point (`APP_WORKSPACE_CONTROL_ROOT`) and the export directory. The
# control root must stay short: it becomes a Unix socket path, which is capped at 103 bytes
# (`names.ts` § MAX_UNIX_SOCKET_PATH), and TD-025's own layout spends 45 of them.
RUN mkdir -p /run/agentic/ctl /var/lib/app/exports \
 && chown -R agentic:agentic /run/agentic /var/lib/app

ARG APP_VERSION=
ARG APP_COMMIT=
ARG APP_BUILT_AT=
ENV APP_VERSION=${APP_VERSION} \
    APP_COMMIT=${APP_COMMIT} \
    APP_BUILT_AT=${APP_BUILT_AT} \
    NODE_ENV=production

# Q51: the run shim's control socket is `0600` and created as uid 1000, so the process that
# connects to it must be uid 1000. `assertRunnerUid` refuses at construction otherwise, naming both
# numbers — and this line is what makes that a non-event in the shipped image.
USER agentic

ENTRYPOINT ["node", "--import", "./scripts/ts-source-resolver.mjs"]
CMD ["apps/launcher/src/index.ts"]

LABEL org.opencontainers.image.title="platform-launcher" \
      org.opencontainers.image.description="Workspace provider: the only component that reaches the Docker daemon (TD-021)." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/gtfo-ai/platform"
