# TD-023 — Config with zod, logging with pino, metrics with @prometheus-io/client, optional OpenTelemetry and Sentry, health endpoints

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/11, technical/12, TD-020, BD-020

## Decision
Single `config.ts` parsed with zod 4 at boot (fail fast; `z.stringbool()` for booleans; `_FILE` variants resolved first); `.agentic/*.yml` validated with zod schemas exported as JSON Schema under `schemas/`; pino 10 structured JSON to stdout with `redact` and an `AsyncLocalStorage` mixin carrying `request_id/task_id/run_id/trace_id`; `@prometheus-io/client` at `/metrics` (HTTP duration histogram, `agent_runs_active`, `agent_tokens_total{model,kind}`, `agent_cost_usd_total`, `queue_depth`, `queue_job_age_seconds`); OpenTelemetry traces/metrics only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`@fastify/otel`, pg, undici instrumentations; run spans wrap SDK calls; Claude Code's own OTel pass-through optional per run); `@sentry/node` only when `SENTRY_DSN` is set; `/healthz` (under-pressure) and `/readyz` (DB, migrations head, queue, **dispatch** — see the amendment below). Secrets typed as `Secret` with `toJSON → [REDACTED]`; integration secrets encrypted at rest with AES-256-GCM under `APP_SECRET_KEY` (key id for rotation).

> **Amendment (WP-15a, 2026-09-11): `/readyz` has a fourth check, `dispatch`, and a worker that
> cannot handle every event the platform declares consumed is `down`.**
>
> The check is `sweepReadiness` (`packages/application/src/events/consumption.ts`) — the **same**
> predicate that decides whether the outbox worker starts, deliberately, because two readings of one
> condition drift apart (standing rule 41) and a process that refused to sweep must not report ready
> to do the work it refused. This amendment first said "no handlers is `down`"; that was round 2's
> predicate, and TD-005's own amendment replaced it — a *partial* consumer is as destructive as an
> empty one, so the condition is per declared type and a catch-all handler does not satisfy it.
>
> The three checks this record named could all be `ok` on a process that would never advance a
> ticket. `apps/server` cannot compose the pipeline on its own in this build — there is no transport
> to the launcher for a `ClaudeRunner` (Q52) and no adapter for `IntegrationAuditLog` — so `main.ts`
> and `scripts/dev.mjs` call `startRuntime()` with no composition and nothing is registered on the
> bus. Database reachable, schema current, pg-boss up: **ready**, said the probe, of an instance that
> could not run the product. A boot-time `warn` is not a readiness signal; nothing reads it, and
> `/readyz` is what a container platform, a load balancer and an operator all read instead.
>
> `ReadinessOptions.dispatchReady` is therefore **required**, not optional (standing rule 31: an
> optional guard is an absent one) — every existing call site had to state it. It is `null` for a
> role that runs no dispatcher, and the check is then **omitted** rather than reported `ok`, for the
> same reason `event_dispatch_pending` is not registered where nothing samples it: a check a process
> cannot make is one it does not publish.
>
> **What this means per `ROLE`, because an operator meets it before a developer does.** `all` and
> `worker` are **503 for ever** until something composes a pipeline — honest and intended, and the
> same condition under which the outbox sweep is deliberately not started, so a `ticket.matched` is
> left queued rather than consumed by a process that cannot act on it. `api`, `runner` and `indexer`
> pass `dispatchReady: null` and are unaffected.
>
> **The consequence WP-22 must not walk into.** `ROLE=all` is the single-process default and serves
> the API and the SPA as well as the workers, so a 503 here pulls the *whole instance* out of
> anything that gates on readiness. The compose file must **not** give a service a `depends_on`
> condition of `service_healthy` against this probe, and a reverse proxy in front of it must not use
> `/readyz` as its upstream health check, until a pipeline can be composed. `/healthz` is the
> liveness probe and is unaffected. It is recorded here rather than in the work package because it
> is a property of the decision, not of the image.

> **Amendment (WP-49, 2026-09-15): two dispatch gauges the metric list above does not name, both
> registered only where something samples them.** `event_dispatch_pending` (the outbox backlog, added
> with the dispatcher and registered by the role that sweeps) and `event_dispatch_dead_lettered`
> (WP-49: events that spent `APP_DISPATCH_MAX_ATTEMPTS` and left the queue with `dead_lettered_at`
> set — the count a busy queue and a poisoned event could not be told apart by before). Both are
> **sampled gauges rather than `_total` counters**, because a counter resets with the process and a
> dead letter is a row that survives one; the source is the query in `apps/server/src/metrics.ts`,
> and the reasoning for registering a metric only where it has a source is the WP-15a amendment
> above. The list in the decision line is otherwise unchanged: `agent_runs_active`,
> `agent_tokens_total`, `agent_cost_usd_total`, `queue_depth` and `queue_job_age_seconds` are still
> named there and the metrics module states which of them have a source on this build.

## Amendment (2026-11-05, architect, session 22) — Sentry is built for the worker and the core, redacted by construction; OpenTelemetry is still not (owner request; slice S-22.18, WP-295)

**Context.** The decision line promises `@sentry/node` when `SENTRY_DSN` is set, and so does
`docs/operator-guide.md:1370`. That promise is not met:
- No source in `apps/` or `packages/` reads `SENTRY_DSN`, or `OTEL_EXPORTER_OTLP_ENDPOINT` either.
- `pnpm-lock.yaml` holds no `@sentry/*` package.

The owner wants a DSN for the remote worker that a person can set at any time.

`@sentry/node` 11.11.0 is MIT-licensed. Its unpacked size is 1.6 MB, with seven direct dependencies:
`@sentry/core`, `@opentelemetry/api` and five `@sentry/*` packages ([registry.npmjs.org/@sentry/node/latest](https://registry.npmjs.org/@sentry/node/latest), read 2026-11-05).

**Decision.**
1. **One reporter for both roles.** It lives in `packages/infrastructure` and uses `@sentry/node`'s
   `NodeClient` with:
   - **no default integrations** (no auto-instrumentation, no console or HTTP breadcrumbs);
   - `sendDefaultPii: false`.

   It is fed **only** by the composition's own `error`/`fatal` log path. Each event carries:
   - the error's type;
   - the error's message, bounded at 1 KiB;
   - the stack;
   - the tags `role`, `worker_id`, `core_url`, `version`/`commit` and `run_id`.

   Every other field is dropped. Being explicit is what lets the content be stated:
   - **No transcript, prompt, tool input, ticket text, project name or ticket key**, ever (BD-022, and
     the developer's privacy).
   - A run id is enough for whoever can read the run on the core.
2. **Redaction before sending.** `beforeSend` and `beforeBreadcrumb` pass the whole event through two
   redactors:
   - **The exact-value redactor.** On the worker it covers the Claude token, each live run's token and
     credential, the UI token and the `wkr_` credential. On the core it covers `APP_SECRET_KEY`, the
     database password and the launcher token.
   - **The shipped pattern redactor** (TD-012).
3. **Where the DSN comes from.**
   - **On the worker**, `SENTRY_DSN(_FILE)` from the environment wins. Otherwise a `sentry-dsn` file in
     `worker-state` is used, set from the local page's *Error reporting* setting.
     - The setting is a settings item, not a wizard step: *Save*, *Send a test error*, *Remove*.
     - It is validated as `https://<key>@<host>/<project id>`, with `http:` only for loopback.
     - A change applies **without a restart**: the reporter closes its client and builds a new one.
   - **On the core**, the DSN is read from the environment only, and reporting is off when unset.
4. **`@sentry/node` is a dependency of `apps/server` only.**
   - `THIRD_PARTY_NOTICES.md` is regenerated.
   - The image's size delta is measured against TD-018.
   - No `@sentry/*` reaches `apps/web`: a census test enforces this, and `worker.html` keeps its 120 kB.

**Rejected.**
- *The SDK's default `init`*: auto-instrumentation and breadcrumbs collect what nobody listed.
- *A restart to apply*: a setting that bounces a worker mid-run is worse than a swapped client.
- *Docs-only correction for the core*: the core reuses the same module, so the cost is one
  composition line.

**Residuals.**
- An error message is redacted for exact values and patterns, not for meaning. A third-party message
  that quotes untrusted text could carry up to 1 KiB of it.
- A DSN is a host a person chose: the worker sends its events there.
- **OpenTelemetry stays unbuilt.** The operator guide is corrected by WP-295, and the gap is filed as
  backlog 885.
