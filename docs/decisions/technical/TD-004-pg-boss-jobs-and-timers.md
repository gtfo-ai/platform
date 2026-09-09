# TD-004 — pg-boss for jobs, delayed timers, cron and coalesced wake-ups

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** TD-003, research/06

## Decision
Use **pg-boss** (MIT, 12.x, Node ≥ 22.12, PG ≥ 13) in the application database for: dispatch jobs (`dispatch(event)`), stage execution (`stage.execute`, singleton key `task:<id>`, priority from ticket priority), timers (`question.timeout`, `question.reminder` with `startAfter` computed on the working-day calendar, `mr.comment.debounce` coalesced 2 minutes, `budget.window.reset` cron, `poll.<provider>` cron), index rebuilds, maintenance schedules. Transactional enqueue with the event append. Hidden behind a `Jobs` port.

## Rationale
Covers plain jobs and durable timers with zero extra containers; `singleton`/`stately` policies map directly onto coalesced wake-ups; dead-letter + retention; transactional send. graphile-worker is an equivalent alternative (NOTIFY latency, `jobKey`, serial queues) and can replace it behind the port.

## Alternatives considered
BullMQ (Redis container), NATS JetStream (second stateful system; revisit for multi-node fan-out), RabbitMQ (no advantage).

## Consequences
- Every timer job re-validates state when it fires (idempotent), so cancellation is optional.
- pg-boss schema lives in the same database (`pgboss.*`); included in backups.
