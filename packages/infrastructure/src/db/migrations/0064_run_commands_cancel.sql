-- 0064 — a cancel of a live run reaches the session (WP-101, TD-028 decision 11, PROGRESS backlog 294).
--
-- Until this migration `POST /api/runs/:run_id/cancel` ended the run **as a record** only: the row
-- moved to `cancelled` in the request's transaction and the session it named kept running, and
-- spending, in the process holding the run until it ended on its own; its spend then arrived late
-- through `runs.recordCost` (WP-47, Q70 (b)). WP-85 built the channel a take-over's stop already
-- rides (migration 0060); this admits the cancel onto it.
--
-- ## Which branch writes what
--
-- * **The lease is live** (`runs.lease_expires_at` in the future, `lease_owner` set): the command
--   records a `cancel` row in the aggregate operation's transaction — the task is paused there, as
--   before — notifies the holder and answers `202`. The holder applies it as `RunHandle.stop` and the
--   run ends `cancelled` **in its own process, with its measured cost**, which is the take-over's
--   shape. One terminal writer: the holder.
-- * **No live lease** (absent or expired): no process holds the session, and the command ends the
--   record in place as it always did. No row is written.
-- * **A holder that dies before applying** leaves the row pending; the lease sweep (WP-47) ends the
--   run `lease_expired` and its `finish` closes the row `run_ended`, like every other pending command.
--
-- `payload` for a cancel is the empty object: the stop carries no instruction beyond its kind.
--
-- 0060 is forward-only once applied (TD-011), so the constraint is replaced here rather than edited
-- there.

alter table run_commands drop constraint run_commands_kind_known;

alter table run_commands
  add constraint run_commands_kind_known check (kind in ('steer', 'take_over', 'cancel'));

-- The steer window (technical/08: one message per five seconds per user) is read off this table
-- since WP-101 — a user's `steer` rows inside the interval, under a per-user advisory lock — rather
-- than held in each API process's memory (PROGRESS backlog 295). `actor_user_id` had no index.
create index run_commands_steer_window_idx on run_commands (actor_user_id, created_at desc)
  where kind = 'steer';
