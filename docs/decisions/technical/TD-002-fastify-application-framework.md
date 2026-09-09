# TD-002 — Application framework: Fastify 5 with awilix DI, zod type provider, official SSE plugin, close-with-grace; own prioritised event bus

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/11, technical/01, technical/08, TD-014, BD-017

## Decision
Fastify 5 (`@fastify/awilix` for DI, encapsulated plugins as modules, `fastify-type-provider-zod` + `@fastify/swagger` for validated, documented routes, `@fastify/sse` for the event stream, `@fastify/websocket` unused for now, `close-with-grace` for shutdown: 503 on readiness → `preClose` ends SSE streams with a `shutdown` event → drain → `onClose` closes pg/pg-boss). One process image with a `ROLE` env (`all | api | worker | runner | indexer`). The in-process **event bus** with numeric priorities, sequential awaited handlers, recorded executions and chaining is our own ~100-line module (TD-005). `@fastify/compress` must exclude `text/event-stream`.

## Alternatives considered
NestJS 12 (built-in DI/decorators; fresh major, effectively one maintainer, no handler priority, SSE shutdown hangs); Hono (own `node:http` lifecycle); Express 5 (dormant); Elysia (Bun host); Effect (v4 RC, team fluency).
