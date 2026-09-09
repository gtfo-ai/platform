# TD-014 — Real-time transport: one multiplexed SSE stream per tab with per-topic sequence ids and replay; commands over HTTP

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/08, technical/08, technical/09, TD-002

## Decision
`GET /events` (SSE) with topic subscriptions managed via POST; every event carries `id: <seq>` per topic; server keeps a ring buffer per topic backed by the event/message tables; reconnect with `Last-Event-ID` replays or sends `reset`. Fan-out across app instances via Postgres `NOTIFY` (one per committing transaction) with polling fallback; a Redis/NATS pub/sub adapter behind the `Broadcast` port for multi-node later. HTTP/2 termination recommended in the reverse proxy; the app documents the 6-connection limit on HTTP/1.1. Partial deltas are coalesced server-side (≥ 50 ms) and only forwarded while a client is subscribed to the run.

## Alternatives considered
WebSocket (no high-frequency client→server traffic; more infra sensitivity), long polling.
