# TD-023 — Config with zod, logging with pino, metrics with @prometheus-io/client, optional OpenTelemetry and Sentry, health endpoints

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/11, technical/12, TD-020, BD-020

## Decision
Single `config.ts` parsed with zod 4 at boot (fail fast; `z.stringbool()` for booleans; `_FILE` variants resolved first); `.agentic/*.yml` validated with zod schemas exported as JSON Schema under `schemas/`; pino 10 structured JSON to stdout with `redact` and an `AsyncLocalStorage` mixin carrying `request_id/task_id/run_id/trace_id`; `@prometheus-io/client` at `/metrics` (HTTP duration histogram, `agent_runs_active`, `agent_tokens_total{model,kind}`, `agent_cost_usd_total`, `queue_depth`, `queue_job_age_seconds`); OpenTelemetry traces/metrics only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`@fastify/otel`, pg, undici instrumentations; run spans wrap SDK calls; Claude Code's own OTel pass-through optional per run); `@sentry/node` only when `SENTRY_DSN` is set; `/healthz` (under-pressure) and `/readyz` (DB, migrations head, queue, **dispatch** — see the amendment below). Secrets typed as `Secret` with `toJSON → [REDACTED]`; integration secrets encrypted at rest with AES-256-GCM under `APP_SECRET_KEY` (key id for rotation).

> **Amendment (WP-15a, 2026-09-11): `/readyz` has a fourth check, `dispatch`, and a worker whose
> event bus has no handlers is `down`.**
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
