# TD-023 — Config with zod, logging with pino, metrics with @prometheus-io/client, optional OpenTelemetry and Sentry, health endpoints

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/11, technical/12, TD-020, BD-020

## Decision
Single `config.ts` parsed with zod 4 at boot (fail fast; `z.stringbool()` for booleans; `_FILE` variants resolved first); `.agentic/*.yml` validated with zod schemas exported as JSON Schema under `schemas/`; pino 10 structured JSON to stdout with `redact` and an `AsyncLocalStorage` mixin carrying `request_id/task_id/run_id/trace_id`; `@prometheus-io/client` at `/metrics` (HTTP duration histogram, `agent_runs_active`, `agent_tokens_total{model,kind}`, `agent_cost_usd_total`, `queue_depth`, `queue_job_age_seconds`); OpenTelemetry traces/metrics only when `OTEL_EXPORTER_OTLP_ENDPOINT` is set (`@fastify/otel`, pg, undici instrumentations; run spans wrap SDK calls; Claude Code's own OTel pass-through optional per run); `@sentry/node` only when `SENTRY_DSN` is set; `/healthz` (under-pressure) and `/readyz` (DB, migrations head, queue). Secrets typed as `Secret` with `toJSON → [REDACTED]`; integration secrets encrypted at rest with AES-256-GCM under `APP_SECRET_KEY` (key id for rotation).
