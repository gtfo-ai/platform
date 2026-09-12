# syntax=docker/dockerfile:1.19
#
# `platform-egress` — the per-run egress sidecar (TD-021, technical/05 § "Network policy").
#
# The workspace sits on an `internal: true` network with no default route, so this container is the
# only way out of a run, and the only thing that decides what it forwards is the file the launcher
# renders onto the config volume (`packages/infrastructure/src/workspace/egress.ts`). This image is
# tinyproxy and nothing else.
#
# ## uid 1000 with every capability dropped, and what it did *not* cost
#
# `sidecarCreateBody` runs this as `User: 1000:1000` with `CapDrop: ['ALL']` and a read-only rootfs.
# Until WP-22 the rendered configuration carried `User nobody` / `Group nobody`, written when the
# sidecar was imagined to start as root, and PROGRESS backlog 7 predicted — by reading, not by
# running — that a process without `CAP_SETUID` could not honour them, so "the real image would not
# start with this file as written".
#
# **Measured against this image, with both lines present: it starts.** Container `running`, the
# process is uid 1000, a proxied request to an allowed host answers 200 and a filtered one 403
# (`Proxying refused on filtered domain`) — byte for byte what the same run gives with the lines
# removed, and tinyproxy does not even warn. The prediction was wrong (standing rule 27).
#
# The lines are gone from the renderer anyway, for the reason that survives the measurement: the
# process does not honour them, so they are a claim about this container that nothing enforces
# (standing rule 3), and a trap for the day somebody starts the sidecar as root. `egress.test.ts`
# asserts their absence with the measurement beside it; the behaviour is asserted where a binary can
# answer, in `test/e2e/workspace/docker-workspace.e2e.test.ts`.
#
# The image deliberately declares no `USER`: the create body states it, `docker run` for the test
# states it, and a `USER` line here would make an image that starts as nobody-in-particular look
# like one whose uid is its own business. The one thing that must hold is that **nothing needs
# root**: no pid file (the rendered config sets none, so tinyproxy writes none), no log file (with
# `-d` the log goes to stdout, which is where BD-020 wants it), and no writable path at all.
ARG ALPINE_IMAGE=alpine:3.21@sha256:48b0309ca019d89d40f670aa1bc06e426dc0931948452e8491e3d65087abc07d

FROM ${ALPINE_IMAGE} AS egress

# Pinned to the version in Alpine 3.21's `main` repository, which is the same on x86_64 and
# aarch64. `--no-cache` keeps the package index out of the layer.
ARG TINYPROXY_VERSION=1.11.2-r0
RUN apk add --no-cache "tinyproxy=${TINYPROXY_VERSION}"

# The uid the sidecar is created as. The account exists so `ps` and any log line name something,
# not because tinyproxy switches to it — see the note above.
RUN addgroup -g 1000 agentic && adduser -D -u 1000 -G agentic agentic

# **No `VOLUME /etc/egress`**, and the reason is a measured leak rather than taste. A `VOLUME`
# declaration makes the daemon create an *anonymous* volume for every container started from the
# image that does not mount that path — and `docker rm` keeps it unless the caller asks for `v=1`.
# Measured at WP-22 on `alpine/git`, which declares `VOLUME /git`: one `verify:e2e` run left **220**
# empty anonymous volumes behind, invisible to any label sweep (standing rule 60). The launcher
# always mounts the rendered allow-list here (`EGRESS_CONFIG_MOUNT`), so the declaration would buy
# nothing and cost that.
#
# `EGRESS_PORT`. Documentation only: the run network is internal and nothing is published.
EXPOSE 8888

# `-d` is "do not daemonize": the container's process must be the proxy, so the daemon's health and
# the container's liveness are the same fact.
ENTRYPOINT ["/usr/bin/tinyproxy", "-d", "-c", "/etc/egress/tinyproxy.conf"]

LABEL org.opencontainers.image.title="platform-egress" \
      org.opencontainers.image.description="Per-run egress proxy with the launcher's rendered allow-list (TD-021)." \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/gtfo-ai/platform"
