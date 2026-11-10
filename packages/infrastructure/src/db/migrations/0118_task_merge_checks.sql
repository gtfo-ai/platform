-- migration-class: additive
-- 0118 — "Ready to merge" tells the truth about the provider (S-28.13, M28 ruling R3b (3)).
--
-- AUT-6655 waited at `ready_for_merge` while GitLab answered `detailed_merge_status:
-- discussions_not_resolved`: five of the platform's own threads were open, and the task page said
-- nothing. At Ready the `ready_merge_check` duty (`pipeline/ready-merge-check.ts`) now reads the
-- merge request's mergeability and records it here, one row per task:
--   claimed_at          when the recovery pass last enqueued a check for the task (or the first
--                       record's instant) — the bound on how often a waiting task is re-read;
--   checked_at          when the duty last read the provider (`null`: claimed, not read yet);
--   mergeable           true: the provider would merge it now; false: it would not (`reason`);
--                       null: the provider has not decided yet, or nothing was read;
--   reason              the port's word for why not (`checking` … `other`), else null;
--   provider_status     the provider's own word (GitLab's `detailed_merge_status`), a plain word;
--   unresolved_threads  the merge request's unresolved resolvable threads, for `unresolved_threads`.
-- The task read serves a `false` row of a task at Ready as the `merge_request_blocked` subject of
-- `provider_sync`, beside S-28.10's rows. The recovery pass's `ready_merge_check` row checks a task
-- at Ready with no row once — which reaches the tasks already waiting when this ships — and a row
-- that is not `true` again ten minutes after its claim, so a block clears itself.
--
-- A table of its own rather than a third `task_provider_sync` subject: that table's subject check
-- names two values, and widening a check on an existing table is not additive (TD-032 §1).
-- Additive by TD-032's list: a new table the previous build never names, registered below.
create table task_merge_checks (
  task_id uuid primary key references tasks (id) on delete cascade,
  claimed_at timestamptz not null,
  checked_at timestamptz,
  mergeable boolean,
  reason text,
  provider_status text,
  unresolved_threads integer,
  constraint task_merge_checks_reason_known check (
    reason in (
      'checking', 'unresolved_threads', 'conflict', 'pipeline', 'approvals', 'draft', 'rebase',
      'other'
    )
  ),
  constraint task_merge_checks_provider_status_shape check (provider_status ~ '^[a-z0-9_]{1,64}$'),
  constraint task_merge_checks_unresolved_threads_nonnegative check (unresolved_threads >= 0)
);

-- `read_write`: the duty upserts the row, the recovery pass claims it.
insert into platform_table_policy (table_name, app_access)
values ('task_merge_checks', 'read_write');

comment on table task_merge_checks is
  'Whether the provider would merge a task''s merge request now (S-28.13, M28 ruling R3b (3)): one row per task, written by the ready_merge_check duty at ready_for_merge and claimed by the recovery pass; a false row of a task at Ready is served as provider_sync''s merge_request_blocked.';
