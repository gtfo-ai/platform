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
