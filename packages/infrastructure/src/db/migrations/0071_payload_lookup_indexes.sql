-- 0071 — two payload lookups get the index their measured plans asked for (WP-115, PROGRESS
-- backlog 307 and 312). Both plans, before and after, are pasted under those entries; the numbers
-- below are from that measurement (Apple M3 Max, PostgreSQL 18 in the integration harness's
-- container, warm cache, one-minute load 4–8; wall-clock figures are that machine's, the buffer
-- counts are the plan's).
--
-- ## `events_bug_trace_ticket_idx`
--
-- `PipelineStore.bugTraces.latest` (`packages/infrastructure/src/pipeline/postgres-pipeline-store.ts`)
-- runs on **every** `ticket.updated` of a bound project — bug or not, since the handler asks before
-- it knows the ticket type and `null` is the non-bug's answer — and again when the `bug_trace` job
-- fires. Without this index the planner had `events_type_occurred_at_idx` and the stream index,
-- and every plan it chose read rows unrelated to the ticket: at 10^3 project events a `BitmapAnd`
-- of both (127 buffers, 0.12–0.17 ms); at 10^5 project events with 1 100 traces in the installation
-- the **installation's** `ticket.bug.traced` rows, one heap page each (1 112 buffers, 0.36–0.45 ms);
-- at 10^5 project events with 10 100 traces a `BitmapAnd` again (1 285 buffers, 2.9–3.6 ms). The
-- cost grew with history — the project's stream or the installation's traces, whichever the
-- planner preferred — and never with the ticket. With this index the read is one index range per
-- monthly partition: 6–7 buffers, 0.02–0.05 ms, the same at every size measured.
--
-- **Partial on the one type the read asks for**, so only trace rows are indexed (about 50 bytes
-- each: 488 KiB for 10 100 traces across seven partitions) and no other append pays for it. The
-- key is the stream and the ticket key — the provider is filtered after, because two providers'
-- tickets sharing a key in one project is a handful of rows at most. `type = '…'` is spelled
-- exactly as the read spells it: the planner uses a partial index only when it can prove the
-- query's predicate implies the index's. `events` is partitioned by `occurred_at`, so the index is
-- created on every partition and on every partition created later.
--
-- ## `human_actions_project_idx`
--
-- `findLastConfigExport` (every settings-page load and every export press) and `listProjectAudit`
-- (`apps/server/src/queries/project-queries.ts`) filter `human_actions` on `params ->> 'project_id'`.
-- The table's one secondary index is `(task_id, created_at desc)`, so both were a sequential scan
-- of the installation's whole audit: 167 buffers and 0.3–0.4 ms at 10^4 rows, 16 700 buffers and
-- 22–27 ms (a parallel scan, two workers) at 10^6 — linear in the installation, whatever the
-- project. With this index both are one index range of the project's rows, newest first, stopped
-- by the `limit`: 53–63 buffers and 0.03–0.04 ms at 10^6.
--
-- An expression index rather than a `project_id` column: the column would need a writer at every
-- insert site and a backfill, and would still be null for a task command (whose row names a task);
-- the expression is what both reads already compare. **Partial on rows that carry the key**, so a
-- task command's row — most of the table — is not indexed; `params ->> 'project_id' = $1` implies
-- `… is not null`, which is what lets the planner use it.
--
-- Building either index takes a `SHARE` lock on its table for the build, so `migrate` blocks
-- appends to `events` and `human_actions` while it scans them. Measured on the machine above: 38 ms
-- to build the first over 2 x 10^5 events (10 100 of them traces), 71 ms for the second over 10^6
-- rows (3.3 MiB of index for 50 000 project rows). A larger installation pays a longer one-off
-- pause of the same shape as 0068's, in proportion to `events` and `human_actions`.

create index events_bug_trace_ticket_idx
  on events (stream_id, ((payload -> 'ticket') ->> 'key'))
  where type = 'ticket.bug.traced';

create index human_actions_project_idx
  on human_actions ((params ->> 'project_id'), created_at desc)
  where (params ->> 'project_id') is not null;
