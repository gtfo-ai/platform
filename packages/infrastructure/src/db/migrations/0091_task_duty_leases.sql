-- 0091 — `task_duty_leases`: who performs a group of one task's outbound duties right now (WP-184).
--
-- After a code review returns a task, the next agent stage used to be planned before the review's
-- findings were on the merge request: the `stage.execute` job and the `pipeline.outbound` duty that
-- posts them sit on two queues with nothing ordering them (measured 3.0 s apart on the e2e clock,
-- WP-183), so the Developer's prompt carried no `conversation` block for the threads it must answer
-- (TD-029 decision 11). Since WP-184 the stage job performs the owed duties itself, between its
-- transactions and before the plan, and the outbound duty still fires — two performers of one
-- idempotency key.
--
-- The key alone does not make them take turns: `IntegrationActionExecutor` looks the key up before
-- the call and records it **after** (its steps 2 and 5), so two performers that overlap both call the
-- provider and both post. This table is the guard the WP-184 row asked for when that is so: one row
-- per `(task, lease)` naming the performer that holds it until `expires_at`. A performer claims the
-- row before its first call, renews it while it works and deletes it when it is done; the second
-- performer waits for it and then finds every key recorded, so its turn is a replay that calls
-- nothing.
--
-- **Why a row with an expiry rather than an advisory lock.** A session advisory lock would hold a
-- pooled connection across the provider calls it guards — the shape WP-15d removed from the
-- pipeline, and one more connection per worker in `POOL_RESERVATIONS` — and the `UnitOfWork` port
-- offers none (`ticket-release.ts` measured the same gap at WP-178). A row costs a statement per
-- claim, renewal and release, holds no connection between them, and a holder whose process died is
-- out of the way after one lease length rather than never.
--
-- `lease` names the group (`review_conversation` today: the findings post, the replies, the
-- resolutions and the ticket lifecycle's moves). The instants are the claimant's clock, not `now()`
-- (`postgresDutyLeases`), so one clock answers both halves of the expiry comparison
-- within a process; across hosts the holder's expiry meets the claimant's clock, so host clock skew
-- shifts the expiry by the skew, harmless while it is far below the 2-minute lease. The row goes
-- with its task.
create table task_duty_leases (
  task_id uuid not null references tasks (id) on delete cascade,
  lease text not null,
  holder text not null,
  claimed_at timestamptz not null,
  expires_at timestamptz not null,
  primary key (task_id, lease),
  constraint task_duty_leases_lease_shape check (lease ~ '^[a-z][a-z_]{0,62}$'),
  constraint task_duty_leases_holder_shape check (length(holder) between 1 and 200),
  constraint task_duty_leases_expires_after_claim check (expires_at > claimed_at)
);

-- `read_write`: claimed, renewed in place and deleted by its holder.
insert into platform_table_policy (table_name, app_access)
values ('task_duty_leases', 'read_write');

comment on table task_duty_leases is
  'Who performs a group of one task''s outbound duties right now (WP-184): claimed before the first provider call, renewed while the holder works, deleted when it is done, so two performers of one idempotency key take turns.';
