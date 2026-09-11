# TD-005 — Own append-only event store on Postgres with an in-process priority dispatcher; no event-sourcing library

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** technical/02, technical/03, research/06, research/07, BD-003, BD-017

## Decision
`events` table (monthly partitions, `UNIQUE(stream_type, stream_id, stream_seq)`, `REVOKE UPDATE/DELETE`), `handler_executions` for idempotency, `inbox` for webhook dedup. Aggregates are loaded with `SELECT … FOR UPDATE`, emit events with `seq = last + 1`, and the same transaction enqueues `dispatch(event)`; the table is the outbox. The dispatcher runs handlers in priority order (0–99 core, 100–199 integrations, 200–299 notifications/UI, 300+ custom), sequentially, recording each execution; handlers may emit events (appended in the same transaction, dispatched after the current handlers); policy handlers at top priority may `stop()`. NOTIFY is used only as a wake-up hint once per committing transaction. Consumers track per-stream sequence (global position is not gapless).

## Rationale
The needed schema is ~4 tables; the only TS event-store library with a Postgres backend (Emmett) has an unresolved licence; no engine offers ordered multi-handler dispatch anyway. Owning it keeps the audit engine-independent.

## Consequences
- Projections inline in the same transaction for MVP; async projections later if UI load demands.
- Export per task = events + runs + messages + artifacts as JSON.

> **Amendment (WP-15a, 2026-09-11): a process that sweeps the outbox must be a complete consumer.**
>
> The dispatch site is **unchanged**: an event no handler matched is a completed dispatch —
> `dispatchQueue.complete(position)` plus the `$dispatch` marker — and that is correct, because the
> alternative was measured and is worse. Leaving such an event queued would make `hasEarlierPending`
> block **every later event of the same stream**, so one never-handled type permanently halts each
> aggregate that emits it, visible only as a rising gauge; and the queue could not tell
> `knowledge.index.rebuilt`, whose catalogue consumer is `—`, from a missing pipeline. Completing is
> safe because `events` is append-only and the application holds no `DELETE` on it: only the **work
> item** dies, and a handler added later is served by a **backfill from the log**.
>
> What was wrong was **who** may sweep. `event_dispatch` has one row per event for the whole
> deployment, so `complete(position)` discharges *every* handler in it, and only `ROLE=all|worker`
> sweep while other roles take work through pg-boss. An empty `handlersFor(type)` is therefore a
> statement about **the process**, never about the event: a sweeper holding a partial set destroys
> another process's work item exactly as an empty one does. The arbiter moves from the dispatch site
> to **composition**.
>
> The platform declares, per catalogue event type, whether it is `handled` or `unconsumed`
> (`packages/application/src/events/consumption.ts`; the catalogue's "Core consumers" column in
> technical/02 is the normative source, with `—` meaning *declared unconsumed*). Before the outbox
> worker starts, every `handled` type must have at least one registered handler; otherwise the sweep
> does not start, `/readyz`'s `dispatch` check is `down` (TD-023's own amendment), and the warning
> names the missing types. **One predicate serves both gates**, because two readings of one
> condition drift apart (standing rule 41).
>
> **Deliberately not in scope, and needed before the first projection ships:** a re-dispatch/backfill
> tool that replays a range of the log to a newly added handler, and alerting on
> `event_dispatch_pending`. Per-consumer-group cursors — a row per (event, consumer) instead of one
> per event — would remove the whole-deployment coupling and is a *new* decision, not this one.

