# TD-004 — pg-boss for jobs, delayed timers, cron and coalesced wake-ups

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** TD-003, research/06

## Decision
Use **pg-boss** (MIT, 12.x, Node ≥ 22.12, PG ≥ 13) in the application database for: stage execution (`stage.execute`, singleton key `task:<id>`, priority from ticket priority), timers (`question.timeout`, `question.reminder` with `startAfter` computed on the working-day calendar, `mr.comment.debounce` coalesced 2 minutes, `budget.window.reset` cron, `poll.<provider>` cron), index rebuilds, maintenance schedules. Hidden behind a `Jobs` port.

> **Amended at WP-04/WP-05 (2026-09-09), on the architect's analysis. Two claims above were wrong.**
> 1. **`dispatch(event)` is not a pg-boss workload.** TD-005's `event_dispatch` table plus its sweep is
>    the single queue of record. Routing individual events through pg-boss as well would duplicate
>    durability across two queues that disagree after a crash, and pg-boss has no per-stream
>    serialisation, so ordering would collapse into a retry storm instead of deliberate head-of-line
>    blocking. The outbox sweep is driven by a **local timer in each process** (~1s, TD-014's fallback
>    for that process's own NOTIFY subscription) — never by cluster cron, which cannot be the fallback
>    for a subscription it does not share. N replicas polling one `event_dispatch` is correct and cheap:
>    the claim uses `FOR UPDATE SKIP LOCKED`, so concurrent sweeps never block, and `drain()` exits when
>    a batch dispatches nothing. The canonical name for the sweep is `events.outbox.sweep`, a log and
>    metric label, **not** a queue name.
> 2. **There is no transactional enqueue.** The pg-boss adapter binds one pool, so `enqueue` cannot join
>    a handler's transaction. Enqueue **after** commit and **re-validate on fire** — which is what this
>    record already assumes elsewhere when it says timers re-validate. WP-15 must not rely on an
>    enqueue being rolled back with its handler.
> 3. `mr.comment.debounce` is **not** a debounce and must not use `coalesce`: both coalescing modes are
>    leading-edge, and `startAfter` + `coalesce` is rejected by the port. Use `stately` + `singletonKey`
>    + `startAfter` for a fixed window whose handler re-reads every unresolved thread (see WP-05 in
>    `technical/PROGRESS.md`).
>
> pg-boss also cannot express sub-minute repetition (5-field cron, 1-minute floor), and no TD-004
> workload needs it.

## Rationale
Covers plain jobs and durable timers with zero extra containers; `singleton`/`stately` policies map directly onto coalesced wake-ups; dead-letter + retention. graphile-worker is an equivalent alternative (NOTIFY latency, `jobKey`, serial queues) and can replace it behind the port.

## Alternatives considered
BullMQ (Redis container), NATS JetStream (second stateful system; revisit for multi-node fan-out), RabbitMQ (no advantage).

## Consequences
- Every timer job re-validates state when it fires (idempotent), so cancellation is optional.
- pg-boss schema lives in the same database (`pgboss.*`); included in backups.
