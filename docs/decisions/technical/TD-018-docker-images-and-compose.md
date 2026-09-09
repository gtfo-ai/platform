# TD-018 — Docker: `platform-base` (node:24-trixie-slim + pinned CLIs, non-root) and `platform` product image; Compose with `migrate` one-shot and `local` profile

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/09, research/03, technical/11, BD-004, BD-020

## Decision
Two images as specified in technical/11; not distroless (agents need a shell and CLIs); non-root `agentic` user (Claude Code refuses bypass mode as root anyway); SDK installed in the product image so the Claude binary version tracks the SDK; multi-arch amd64/arm64; weekly base rebuild; size checks. Compose: `db`, `migrate`, `app`, `runner`, `db-backup`; profile `local` mounts the operator's Claude binary and config and passes `CLAUDE_CODE_OAUTH_TOKEN`. Secrets via env or `<NAME>_FILE`.

## Open
Redistribution terms for the Claude Code binary and `acli` inside a public image `[unverified]` — fallback: install at image build from official repos, or at first start. Tracked in TODO.
