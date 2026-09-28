-- 0060 — a human command reaches a live run through the database (WP-85, TD-028 decision 9,
-- PROGRESS backlog 134).
--
-- ## Why a table
--
-- The live-run register is per process and the shipped topology pins the process that serves the
-- API never to hold a run, so until this migration every steer was refused `run_not_reachable` and
-- every take-over recorded `run_id: null`. TD-028's M5 amendment (decision 9) decides the shape: the
-- API process **records** the command here, in the same transaction as the aggregate operation,
-- wakes the lease holder with `pg_notify`, and the holder — which also polls its own leased runs'
-- pending rows on the lease heartbeat, because a notification is not delivered to a connection that
-- was reconnecting — applies it to its in-process register and stamps the row.
--
-- ## The three states, and who writes each
--
-- * **pending** — `applied_at` and `refused_at` both null. Written by the command
--   (`packages/application/src/pipeline/commands.ts`), only while the run row is live: the insert
--   is preceded by a `for share` lock on the run, so it cannot interleave with the run's ending.
-- * **applied** — `applied_at`. Written by the holder, conditional on the row still pending **and**
--   the run still live and leased to that holder (`run-commands.ts`), which is the arbiter between
--   the notification and the poll: whichever wins stamps, the other writes nothing (rule 9).
-- * **refused** — `refused_at` plus a typed `refused_reason`:
--   `run_ended` — the run ended while the command was pending; written by the run's own ending
--   (`RunRepository.finish`), in its transaction, so a command for a run that ended is never applied
--   late; `register_miss` — the heartbeat of the process holding the lease found no live handle for
--   the run in its register; `delivery_failed` — the holder stamped the row applied (the arbiter)
--   and the delivery to the live session then threw, so the stamp is turned into this refusal,
--   conditional on it still reading applied, and never back to pending: neither wake-up path can
--   deliver it a second time (WP-85 review round 1); `undecodable` — the holder could not read the
--   stored payload as any instruction this build knows, and refused that row alone rather than
--   failing every drain of the run.
--
-- ## `id` is derived from the `Idempotency-Key`
--
-- When the request carried one, the id is a digest of `(user, action, key)` computed by the composition
-- root (`apps/server/src/commands.ts`), so a replay that got past the key's own record would collide
-- on the primary key rather than write a second row. The key's record (`command_idempotency`) is the
-- first line; this is the second.
--
-- ## `payload` is redacted
--
-- A steer carries the person's message, redacted once by the command (TD-012) — the same bytes the
-- session, the transcript and the `run.steered` event get — and the author's display label. A
-- take-over's stop carries the export instruction (branch, commit message, tarball, keep-until).

create table run_commands (
  id uuid primary key,
  run_id uuid not null references runs (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  kind text not null,
  payload jsonb not null,
  actor_user_id uuid references users (id) on delete set null,
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  refused_at timestamptz,
  refused_reason text,
  constraint run_commands_kind_known check (kind in ('steer', 'take_over')),
  constraint run_commands_refused_reason_known check (
    refused_reason is null
    or refused_reason in ('run_ended', 'register_miss', 'delivery_failed', 'undecodable')
  ),
  constraint run_commands_one_ending check (applied_at is null or refused_at is null),
  constraint run_commands_refusal_named check ((refused_at is null) = (refused_reason is null))
);

-- The holder's poll and the ending's close both ask for a run's pending rows.
create index run_commands_pending_idx on run_commands (run_id)
  where applied_at is null and refused_at is null;

-- The run screen reads a run's commands newest first.
create index run_commands_run_idx on run_commands (run_id, created_at desc);

insert into platform_table_policy (table_name, app_access)
values ('run_commands', 'read_write');
