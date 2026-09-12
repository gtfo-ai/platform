# TD-018 — Docker: `platform-base` (node:24-trixie-slim + pinned CLIs, non-root) and `platform` product image; Compose with `migrate` one-shot and `local` profile

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/09, research/03, technical/11, BD-004, BD-020

## Decision
Two images as specified in technical/11; not distroless (agents need a shell and CLIs); non-root `agentic` user (Claude Code refuses bypass mode as root anyway); SDK installed in the product image so the Claude binary version tracks the SDK; multi-arch amd64/arm64; weekly base rebuild; size checks. Compose: `db`, `migrate`, `app`, `runner`, `db-backup`; profile `local` mounts the operator's Claude binary and config and passes `CLAUDE_CODE_OAUTH_TOKEN`. Secrets via env or `<NAME>_FILE`.

## Open
Redistribution terms for the Claude Code binary and `acli` inside a public image `[unverified]` — fallback: install at image build from official repos, or at first start. Tracked in TODO.

## Amendment (WP-22, session 5 — as built, recorded before the code merged)
Four corrections to the Decision above, each measured while building it (technical/11 carries the detail):
- **Five images, not two**: `platform-base`, `platform-runtime` (the run container — the six agent CLIs
  live here, not in the base, because with them the base is 1.0 GB and the product image cannot meet
  technical/11's own size check), `platform-egress` (tinyproxy as uid 1000, `cap_drop ALL`),
  `platform-launcher` and the product image `platform`.
- **Compose services are `db`, `migrate`, `app`, `launcher`, `docker-socket-proxy` and `db-backup`.**
  There is **no `runner` service**: `ROLE=runner` is a worker (WP-15g, TD-021's amendment), and the
  process that reaches the Docker socket is the launcher container, behind the proxy on an internal
  network the app never joins.
- **Local provider mode is a `compose.local.yml` override, not a `local` profile.** A profile cannot
  say "this service *instead of* that one": with `app` unprofiled and `app-local` under `local`,
  `COMPOSE_PROFILES=local` started both on one port (measured with `docker compose config --services`).
  `docker compose -f compose.yml -f compose.local.yml up` is the shape; asserted by
  `test/e2e/compose/compose-config.e2e.test.ts` under every profile setting.
- **The override does not mount the operator's Claude binary or config into a run.** The CLI runs
  inside `platform-runtime`, and technical/05 forbids a host mount in a run container; what local mode
  passes is the credential (`CLAUDE_CODE_OAUTH_TOKEN`), as the Decision says.
