# syntax=docker/dockerfile:1.19
#
# `platform-runtime` — the **run container's** image (TD-021, technical/05 § "Workspace lifecycle").
#
# TD-021: "a workspace container from the `platform-runtime` image (Claude binary + CLIs, no
# platform code) running as uid 1000 with `cap-drop ALL`". Three things make it that image and
# nothing more:
#
#  1. the `claude` CLI, **pinned to the version of the SDK the platform runs** — taken out of the
#     `pnpm install` below rather than named here, because two copies of a version are two versions
#     (standing rule 7). The SDK spawns this binary through the run shim, so a drift between them
#     is a protocol mismatch inside a container;
#  2. the agent's CLIs — `gh`, `glab`, `acli`, `jira`, `logcli`, `sentry-cli` and the Sentry MCP
#     server. They are here rather than in `platform-base` because this is the only image whose
#     user runs them: they are declared as `AgentTooling.cli`, "what an agent may be handed inside
#     a run", and no platform process shells out to one (see `docker/base.Dockerfile`);
#  3. `agentic-runlet`, **one file with no runtime dependencies** (TD-025 §1), as the entrypoint.
#
# ## What is deliberately absent
#
# No platform code, no `node_modules`, no repository. Until this image existed, a run container was
# `node:24-alpine` with the repository bind-mounted read-only at `/repo` so the shim could be
# started from TypeScript — "the one thing technical/05 says a run container never has", named as a
# hole in `packages/infrastructure/src/workspace/hardening.ts`. With this image
# `WorkspaceImages.runtimeSourceDir` is `null`, the create body carries **no** bind at all, and the
# shim starts from the entrypoint below.
#
# The rootfs is read-only at run time (technical/05). The shim writes only to `/ctl` (the per-run
# control volume) and `/tmp` (a tmpfs), and the agent's checkout is `/work` (the run's volume).
ARG BASE_IMAGE=platform-base:dev

# ── The agent's CLIs ─────────────────────────────────────────────────────────────────────────────
# A separate stage so `curl`, `unzip` and the tarballs never reach a shipped layer: only the
# extracted binaries are copied out.
#
# Every CLI is pinned by **version**, and each URL was verified to answer 200 on both architectures
# when this file was written. They are deliberately *not* pinned by sha256: that is twelve digests
# nothing in this repository could re-derive, and the weekly rebuild would then fail on the first
# upstream release rather than picking it up, which is the opposite of what the schedule is for.
FROM ${BASE_IMAGE} AS tools
USER root
ARG TARGETARCH
ARG GH_VERSION=2.100.0
ARG GLAB_VERSION=1.117.0
ARG LOGCLI_VERSION=3.7.7
ARG SENTRY_CLI_VERSION=3.7.0
ARG JIRA_CLI_VERSION=1.7.0
# Atlassian publishes `acli` from one "latest" path only — there is no versioned URL and no
# checksum file, so this is the single tool that cannot be pinned. Recorded rather than papered
# over: `docs/TODO.md` carries it, and an operator who needs a fixed acli builds with
# `--build-arg ACLI_URL=<their own copy>`.
ARG ACLI_URL=https://acli.atlassian.com/linux/latest/acli_linux_${TARGETARCH}/acli

RUN apt-get update \
 && apt-get install -y --no-install-recommends unzip \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /out
# One layer, and every download is `--fail` so a 404 stops the build instead of writing an HTML
# error page into a file called `gh`.
RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) sentry_arch=x86_64; jira_arch=x86_64 ;; \
      arm64) sentry_arch=aarch64; jira_arch=arm64 ;; \
      *) echo "unsupported TARGETARCH: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    curl -fsSL -o gh.tgz "https://github.com/cli/cli/releases/download/v${GH_VERSION}/gh_${GH_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    tar -xzf gh.tgz --strip-components=2 "gh_${GH_VERSION}_linux_${TARGETARCH}/bin/gh"; \
    curl -fsSL -o glab.tgz "https://gitlab.com/api/v4/projects/gitlab-org%2Fcli/packages/generic/glab/${GLAB_VERSION}/glab_${GLAB_VERSION}_linux_${TARGETARCH}.tar.gz"; \
    tar -xzf glab.tgz --strip-components=1 bin/glab; \
    curl -fsSL -o logcli.zip "https://github.com/grafana/loki/releases/download/v${LOGCLI_VERSION}/logcli-linux-${TARGETARCH}.zip"; \
    unzip -q -j logcli.zip "logcli-linux-${TARGETARCH}" -d .; \
    mv "logcli-linux-${TARGETARCH}" logcli; \
    curl -fsSL -o sentry-cli "https://github.com/getsentry/sentry-cli/releases/download/${SENTRY_CLI_VERSION}/sentry-cli-Linux-${sentry_arch}"; \
    curl -fsSL -o jira.tgz "https://github.com/ankitpokhrel/jira-cli/releases/download/v${JIRA_CLI_VERSION}/jira_${JIRA_CLI_VERSION}_linux_${jira_arch}.tar.gz"; \
    tar -xzf jira.tgz --strip-components=2 "jira_${JIRA_CLI_VERSION}_linux_${jira_arch}/bin/jira"; \
    curl -fsSL -o acli "${ACLI_URL}"; \
    rm -f ./*.tgz ./*.zip; \
    chmod 0755 gh glab logcli sentry-cli jira acli

# ── The `claude` binary and the shim bundle ──────────────────────────────────────────────────────
#
# One stage for both, and that is the pin: the `claude` binary is the SDK's own
# `optionalDependency` for this platform, so `pnpm install --frozen-lockfile` resolves it from
# `pnpm-lock.yaml` at exactly the version `packages/infrastructure` declares. Installing it
# separately by name would have been a second statement of that version — two copies of a version
# are two versions (standing rule 7) — and a mismatch between the SDK the platform runs and the CLI
# in the container is a protocol fault inside a run.
#
# The shim is bundled here rather than copied from the host so that `docker build` from a clean
# checkout produces the image CI publishes; the bundle is generated output and is not committed.
FROM ${BASE_IMAGE} AS shim
USER root
WORKDIR /src
RUN corepack enable pnpm
# Every workspace manifest, not only the five in the sub-graph: `--frozen-lockfile` compares the
# lockfile against the importers it finds on disk, so a missing `package.json` reads as a lockfile
# that is out of date.
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
# `--ignore-scripts` and nothing else: `--no-optional` was tried and is wrong here, because the
# bundler's own native binding (`@rolldown/binding-linux-*`) is an optional dependency, and without
# it `vite build` fails with "Cannot find native binding" — measured.
RUN pnpm install --frozen-lockfile --filter @platform/runlet... --ignore-scripts

# Exactly one match, asserted: the platform binary is per-OS and per-arch, so two would mean the
# install resolved for a platform this image is not.
# `-musl` is excluded rather than counted: this image is glibc (Debian), and technical/11 already
# says the unused libc variant is removed. If both gnu candidates ever appeared the count would
# fail rather than pick one.
RUN set -eux; \
    found="$(find /src/node_modules/.pnpm -path '*claude-agent-sdk-linux*/claude' -type f ! -path '*musl*')"; \
    test "$(printf '%s' "$found" | grep -c .)" = 1; \
    install -m 0755 "$found" /out-claude; \
    /out-claude --version

COPY scripts/assert-runlet-bundle.mjs scripts/
COPY packages/contracts packages/contracts
COPY packages/domain packages/domain
COPY packages/application packages/application
COPY packages/infrastructure packages/infrastructure
COPY apps/runlet apps/runlet
RUN pnpm --filter @platform/runlet run build \
 && node scripts/assert-runlet-bundle.mjs apps/runlet/dist/agentic-runlet.mjs

# ── The image ────────────────────────────────────────────────────────────────────────────────────
FROM ${BASE_IMAGE} AS runtime
USER root
COPY --from=tools /out/gh /out/glab /out/logcli /out/sentry-cli /out/jira /out/acli /usr/local/bin/
COPY --from=shim /out-claude /usr/local/bin/claude
COPY --from=shim /src/apps/runlet/dist/agentic-runlet.mjs /usr/local/bin/agentic-runlet
RUN chmod 0755 /usr/local/bin/agentic-runlet

# The Sentry MCP server is a Node package rather than a binary (research/03), so it is the one
# agent tool installed from the registry.
ARG SENTRY_MCP_VERSION=0.39.0
RUN npm install -g --no-audit --no-fund "@sentry/mcp-server@${SENTRY_MCP_VERSION}" \
 && npm cache clean --force

USER agentic
# TD-025 §2: the SDK's `cwd`, and where the launcher clones the project.
WORKDIR /work/repo
# `agentic-runlet` with no argument is `serve`; `agentic-runlet credential get` is the git
# credential helper the workspace's `credential.helper=!agentic-runlet credential` invokes.
ENTRYPOINT ["/usr/local/bin/agentic-runlet"]

RUN set -eux; \
    claude --version; \
    agentic-runlet unknown-mode 2>&1 | grep -q 'unknown mode'; \
    gh --version | head -1; \
    glab --version | head -1; \
    logcli --version 2>&1 | head -1; \
    sentry-cli --version; \
    jira version | head -1; \
    acli --version | head -1

LABEL org.opencontainers.image.title="platform-runtime" \
      org.opencontainers.image.description="Run container: claude CLI, agent CLIs and the agentic-runlet shim (TD-021, TD-025)." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/gtfo-ai/platform"
