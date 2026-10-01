-- 0068 — the merge-request poller's cursor, and the read that keeps one transition one event
-- (WP-110, PROGRESS backlog 297).
--
-- ## `bindings.mr_poll_cursor`
--
-- WP-87's `poll_cursor` (migration 0061) for the git half: a git binding whose configuration sets
-- `poll_enabled` is asked, at its own interval, for its repository's merge requests updated since
-- this instant (`packages/application/src/pipeline/mr-poll.ts`). A column of its own rather than
-- `poll_cursor` reused, because the two pollers read different providers' timelines and a binding
-- row is one or the other only by the type of the integration it names — a column shared by two
-- writers is a column whose meaning depends on a join.
--
-- **The provider's instant, not the platform's**: the newest `updated_at` a poll recorded. Every
-- poll starts `TICKET_POLL_OVERLAP_MS` (five minutes) behind it, and what it re-reads collides on
-- the `inbox` key. **Nullable, no default**: `null` is "never polled", and the first poll reads the
-- binding's last interval only. The PUT that replaces a project's bindings deletes and re-inserts
-- the rows, so it resets the cursor to that answer. **One writer**,
-- `MergeRequestPollStore.advanceCursor`, forward only (`greatest`), after every listing of a page
-- has been recorded; **one reader**, `MergeRequestPollStore.cursorOf`.
--
-- ## `events_mr_lifecycle_idx`
--
-- Since WP-110 a merge-request transition can reach the platform through two doors — the webhook
-- and the poller — and `recordNormalisedDelivery` drops a lifecycle draft (`mr.opened`,
-- `mr.merged`, `mr.closed`) that repeats the newest one the project's log already holds for that
-- merge request (`packages/application/src/integrations/merge-request-lifecycle.ts`). That is a read
-- per lifecycle draft on **every** git delivery, and without this index it is a scan of every
-- merge-request lifecycle event the installation has ever recorded, filtered by a JSON path. The
-- index is partial — the three lifecycle types only, a few rows per merge request — and on the two
-- expressions the read compares, so the read is an index range of the rows for one merge request
-- of one project, ordered by `position` afterwards. `events` is partitioned by `occurred_at`, so the
-- index is created on every partition, and on every partition created later.
--
-- `type in (...)` is spelled exactly as the read spells it: the planner uses a partial index only
-- when it can prove the query's predicate implies the index's.

alter table bindings add column mr_poll_cursor timestamptz;

create index events_mr_lifecycle_idx
  on events ((payload ->> 'project_id'), ((payload -> 'mr') ->> 'iid'))
  where type in ('mr.opened', 'mr.merged', 'mr.closed');
