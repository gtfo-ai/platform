# TD-003 — Pipeline runtime: Postgres-native interpreter over per-task template snapshots (no workflow engine)

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/06, technical/02, BD-003, BD-005, BD-008, BD-020

## Context
Pipelines are data (per-project templates, editable independently of platform code), tasks wait days–weeks on humans, operators upgrade by pulling a new image, Compose must stay minimal, and the domain event log is mandatory. Temporal, DBOS and Restate all require the operator to manage code versions of in-flight workflows (patching, version hashes, pinned deployments); the universal mitigation is a generic interpreter workflow — at which point the engine only adds durable sleep/wait/retry/UI that a Postgres queue plus our tables already give.

## Decision
Implement the pipeline as an explicit, persisted state machine interpreted by an application handler (`pipeline.advance`) over a **template snapshot stored on each task** at intake (re-taken on `@agentic rework`). Waits and timers are delayed jobs; wake-ups are domain events from webhooks/polling/Slack; admission (WIP) is a handler that locks the project row; runs are claimed atomically with leases and heartbeats; completed stages are memoised by `run_key`. Three ports (`Jobs`, `WorkflowRuntime`, `EventStore`) keep a later move to DBOS (same database, zero containers) or Temporal cheap.

## Alternatives considered
Temporal (strongest primitives, +2 containers, patching discipline, retention-bound history); DBOS Transact (library-only, but recovery tied to app-version hash and paid UI — best second-phase candidate); Restate (BSL, RocksDB, pinned deployments); Inngest (SSPL, Redis); Hatchet (lightest engine with UI, gRPC, 0.x); Trigger.dev/Windmill/Conductor (footprint, second product, JVM).

## Consequences
- We own timer/retry/lease code: small primitive set, property-based state-machine tests, reconcile loop at boot (expired leases, orphaned runs, stale timers).
- Template edits never break in-flight tasks; the UI must show which snapshot a task runs on and offer "re-apply current template" at safe points.
