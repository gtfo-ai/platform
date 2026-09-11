-- 0013 — what the first `IntegrationAuditLog` adapter needs on top of 0007 (WP-15b).
--
-- BD-003's outbound-audit claim rests on `IntegrationActionEntry` (WP-07), and 0007 created
-- `integration_actions` before anything implemented the port. Three of the entry's fields had no
-- column, so the adapter could not be written without this file (technical/03 carries the reasoning
-- for each).

-- An action is scoped to a project even when it has no task — a binding health check, an inbound
-- normalisation — and `task_id` is nullable exactly for those. It cannot be reconstructed through
-- `integrations`: one integration serves many projects.
--
-- **No foreign key, and `task_id`'s is dropped below.** An audit row is written in a transaction of
-- its own (the row and its event, atomically, per BD-003) while the *caller* is very often still
-- inside one of its own: technical/06 says "actions are triggered by event handlers", and the intake
-- saga reads the repository's default branch in the same transaction that inserts the task. A
-- referential constraint therefore refuses the audit row **because the caller has not committed**,
-- which makes the audit the thing that fails the action — the exact inversion BD-003 forbids.
-- Measured, not theorised: with the constraint in place the WP-15b e2e died on every run at
-- `insert or update on table "integration_actions_2026_09" violates foreign key constraint
-- "integration_actions_task_id_fkey"`, on the very first event.
--
-- The cost is stated rather than hidden: `task_id` may name a task that no longer exists, or — if
-- the caller's transaction later rolls back — one that never did. That is the honest record either
-- way, because the provider call itself happened outside any transaction and really was made. It is
-- also what lets a project or task be deleted at all: `references tasks (id)` with no action is
-- RESTRICT, so an append-only table nobody may delete from would have blocked the delete for ever.
-- `integration_id` keeps its foreign key: a binding is always committed before a call is made
-- through it, so that one can never refer to invisible state.
alter table integration_actions add column project_id uuid;

alter table integration_actions drop constraint integration_actions_task_id_fkey;

-- TD-012's only visible signal. A redactor that silently stops working writes rows that look exactly
-- like clean ones, so the count is what makes "this payload should have hidden something and did not"
-- an observable discrepancy rather than an invisible one.
alter table integration_actions add column redaction_count integer not null default 0;

-- How many provider attempts the action took, including the successful one (0 for `would_have` and
-- `replayed`, which never reached the provider). The executor's retry loop is the only place that
-- knows, and "worked" versus "worked on the fourth try" are different facts about health.
alter table integration_actions add column attempts integer not null default 0;

-- The default exists only to fill the (empty) existing rows: PostgreSQL needs one to add a NOT NULL
-- column. It is dropped immediately, so from here an INSERT that forgets either column is refused by
-- the database instead of recorded as a zero — "nothing was redacted" and "nobody wrote the column"
-- must not be spelled the same way (standing rule 18, and the whole point of `redaction_count`).
alter table integration_actions alter column redaction_count drop default;
alter table integration_actions alter column attempts drop default;

alter table integration_actions
  add constraint integration_actions_counts_non_negative
  check (redaction_count >= 0 and attempts >= 0);

create index integration_actions_project_idx
  on integration_actions (project_id, created_at desc);

-- The `IdempotencyStore` port (WP-07), which technical/03 had no table for either.
--
-- `storage_key` is `idempotencyStorageKey(scope)` — the single composition of
-- `(integration_id, action, key)` the port exports so that no adapter invents its own, and its parts
-- are stored beside it so the table is readable without decoding the key.
--
-- `result jsonb not null` on purpose: a stored JSON `null` is a legitimate remembered result, and the
-- miss the port promises is `undefined` (no row), so SQL NULL must not be a third state here. The
-- value arrives **redacted** — the executor redacts it before any adapter sees it, because an
-- `encode` is frequently the identity over provider text — while the *key* arrives proved free of an
-- injected secret rather than redacted, since redaction is many-to-one and a key is an identity.
create table integration_idempotency (
  storage_key text primary key,
  integration_id uuid not null references integrations (id) on delete cascade,
  action text not null,
  result jsonb not null,
  created_at timestamptz not null default now()
);

create index integration_idempotency_integration_idx
  on integration_idempotency (integration_id, created_at desc);

-- read_write rather than append_only: nothing expires a key today, and whatever eventually does will
-- delete rows. Registered rather than left to the default so "the registry lists every table" stays a
-- true invariant (migration 0011's note).
insert into platform_table_policy (table_name, app_access, partition_column)
values ('integration_idempotency', 'read_write', null);
