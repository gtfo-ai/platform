# Research: backend language, framework, real-time server, auth, config/observability, HTTP clients (2026-09-09)

> Registry/GitHub numbers pulled live on 2026-09-09. Informs TD-001, TD-002, TD-014 (server side), TD-022, TD-023, TD-024.

## Language: TypeScript on Node 24 LTS (not Bun host, not Python)
Decisive: Agent SDK parity. TS `@anthropic-ai/claude-agent-sdk` 0.3.266 (bundles Claude Code 2.1.266; licence Anthropic Commercial Terms — consumed, not redistributed) vs Python 0.2.152 (MIT):
- Hooks: TS 33 in-process events vs Python 10; TS-only `SessionStart/End`, `PostCompact`, `StopFailure`, `PreModelSwitch`, `InstructionsLoaded`, `PostToolBatch`, `PermissionDenied`, … — these back the audit Prompt tab, compaction markers and blocking unapproved model fallbacks.
- Steering: both have streaming input, but in Python "a generator exception is logged at debug level and the session stalls without raising".
- `canUseTool`: TS works in single and streaming mode with `permissionPrompts: 'none'`; Python needs streaming mode plus a documented dummy-hook workaround.
- Session store: parity; TS ships reference Postgres/S3/Redis adapters. `startup()`/`WarmQuery` pre-warming is TS-only.
- One language with the UI (shared `packages/contracts`, zod → JSON Schema for the SDK's draft-07 structured outputs), one toolchain, one CI matrix. Docker image delta (node:24-slim 80.7 MB vs python:3.13-slim 46 MB) is noise next to the CLIs and Claude binary.
- Bun as host runtime: no — memory-leak fixes only landed in 1.3.13 (2026-04), 1.4.x regressions, SDK issue #216 (fast mode needs native Bun) open; keep code Bun-clean and revisit. Node 24 Active LTS to 2026-10-20 (maintenance to 2028-04); Node 26 LTS from 2026-10-28; Node 20 EOL.
Sources: https://code.claude.com/docs/en/agent-sdk/hooks.md , …/typescript.md , …/python.md , …/streaming-vs-single-mode.md , …/user-input.md , …/hosting.md , https://github.com/anthropics/claude-agent-sdk-typescript/issues/216 , https://www.theregister.com/software/2026/04/21/bun-1113-out-with-memory-fixes-as-dev-complain-of-leaks/5221154

## Framework: Fastify 5 + awilix + zod 4 type provider + `@fastify/sse` + `close-with-grace`
| | Fastify 5.12 | NestJS 12.0 | Hono 4.13 | Express 5.2 | Elysia 1.4 | Effect HttpApi |
|---|---|---|---|---|---|---|
| Maintainers | 4+ regular, OpenJS/NearForm | effectively one (304 of 626 commits/90 d by one person) + bots | mostly one | dormant-ish | one | large |
| SSE | official `@fastify/sse` 0.6 (`replay()`, Last-Event-ID, heartbeat, `onClose`) | `@Sse()` observable; shutdown hangs with open SSE (#6643, #9517) | `streamSSE` | manual | Bun streaming | v4 RC |
| Graceful shutdown | `close()` lifecycle: 503 → `preClose` (end SSE streams) → drain → `onClose`; `close-with-grace` | `enableShutdownHooks` + `forceCloseConnections` | manual `node:http` | manual | `app.stop()` | fiber interruption |
| DI / modules | `@fastify/awilix` + encapsulated plugins | built-in | none | none | decorate | Layer |
| Handler priority | own bus | `@nestjs/event-emitter` has no numeric priority | own | own | own | PubSub |
Pitfall: `@fastify/compress` on `text/event-stream` breaks `onmessage` → register with `global: false`. Sources: https://github.com/fastify/sse , https://fastify.dev/docs/latest/Reference/Server/ , https://github.com/mcollina/close-with-grace , https://github.com/nestjs/nest/issues/6643 , https://github.com/fastify/fastify-compress/issues/18
Python alternative: FastAPI 0.141 (`fastapi.sse.EventSourceResponse`), Procrastinate 3.9 (Postgres jobs); Litestar v3 "blocked by lack of maintainer resources".

## Real-time server side
SSE; one multiplexed stream per tab; HTTP/2 at the reverse proxy (Caddy default) because Chromium hard-codes 6 sockets/host on HTTP/1.1 (MDN "won't fix"); `id: <topic>:<seq>` + `Last-Event-ID` replay from Postgres; fan-out via outbox + LISTEN/NOTIFY (ids only; one session-mode `pg` client per API instance; PgBouncer transaction pooling breaks LISTEN); coalesce deltas per run every 50–100 ms; on `res.write()===false` stop pushes and end the stream so the client reconnects; `: ping` every 15–30 s; `Cache-Control: no-cache`, `X-Accel-Buffering: no`; nginx needs `proxy_buffering off`. Upgrade path NATS JetStream (Apache-2.0) or Valkey Streams (BSD-3; Redis ≥ 8 is AGPL/RSAL/SSPL). Clients: native `EventSource` (cookie auth) or `eventsource` 5.1; `@microsoft/fetch-event-source` last release 2021 — avoid. Sources: https://developer.mozilla.org/en-US/docs/Web/API/EventSource , https://www.postgresql.org/docs/current/sql-notify.html , https://www.pgbouncer.org/features.html , https://github.com/EventSource/eventsource

## Auth and RBAC
- **Better Auth 1.7.3** (MIT, 29.9k★; absorbed Auth.js 2025-09; joined Vercel 2026-07): email+password, DB sessions (7 d, `updateAge` 1 d, revoke all), `admin`, `@better-auth/api-key`, `genericOAuth` (OIDC discovery + PKCE), `@better-auth/sso` (OIDC + SAML) later; Fastify mount via catch-all. Caveats: organisation plugin teams have no per-team roles → per-project RBAC is ours; June-2026 advisories (13, 2 critical in SSO/OIDC); 1.7.0 schema break rolled back in 1.7.3 → pin minors; override default scrypt with Argon2id. https://better-auth.com/docs/concepts/session-management , https://better-auth.com/blog/security-update-june-2026
- Avoid: Auth.js (maintenance mode), Lucia npm (deprecated → guide), Passport (2023), Arctic/oslo (deprecated 2026-07).
- Password hashing Argon2id (OWASP m=19456 KiB, t=2, p=1) via `@node-rs/argon2` 2.2; sessions: opaque 32-byte token, sha256 at rest, `__Host-session; HttpOnly; Secure; SameSite=Lax`, sliding expiry, rotation on privilege change; CSRF for the SPA = SameSite=Lax + `Origin`/`Sec-Fetch-Site` check + required custom header; PATs via `Authorization: Bearer`, hashed, prefixed for secret scanning.
- RBAC: `org_memberships`, `project_memberships(project_id, user_id, role)`; numeric levels viewer 10 < member 20 < maintainer 30 < admin 40; pure `can(actor, action, resource)` with an exhaustive role×action test; capability map (`run.read: viewer`, `agent.steer: member`, `plan.approve: maintainer`, `budget.approve: maintainer`, `project.settings: admin`). CASL only if the UI must share rules; Oso OSS deprecated; OpenFGA/SpiceDB are extra services. No bundled IdP (Keycloak/Authentik/Zitadel) — OIDC later. OIDC-ready schema now: `accounts(user_id, provider_id, issuer, provider_account_id, raw_claims)`, `email_verified_at`, `sso_providers` with group→role mappings, `oauth_states`.

## Config, logging, metrics, observability, secrets
zod 4.5 for env (`z.stringbool()` not `z.coerce.boolean()`; `z.toJSONSchema` for `.agentic` schemas and SDK structured outputs); `yaml` 2.9; pino 10.3 (`redact`, `AsyncLocalStorage` mixin for request/task/run ids; Fastify native); **`@prometheus-io/client` 0.16** (`prom-client` renamed; Node ≥ 22) with `http.server.request.duration` histogram and agent gauges/counters (`agent_runs_active{model}`, `agent_tokens_total{model,kind}`, `agent_cost_usd_total`, `queue_depth`); OpenTelemetry JS 2.11 (traces/metrics stable, logs "Development") enabled only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set, `@fastify/otel`; Claude Code's own telemetry passes through the SDK (`CLAUDE_CODE_ENABLE_TELEMETRY=1`, `OTEL_*`, `TRACEPARENT` injected into the child) but is not relied on for platform metrics (silent export failures); `@sentry/node` 10 optional via `SENTRY_DSN` (self-hosted Sentry FSL or GlitchTip MIT); `/healthz` via `@fastify/under-pressure`, `/readyz` (DB, migrations head, queue), Docker HEALTHCHECK via `node -e "fetch(...)"`; secrets `X_FILE` convention, branded `Secret` type with `toJSON → [REDACTED]`, AES-256-GCM at rest with key id; gitleaks pre-commit/CI and over agent diffs before MR. Sources: https://zod.dev/json-schema , https://github.com/prometheus/client_js , https://opentelemetry.io/docs/languages/js/ , https://code.claude.com/docs/en/agent-sdk/observability , https://github.com/fastify/under-pressure

## HTTP clients: handwritten thin clients on `fetch` + `ky`; official Bolt for Slack
| Provider | Pick | Why |
|---|---|---|
| GitLab | handwritten (`PRIVATE-TOKEN`, `RateLimit-*`/`Retry-After`, `x-next-page`) | no official JS client; gitbeaker last release 2025-11, no thread-level resolve; GitLab's OpenAPI omits MR discussions |
| Jira Cloud | handwritten + `openapi-typescript` types from Atlassian Swagger v3; `marklassian` 1.2 (MIT, 504 KB) markdown→ADF | jira.js 6 is Cloud-only (blocks DC), 45 MB, one author; `@atlaskit/editor-markdown-transformer` 35 MB |
| Slack | `@slack/bolt` 5.1 (+ `@slack/socket-mode` 3.0, `@slack/web-api` 8.1 lighter path) | official; Socket Mode ≤ 10 connections/app; payloads may go to any connection → idempotency |
| Sentry | handwritten (Internal Integration bearer, `Link` cursors) | Sentry explicitly does not invest in read SDKs |
| Loki | handwritten (`/loki/api/v1/*`, `X-Scope-OrgID`) | no official client |
| GitHub later | `octokit` 5 / `@octokit/webhooks` 14 | official |
| Generic | native `fetch` + **`ky` 2.1** (0 deps, retries 408/413/429/5xx, honours `Retry-After`, per-attempt + total timeouts) | axios left behind by Slack and jira.js |
| Webhook verification | handwritten with `timingSafeEqual`: GitLab legacy `X-Gitlab-Token` **and** Standard Webhooks (GitLab ≥ 19.1: `webhook-id/timestamp/signature`), Jira `X-Hub-Signature sha256=`, Slack `v0=` (Bolt), Sentry `Sentry-Hook-Signature`, GitHub `X-Hub-Signature-256` | |
Sources: https://docs.gitlab.com/api/rest/third_party_clients/ , https://github.com/jdalrymple/gitbeaker , https://github.com/MrRefactoring/jira.js/releases/tag/v6.0.0 , https://github.com/jamsinclair/marklassian , https://github.com/slackapi/bolt-js/releases/tag/v5.0.0 , https://forum.sentry.io/t/looking-for-sdk-to-read-as-opposed-to-write/4152 , https://github.com/sindresorhus/ky , https://docs.gitlab.com/user/project/integrations/webhooks/

## Trade-offs accepted
TS SDK licence is Anthropic's Commercial Terms (consumed, not redistributed — README note); Fastify trades built-in DI for maintainer breadth and clean SSE drain; SSE needs HTTP/2 for many tabs; LISTEN/NOTIFY needs session-mode connections; Better Auth moves fast (pin); handwritten clients cost ~20 endpoints × 5 providers of typed code in exchange for DC support and no single-maintainer dependencies.

## `[unverified]` carried to TODO
Bun 1.4 long-run stability; `node:crypto.argon2` OpenSSL requirement; Better Auth api-key hashing at rest; zod→`.env.example` generator; Hono compress on SSE; pg-boss `stop()` graceful options.
