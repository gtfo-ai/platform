-- 0037 — the ending a poisoned event never had (WP-49, PROGRESS backlog 43).
--
-- ## What was wrong
--
-- A handler that fails leaves its event queued: `attempts` is incremented, `available_at` is pushed
-- into the future, and the sweep picks the row up again. Nothing ever compared `attempts` with a
-- bound, so an event whose handler fails *deterministically* — a payload no handler can parse, a
-- schema change under a queued event, an integration permanently answering 403 — was re-dispatched
-- at the backoff ceiling (`APP_DISPATCH_MAX_RETRY_DELAY_MS`, 300 000 ms) for ever, roughly twelve
-- times an hour, with every later event of its stream queued behind it (`hasEarlierPending`).
--
-- ## What these two columns are
--
-- `dead_lettered_at` is the **terminal state the sweep's predicate excludes**: a row that carries it
-- is no longer offered to a dispatcher, no longer blocks its stream, and is no longer counted as
-- backlog. `dead_letter_handler` is the handler whose failure spent the bound — the one fact an
-- operator needs that `error` (the message) does not carry, and the one the task's blocker brief
-- quotes.
--
-- **The row stays.** Deleting it would be the other way to unblock the stream and it would destroy
-- the work item: `event_dispatch` is the only place that says *this event has not been dispatched*,
-- and a deleted row is spelled exactly like a dispatch that finished (`claim` answers `completed`).
-- Keeping the row is what makes the dead letter countable (`event_dispatch_dead_lettered`, beside
-- the backlog gauge), re-queueable by hand (`update event_dispatch set dead_lettered_at = null,
-- attempts = 0 where event_position = …`) and visible to somebody reading the table.
--
-- **`events` is untouched.** It is append-only (TD-005, `REVOKE DELETE`), so nothing here removes
-- evidence: a dead-lettered event is still in the log and is still replayable by
-- `packages/application/src/events/replay.ts`, which reads `events` and never this table.
--
-- ## Indexes
--
-- The partial index serves the two reads that exist for these rows — the metric's count and an
-- operator's "what is poisoned" — and, being partial, it holds one entry per dead letter rather
-- than one per queued event. The sweep's own predicates (`event_dispatch_ready_idx`,
-- `event_dispatch_stream_idx`) are unchanged: they now carry `dead_lettered_at is null` as a filter
-- over a table that is small by construction (one row per undispatched event), and adding the
-- column to either index would pay on every append to save on the rows this migration exists to
-- make rare.
--
-- No backfill: `null` is the honest value for every existing row — *"nothing has spent this event's
-- bound"* — and it is what the sweep should believe about all of them.

alter table event_dispatch add column dead_lettered_at timestamptz;
alter table event_dispatch add column dead_letter_handler text;

comment on column event_dispatch.dead_lettered_at is
  'When this event stopped being retried because it spent APP_DISPATCH_MAX_ATTEMPTS (WP-49). The sweep, the ordering guard and the backlog count all exclude a row that carries it; events itself is untouched, so the event stays replayable.';
comment on column event_dispatch.dead_letter_handler is
  'The handler whose failure spent the bound; the task''s blocker brief names it beside the event position.';

create index event_dispatch_dead_letter_idx
  on event_dispatch (dead_lettered_at)
  where dead_lettered_at is not null;
