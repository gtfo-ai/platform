# TODO

Product-definition items were decided on 2026-08-28 and moved into `product/19-operating-definitions.md`; implementation items live in `technical/13-implementation-plan.md` (WP-nn). This file keeps only **verification** items (facts still to confirm) and the **parking lot**.

## Verification (owner: implementer during the named WP; spikes produce a short report in `research/`)

- [ ] Obsidian: can a vault be rooted at a hidden directory (`.agentic/knowledge`)? Manual test — WP-21. If not, default `knowledge_dir` to `docs/agentic/` (Q6 fallback).
- [ ] `acli` on-disk session location; re-login at container start as planned — WP-22.
- [ ] `local` provider mode in Docker: Linux `claude` binary in the runtime image, OAuth token/credentials refresh with parallel runs; macOS hosts can only pass `CLAUDE_CODE_OAUTH_TOKEN` — WP-22 (BD-004).
- [ ] Sentry hosted MCP with Internal Integration tokens (README mentions user tokens only) — WP-11.
- [ ] Block Kit payload limits for question choices — WP-10.
- [ ] Run shim conformance: SDK `query()` through the shim, session-store resume after runner restart, `volume-subpath` support on the target Docker Engine version — WP-13 (TD-025).
- [ ] Docker embedded DNS behaviour on `internal: true` networks (residual DNS channel) — WP-13.
- [ ] SDK `sandbox.credentials` masking when passed via the SDK; srt proxy chaining — later (defence in depth).
- [ ] GitLab project access tokens on self-managed Free tier; revoke latency — WP-09.
- [ ] Redistribution terms for the Claude Code binary and `acli` inside a public image; fallback install-at-build from official repos or at first start — WP-22 (TD-018).
- [ ] arm64 availability of `sentry-cli` install script and `acli` per pinned version — WP-22.
- [ ] Node version requirement of the Agent SDK (not stated; assume current LTS) — WP-12.
- [x] `node:crypto.argon2` OpenSSL requirement vs `@node-rs/argon2` — **resolved at WP-06:** `@node-rs/argon2` 2.2.0 is used, at OWASP parameters exposed as `APP_ARGON2_*`. It is a prebuilt NAPI binary with no OpenSSL dependency, which is what makes the choice portable across the Alpine and Debian bases WP-22 has to pick between; `node:crypto.argon2` needs OpenSSL 3.2+ and would have made the base image decide the hash.
- [ ] Better Auth api-key hashing at rest — WP-06 deferred it: the plan row names "email/password, sessions, admin" and not API keys, so `@better-auth/api-key` is not installed and personal access tokens (TD-022) are unimplemented. Revisit with the work package that needs script access.
- [ ] pg-boss `stop()` graceful options and behaviour with long-running run jobs — WP-05.
- [ ] Which runc version uses `cgroup.kill`; gVisor host-side cgroup enforcement — WP-14.
- [ ] TypeScript 7 (Go compiler) toolchain compatibility (Vitest, Biome, Stryker) — WP-00 (fall back to 6.x).
- [ ] promptfoo Agent SDK provider behaviour with `setting_sources` and fixture repos — WP-17.
- [ ] Embedding throughput on 4 vCPU for Qwen3-Embedding-0.6B int8 via transformers.js — phase-2 spike (TD-009).
- [ ] Transcript import into a developer's local Claude Code for take-over (`claude --resume` with an exported JSONL) — WP-27.

## Parking lot (not for v0.1; see product/14 roadmap)

- Auto-merge policy for `chore` once trust metrics exist (BD-007).
- Shadow mode in parallel with live human tickets (v0.2).
- Organisation-level shared knowledge across projects (product/05).
- Cross-tenant control plane if hosting is ever offered (BD-009).
- Managed Agents execution backend (research/04).
- Non-token cost items (CI minutes) in the cost model (product/09).
- Prompt A/B testing per project (product/13).
- Platform self-improvement channel: retros that identify a *platform* weakness open an issue in the Agentic repo (product/07).
- DBOS Transact or Temporal behind the `WorkflowRuntime` port if durable code workflows become worth their versioning discipline (TD-003).
- NATS/Valkey behind the `Broadcast`/`Jobs` ports for multi-node (TD-004, TD-014).
- Kubernetes `WorkspaceProvider` (Jobs / agent-sandbox, Cilium FQDN policies) (TD-021).
- Envoy credential injection at the egress proxy (phase 2 of TD-021).
- Bun as host runtime once 1.4.x stability data exists (TD-001).
