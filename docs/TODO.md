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
- [ ] `integration_actions` is missing five columns `IntegrationActionEntry` already carries — WP-07 review round 1 found the gap and deliberately did **not** add a migration (parallel work packages collide on migration numbers, and no adapter persists these rows yet). The port has `provider`, `project_id`, `mutating`, `attempts` and `redaction_count`; `0007_cost.sql` and `technical/03` line 70 have `(id, integration_id, task_id, direction, action, payload, result, status, duration_ms, created_at)` and none of the five. Whoever writes the Postgres `IntegrationAuditLog` adapter — **WP-15**, or the first provider WP that persists an action — adds the numbered migration *and* amends `technical/03`. Without them the audit cannot answer "which provider", "was this a write" or "did the redactor fire" (BD-003, TD-012), and `redaction_count` is the only signal that a row which should have hidden something did not.
- [ ] The **inbound** half has no redaction step. `IgnoredDelivery.detail` and normalised event payloads carry provider text straight into `events.payload` and the inbox row, while TD-012 requires the redactor on every write to `events.payload`. Outbound is covered (`IntegrationActionExecutor` redacts the row, the log line and every error that leaves it); inbound has no single door yet because nothing persists a delivery until the webhook endpoint lands — **WP-08**, and again in WP-15 when normalised events are appended. Round 2 put the obligation on the types themselves as well as here, because that is where WP-08 will read it: `IgnoredDelivery.detail`, `HealthProbe.detail` (a failing probe is where a client quotes the request it made), `logLineSchema.line` and `GitProviderPort.getJobLog` (a failing CI job prints the command it ran).
- [ ] `apps/server`'s error handler logs an unexpected error as `{ err }` (`app.ts`), and `pino-std-serializers` emits the message and stack with the **whole** cause chain appended, an `AggregateError`'s `errors[]`, and a copy of every key `for…in` reaches. Errors that pass through `IntegrationActionExecutor` are scrubbed over exactly those routes before they leave it (round 2; asserted against the real serialiser in `apps/server/src/logging.test.ts`), but an adapter that throws *outside* the executor — a `testConnection` probe, a poll — is not covered at all — **WP-15**/WP-08 when the first such call site exists.
- [x] `technical/02`'s **ShadowSaga** read "outbound actions replaced by a null adapter" — **amended at WP-07 review round 2**, because docs win and a doc fix does not wait for the WP that builds the saga. Shadow mode is a required, zod-parsed `mode` on `MutatingActionRequest` plus one guard in the executor (technical/06 § "Outbound: actions"); the saga replaces nothing, and **WP-34** builds it against that guard.
- [ ] Nothing connects `ProviderCreateInput.secrets` (`packages/integrations/src/registry.ts`) to `exactSecretRedactor`. A binding is handed its resolved secret values when the adapter is created, and the redactor is constructed separately from whatever list its composer happens to pass; so a provider can hold a credential the redactor was never told about, and every "redacted" audit row for that binding is a row with the secret still in it. The signal that would show it — `redaction_count` reading zero where it should not — has **no column** yet (see the `integration_actions` item above). Both close in the same place: **WP-15**, the composition root that instantiates a binding and its executor together, must build the `SecretRedactor` *from* `ProviderCreateInput.secrets` rather than beside it — and **WP-08**, the first provider WP that composes a real binding, meets it first and should not invent a second path.
- [ ] `mutating: false` on an `IntegrationActionRequest` is a claim the executor cannot check, and a write labelled as a read skips the shadow guard entirely (performed against the provider in shadow mode, recorded `ok`). A verb list over action names would drift silently in the dangerous direction (standing rule 7), so the obligation is on the adapters: **WP-08…WP-11** assert, in each provider's contract suite, that every port method which changes provider state reaches the executor as a `MutatingActionRequest` — run it in shadow mode, assert the provider was not entered, as `test/contract/integrations/action-executor.contract.test.ts` already does for its four mutating cases. Noted on `ReadActionRequest` itself, where an adapter author writes the label.

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
