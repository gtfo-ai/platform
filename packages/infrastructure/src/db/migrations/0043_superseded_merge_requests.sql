-- 0043 — the merge requests a rework let go of, until they are closed (WP-59 review round 1,
-- PROGRESS backlog 178).
--
-- `reworkStageCommand` clears `tasks.mr_ref` in its transaction — it must, or the provider's
-- `mr.closed` for the rejected merge request would escalate the task it was closed *for* — and
-- enqueues the `close_superseded_mr` duty after the commit. That enqueue is at-most-once (TD-004):
-- a process that dies between the two left the merge request open and **nothing** named it any more,
-- because the same commit cleared the only row that did. This table is that name, written in the
-- rework's own transaction, and it is what the lost-wake-up recovery pass reads
-- (`packages/application/src/recovery/superseded-mr.ts`, a row of `recovery/stranded.ts`'s table).
--
-- **One row per (task, merge request).** A task that re-adopted an iid and is reworked away from it
-- again rewrites its row (`on conflict … do update`), so the row always describes the latest
-- supersession of that merge request.
--
-- **`settled_at` is the duty's mark, and `outcome` says which ending it reached**: closed, found
-- merged (a close is refused), re-adopted by its task (left open on purpose), the project had no git
-- binding any more, a shadow task (nothing sent), or `abandoned` — the recovery's own ending after
-- one re-enqueue did not take, with the reason in `detail`. `recovery_attempted_at` is the recovery's
-- own column, the shape migrations 0032 and 0036 gave the other sites.
--
-- `cause_event_id` is the rework's `task.stage.returned` — the wake-up's cause, which a re-enqueue
-- must carry. No foreign key: `events` is partitioned and referenced by no table.
create table superseded_merge_requests (
  task_id uuid not null references tasks (id) on delete cascade,
  iid integer not null,
  project_id uuid not null references projects (id) on delete cascade,
  -- The `MergeRequestRef` the task held when it let go of it (`tasks.mr_ref`'s shape).
  mr_ref jsonb not null,
  -- The branch the task moved to, named in the closing comment; null when it has none.
  new_branch text,
  cause_event_id uuid not null,
  superseded_at timestamptz not null,
  settled_at timestamptz,
  outcome text,
  detail text,
  recovery_attempted_at timestamptz,
  primary key (task_id, iid),
  constraint superseded_merge_requests_iid_positive check (iid > 0),
  constraint superseded_merge_requests_outcome_known check (
    outcome is null
    or outcome in ('closed', 'merged', 'readopted', 'unbound', 'shadow', 'abandoned')
  ),
  -- An outcome is a claim about an ending that happened, and an ending has one.
  constraint superseded_merge_requests_settled_has_outcome check (
    (settled_at is null) = (outcome is null)
  )
);

-- The recovery pass's read: the rows no duty has settled, oldest first.
create index superseded_merge_requests_unsettled_idx
  on superseded_merge_requests (superseded_at)
  where settled_at is null;

insert into platform_table_policy (table_name, app_access)
values ('superseded_merge_requests', 'read_write');
