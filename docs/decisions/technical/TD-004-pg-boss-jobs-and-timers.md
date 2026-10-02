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

## Amendment (WP-56, 2026-09-26, on the architect's ruling) — the timers are one queue

`question.timeout` and `question.reminder` were declared from WP-05 and enqueued by nothing. Every
deadline the platform holds a person to — a blocking question (BD-006), a plan or budget approval
(BD-006's Q95 amendment) and a taken-over task's 5 working days (product/19 §19) — rides **one**
queue, `deadline.sweep`, whose payload is `(aggregate, id, kind)`; `startAfter` is computed on the
working-day calendar, the job is armed after commit by a handler (`pipeline.deadlines`, TD-005
priority 15), and it re-validates on fire against the aggregate, re-arming itself at least 60 s later
if it fires early. This is a deliberate deviation from the two named queues: a queue is a worker is a
pooled connection, so four timers on four queues would raise the pool floor by four with nothing
gained; one queue raises it by one (`POOL_RESERVATIONS.pipeline`, floor 21 → 22). Reminders are two
more `kind`s on the same queue since WP-84 (`question_reminder`, `approval_reminder`). Policy `stately`, keyed per `(aggregate, id, kind)`. The
arming enqueue can be lost the way every after-commit enqueue can (PROGRESS backlog 161), and rows
written before this change carry no deadline (backlog 162).

## Amendment (WP-87, 2026-09-29) — the ticket poller is one queue

The `poll.<provider>` cron named above is built as **one** `ticket.poll` queue keyed per binding
(`packages/application/src/pipeline/ticket-poll.ts`), declared in `JOB_QUEUE_DEFINITIONS` with every other
queue: a binding opts in, its interval is binding configuration, and its cursor is `bindings.poll_cursor`
(migration 0061). A lost poll is recovered by a sweep on `APP_POLL_SWEEP_INTERVAL_MS` (`APP_TICKET_POLL_SWEEP_INTERVAL_MS` before WP-123, still read for one release with a `warn`).
*Extended at WP-110 (session 11):* `mr.poll` is the same shape for git bindings — one queue keyed per
binding, its cursor `bindings.mr_poll_cursor` (migration 0068), recovered by the same sweep and its
variable (renamed at WP-123, PROGRESS backlog 372).

## Amendment (M7 architect pass, session 11, 2026-10-02) — every queue's exhaustion has a declared shape

Since WP-108, a job that spent its retries is listed for an administrator (`GET /api/org/failed-jobs`),
and `JOB_EXHAUSTION` classifies each queue. For five queues the classification says *nothing recovers
it*, and one of them drops a change a human accepted (PROGRESS backlog **366**). **Decision:** every
registered queue declares one of three shapes, and `job-exhaustion.test.ts` holds the declaration for
every queue:
- **a recovery row** in `recovery/stranded.ts`'s table, where the lost effect has a database trace
  (`knowledge.apply`: an approved proposal with no apply; `onboarding.discovery`: a completed discovery
  run with a stored draft and no evaluation), re-enqueued once under a mark and then made visible;
- **bound-and-escalate**, `stage.execute`'s shape, where the job carries a task and a human waits on
  its effect (`mr.comment.debounce`, and the `pipeline.outbound` duties that create, post or report);
- **notification-shaped**, listed only, where the next transition re-derives the effect or the loss is
  a notification (rule 20). This covers the workpad and status duties, and `notify.digest`.

There is **no re-queue from the failed-jobs list in 0.1**, because a handler that re-validates on fire
has not been shown for every queue (backlog 325's condition).

**Polling cadence (backlog 392).** A worker keeps `batchSize: 1`. A burst is drained through
`burstWhenReadyExceeds` where pg-boss's ready-count cache is populated as shipped, or otherwise through
a shorter per-queue `pollingIntervalSeconds` for `pipeline.outbound` and `pipeline.intake`. Per-queue
LISTEN/NOTIFY is not used in 0.1: it holds one more connection per process and moves the pool floor,
whose upgrade cost backlog 371 measured. Built by M7 **WP-124**, which measures first and states the
choice at the registration. *As built at WP-124 (session 11):* the cache **is** populated, but it
refreshes every 60 s, so the burst branch measured identical to doing nothing at the shipped cadence;
the per-queue branch was built — `pipeline.outbound` polls at 0.5 s (50 queued intakes drained in
25.0 s instead of 98.9 s; PROGRESS backlog 392 has the table).
