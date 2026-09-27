-- 0053 — the command idempotency record: one row per `(user, action, Idempotency-Key)` (WP-67,
-- PROGRESS backlog 47 and 99).
--
-- Until this migration the record was the `human_actions` row a performed command writes, read by
-- `findIdempotentAttempt` with a JSON predicate — so the lookup worked for a request that arrives
-- **after** the first one committed and did nothing for two that arrive **together**: both reads
-- return null under READ COMMITTED, both perform, and `human_actions` has no unique index to stop
-- the second row. A command whose aggregate cannot refuse a repeat (`feedback`, a shadow batch, a
-- breakdown decision) was performed twice under one key.
--
-- **Why a table of its own rather than a unique index on `human_actions`.** Two reasons, and the
-- second is decisive. (1) `human_actions` is `append_only` — a claim that has to be released when
-- the command is refused (a refused command is not an action a human performed, WP-15i) cannot be
-- a row of a table the application may not delete from. (2) The index would have to be built over
-- rows **already in the table**, and the window this migration closes is exactly the one that put
-- duplicates there: two rows with one `(user_id, action, params->>'idempotency_key')` are the
-- evidence of a double-perform, and a `create unique index` over them fails the upgrade. The audit
-- stays what it is — every row, duplicates included — and this table is the key's identity.
--
-- **The primary key is the scope** WP-15i and WP-21 argued for: a key belongs to the caller who
-- issued it (`apps/server/src/routes/idempotency.ts`), and two commands may share a key. `user_id`
-- cascades: a deleted user's keys are nobody's, which is the direction the old JSON lookup already
-- took (its `user_id` was left null and matched no predicate).
--
-- **Two states, one column.** `completed_at is null` is a **claim**: a request under this key is
-- performing, or a process died while it was. `completed_at` is set in the same statement set as
-- the `human_actions` row that records the performed command, and `human_action_id` names it so a
-- replay can answer with what the first attempt recorded. `human_action_id` is `on delete set
-- null` rather than bound to `completed_at` by a check: a task's deletion cascades to its
-- `human_actions` rows, and a key that performed a command must stay performed afterwards.
--
-- **Retention: none — a key is honoured for as long as the installation keeps its audit.** A
-- window after which a key is forgotten is a window after which a retry performs the command a
-- second time, and the audit row the key points at is kept forever too (technical/03). The table
-- grows by one row per keyed command, the same rate as `human_actions`. A claim nobody completed
-- is **not** swept either: it refuses its key (`409 idempotency_attempt_unknown`) until somebody
-- uses a new one, because a sweep cannot tell a command that never ran from one whose process died
-- between the effect and the record — and re-opening the second is the double-perform.
--
-- **The backfill** copies every keyed `human_actions` row into the record, completed, so a key used
-- before this migration is still a used key after it. Where the table already holds duplicates the
-- **first** row wins (`distinct on … order by created_at, id`): criterion (1) is that a replay
-- answers the first response, and the later rows are the double-performs this table exists to stop.
-- Rows whose key is not a string of the header's own shape, or whose user was deleted, are not
-- copied; the old lookup could not have matched them either.
create table command_idempotency (
  user_id uuid not null references users (id) on delete cascade,
  action text not null,
  idempotency_key text not null,
  -- The digest of the canonical request (`configHashOf`); null only for a backfilled row written
  -- before WP-21 recorded one, which nothing can be compared with.
  body_digest text,
  claimed_at timestamptz not null default now(),
  completed_at timestamptz,
  human_action_id uuid references human_actions (id) on delete set null,
  primary key (user_id, action, idempotency_key),
  constraint command_idempotency_key_shape check (
    length(idempotency_key) between 1 and 200 and idempotency_key ~ '^[A-Za-z0-9._:-]+$'
  ),
  constraint command_idempotency_completed_after_claim check (
    completed_at is null or completed_at >= claimed_at
  )
);

insert into command_idempotency (
  user_id, action, idempotency_key, body_digest, claimed_at, completed_at, human_action_id
)
select distinct on (user_id, action, params ->> 'idempotency_key')
  user_id,
  action,
  params ->> 'idempotency_key',
  case when jsonb_typeof(params -> 'body_digest') = 'string' then params ->> 'body_digest' end,
  created_at,
  created_at,
  id
from human_actions
where user_id is not null
  and jsonb_typeof(params -> 'idempotency_key') = 'string'
  and length(params ->> 'idempotency_key') between 1 and 200
  and (params ->> 'idempotency_key') ~ '^[A-Za-z0-9._:-]+$'
order by user_id, action, params ->> 'idempotency_key', created_at, id;

insert into platform_table_policy (table_name, app_access)
values ('command_idempotency', 'read_write');
