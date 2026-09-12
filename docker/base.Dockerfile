# syntax=docker/dockerfile:1.19
#
# `platform-base` — the runtime layer every other image is built on (BD-020, technical/11 § Images).
#
# BD-020 splits the images so that "code changes do not rebuild the tool layer": this one carries
# the runtime and the OS tools, and it is rebuilt on a schedule
# (`.github/workflows/base-image.yml`) rather than on a push. Nothing of the platform is in it.
#
# ## What is in it, and the one thing that moved (WP-22, measured)
#
# technical/11 wrote this image as "runtime plus all required CLIs", listing `glab`, `gh`, `acli`,
# `jira`, `logcli`, `sentry-cli` and `@sentry/mcp-server` here. **Those seven live in
# `platform-runtime` instead**, and the reason is in the code rather than in taste: they are
# declared as *agent* tooling — `AgentTooling.cli` is documented as "what an agent may be handed
# inside a run" (`packages/integrations/src/providers/gitlab/index.ts:13-22`) — and no platform
# process shells out to one; every provider adapter here speaks HTTP. Measured, which is what
# decided it: with the seven in this image it is **1.0 GB**, so the product image built on it
# (`docker/app.Dockerfile`, base + a production `node_modules`) cannot meet the ≤ 1 GB size check
# technical/11 asks `image.yml` to enforce, while the run container — the only thing that uses
# them — would carry the platform's server dependencies. Without them this image is **547 MB**
# unpacked and both budgets hold. The amendment is recorded in technical/11.
#
# `git` is here rather than in the runtime image alone because **the platform process itself runs
# it**: TD-026 reads the knowledge vault from a bare mirror the platform clones and fetches with
# `git rev-parse` / `git ls-tree` / `git cat-file`, as a child process, with no Docker client.
#
# ## The uid is the whole point of the user
#
# TD-021 runs every container as uid 1000 and Q51 requires the runner process to be uid 1000 too
# (the run shim's control socket is `0600`). The upstream Node image already has a user at 1000
# called `node`; renaming rather than adding is what keeps the *number* single-valued — a second
# user at 1001 called `agentic` would look right in a `USER` line and be wrong at the socket.
#
# The Node image is pinned by **digest**, and it is the multi-arch index digest, so one value
# covers linux/amd64 and linux/arm64.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:6950b66b4c0cb0151ce89fa75074673850763d096b044f422c6729b588dd4956

FROM ${NODE_IMAGE} AS base

# technical/11's OS list. `tini` is deliberately absent: technical/05 asks for `init: true`, which
# is the daemon's own init as pid 1, so an init in the image would be a second one.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      curl \
      git \
      jq \
      openssh-client \
      ripgrep \
 && rm -rf /var/lib/apt/lists/*

# uid 1000 keeps its number and gains the platform's name (see the note at the top).
RUN groupmod -n agentic node \
 && usermod -l agentic -d /home/agentic -m node \
 && mkdir -p /home/agentic \
 && chown agentic:agentic /home/agentic

# WP-23 adds THIRD_PARTY_NOTICES.md beside this; the licence is what exists today, and an image
# that shipped neither would be the wrong default.
COPY LICENSE /usr/share/doc/platform/LICENSE

USER agentic
WORKDIR /home/agentic
ENV NODE_ENV=production

# A smoke test of the layer this image exists to provide, run at build time so a broken install is
# a failed build rather than a failed run three days later.
RUN set -eux; \
    node --version; \
    git --version; \
    jq --version; \
    rg --version | head -1; \
    test "$(id -u)" = 1000; \
    test "$(id -un)" = agentic

LABEL org.opencontainers.image.title="platform-base" \
      org.opencontainers.image.description="Node 24 runtime and OS tools for the agentic platform (BD-020)." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/gtfo-ai/platform"
