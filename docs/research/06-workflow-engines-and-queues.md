# Research: durable workflow engines, job queues, event log (2026-09-09)

> Sources linked inline; versions checked against release pages/npm on 2026-09-08/09. Informs TD-003 (pipeline runtime), TD-004 (jobs/timers), TD-005 (event store).

## What the product demands
Human waits of days–weeks (questions, approvals, MR review); durable timers in working days and org timezone; wake-on-event from webhooks/Slack; WIP admission ("max tasks in pipeline incl. waiting" — domain logic no engine has natively); bounded loops with counters; append-only audit kept forever; **pipeline is data** (per-project templates editable independently of platform code); Compose with minimal ops; no Kafka.

Two consequences: (a) a code-defined deterministic workflow (Temporal/DBOS/Restate) would have to be a generic *interpreter* anyway; (b) the domain event log is mandatory regardless, so an engine's history would be a second, retention-bound audit.

## Engines — decision matrix (condensed)

| Engine | License / version | Extra containers | Postgres-only | Timers / wait-for-event | Versioning of in-flight workflows | Fit |
|---|---|---|---|---|---|---|
| Temporal | MIT server 1.31.2 (2026-07), TS SDK 1.23 | +2 (server, UI) | yes (2 DBs; ES "recommended beyond a few workflows") | yes / signals, updates | `patched()` discipline forever; determinism errors on slips | strongest primitives, highest ops burden; official docker-compose repo archived 2026-01-05 |
| DBOS Transact | MIT, `@dbos-inc/dbos-sdk` 4.27.6 (2026-08), 1.35k★ | 0 (library on your Postgres) | yes | `DBOS.sleep` / `recv`, `setEvent`, `waitFirst`; queues with priority, dedup | recovery only for matching app-version hash unless pinned + `DBOS.patch()`; API v2→v4 in ~20 months; UI is paid SaaS | best *second-phase* candidate (same DB, zero containers) |
| Restate | BSL 1.1 server 1.7.9, TS SDK MIT | +1 (RocksDB volume) | no | yes / awakeables | old deployment must stay up until drained | second stateful store; upgrade model conflicts with "pull new image" |
| Inngest self-host | SSPL server 1.44 | +1 (+Redis) | no | `sleep`, `waitForEvent` | step memoisation | SSPL, Redis, HTTP-callback steps awkward for hour-long runs |
| Hatchet | MIT 0.106.5 | +1 (`hatchet-lite`, "dev/low-volume") | yes | `sleepFor`, `waitForEvent` | undocumented for durable tasks | lightest real engine with UI; gRPC; 0.x |
| Trigger.dev v4 | Apache-2.0 | ~9 containers | no | yes | per deploy | footprint; competes with our workspace model |
| Windmill | AGPL CE | +2 | yes | approval steps | flow defs versioned | a second product |
| Conductor OSS | Apache-2.0, Java | +1 JVM | profile | WAIT/HUMAN tasks | definitions versioned per instance | JVM ops, JSON DAG DSL |

Sources: https://docs.temporal.io/develop/typescript/workflows/versioning , https://github.com/temporalio/docker-compose , https://docs.dbos.dev/typescript/tutorials/upgrading-workflows , https://docs.dbos.dev/production/workflow-recovery , https://docs.restate.dev/operate/versioning , https://www.inngest.com/docs/self-hosting , https://docs.hatchet.run/self-hosting/hatchet-lite , https://trigger.dev/docs/self-hosting/docker , https://github.com/conductor-oss/conductor

**Disqualifier for the big engines:** they assume the operator manages code versions of in-flight workflows (keep old workers alive or patch every change). Agentic operators upgrade by pulling an image while tasks sit for weeks. The universal mitigation is a generic interpreter workflow — at which point the engine only adds durable sleep/wait/retries/UI, which a Postgres queue plus our own tables provide with zero containers.

## Job queues

| Queue | License / version | Store | Timers | Priority | Dedup/coalesce | Per-key ordering | Transactional enqueue |
|---|---|---|---|---|---|---|---|
| **pg-boss** | MIT 12.30, Node ≥22.12, PG ≥13 | Postgres (SKIP LOCKED) | `startAfter` | yes | `singleton`/`stately` policies, throttle/debounce | via singleton | yes |
| **graphile-worker** | MIT 0.18, Node ≥22.18 | Postgres | `run_at` | yes | `jobKey` replace/preserve | `queueName` serial | yes (SQL `add_job`) |
| BullMQ | MIT 6.3 | Redis | yes | yes | ids | groups (Pro) | no |
| NATS JetStream | Apache-2.0 2.14 | own | via scheduling | no | Msg-Id window | per subject | no |
| RabbitMQ | MPL-2.0 4.3 | own | plugin | yes | no | per queue | no |

Sources: https://github.com/timgit/pg-boss , https://github.com/graphile/worker , https://github.com/taskforcesh/bullmq , https://github.com/nats-io/nats-server

Verdict: a Postgres queue covers plain jobs *and* durable timers (question timeout = delayed job; reminders; budget reset = cron; MR-comment debounce = coalesced job). Redis/NATS/RabbitMQ add a container for no MVP benefit.

## Event log / outbox on Postgres
- LISTEN/NOTIFY: global commit lock when many transactions NOTIFY (Recall.ai outages, https://www.recall.ai/blog/postgres-listen-notify-does-not-scale); fine when NOTIFY is once per committing transaction that enqueued work and readers also poll (https://www.dbos.dev/blog/postgres-listen-notify-scalability). Rule: NOTIFY is a wake-up hint, never per event row; payload ≤ 8 000 bytes; not durable.
- Libraries: Emmett (Postgres event store, TS) has an **unresolved license** (RFC toward AGPL/SSPL open-core, https://github.com/event-driven-io/emmett) — unsuitable; message-db (MIT) sound but quiet; pg-transactional-outbox needs logical replication. **A library is not warranted**: ~4 tables (`events` with `UNIQUE(task_id, seq)` and `REVOKE UPDATE/DELETE`, `handler_executions`, `inbox`, projections). Per-aggregate ordering via `SELECT … FOR UPDATE` then `seq = last+1`; the events table *is* the outbox — enqueue `dispatch(event_id)` in the same transaction.
- Priority dispatch is in-process code in every option (no engine offers ordered multi-handler dispatch). Reference semantics: Symfony EventDispatcher (integer priority, `stopPropagation`), webpack `tapable` `AsyncSeriesBailHook`. ~100-line registry: sort by priority, sequential await, handler may `emit()` (appended in the same transaction, dispatched after current handlers), executions recorded for idempotency, `stop()` for policy handlers (kill switch, budget) at top priority.

## What to copy from peers
- Paperclip: `heartbeat_runs` statuses, coalesced wakeups, atomic checkout `UPDATE … WHERE status = ANY(:expected)`, append-only cost events. https://github.com/paperclipai/paperclip/blob/master/docs/agents-runtime.md
- Symphony: dispatch order priority → created_at → id; per-state concurrency caps; failure backoff `10000·2^(n−1)` capped 5 min; reconcile-on-boot. https://github.com/openai/symphony/blob/main/SPEC.md
- OpenHands: linear per-task log as source of truth; condensation as an event. https://docs.openhands.dev/sdk/arch/events.md
- Devin Dynamic Workflows: memoise agent calls by `hash(prompt, schema, settings)` so retries/forks never re-spend a finished stage; fork from stage N. https://docs.devin.ai/work-with-devin/dynamic-workflows

## Recommendation (adopted as TD-003/004/005)
**Postgres-native pipeline:** explicit persisted state machine + domain event log (doubles as outbox) + in-process priority dispatcher with recorded handler executions + **pg-boss** for jobs/timers/cron/coalescing + pipeline *interpreter* over a per-task template snapshot (template edits never break in-flight tasks) + Paperclip-style atomic claims and leases for runs + `run_key` memoisation. Compose = `app` + `postgres` (+ runner). Three ports keep migration cheap: `Jobs`, `WorkflowRuntime`, `EventStore`; DBOS is the natural later upgrade (same DB, zero containers), Temporal/NATS the Kubernetes-era options.

Risks of the own core: timer/retry/lease bugs → tiny primitive set, state-machine/property tests, reconcile loop at boot (expired leases, orphaned runs, stale timers), memoisation makes retries free.
