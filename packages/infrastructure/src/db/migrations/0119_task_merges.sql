-- migration-class: additive
-- 0119 — The platform may merge (S-28.15, BD-007's 2026-11-10 amendment, TD-038 decisions 5–6).
--
-- With `policies.merge.by: platform` the `platform_merge` duty (`pipeline/platform-merge.ts`)
-- merges a task's merge request at `ready_for_merge` once every check holds at that moment, pinned
-- to the reviewed head. One decisive call per task and reviewed commit, recorded here:
--   head_sha          the reviewed, CI-gated head the merge was pinned to (`tasks.ready_head_sha`);
--   outcome           merged | refused (the provider's refusal, final for that head) | failed
--                     (three tries could not reach the provider);
--   provider_status   the port's word for a refusal (`head_moved`, `not_allowed`, `not_mergeable`,
--                     `unauthorised`) or the transport's error code, a plain word;
--   merge_commit_sha  the merge commit the provider answered, when merged;
--   plan_decision     the plan decision the merge rested on (TD-038 decision 2: the plan approval is
--                     the human checkpoint): approved_by_person | approved_by_platform |
--                     not_required, with
--   plan_approval_id  the approval row it was read from (null when none was asked);
--   change_digest     a rebase row: the merge request's change digest before the rebase;
--   commit_count      a rebase row: its commit count before the rebase;
--   rebased_to        a rebase row: the head the rebase produced, once settled;
--   signal_passes     recovery passes that found the task still at Ready after a `merged` row — a
--                     lost `mr.merged` is recorded again by the pass, and escalated after three.
-- The task still leaves Ready only through `mr.merged`; this row never moves it.
--
-- And on `task_merge_checks`, two nullable columns the merge check and the duty write:
--   merge_by    who merges this task as last decided (`person` | `platform`); a `platform` row with
--               no attempt for the reviewed head is due again in the recovery pass, so a merge
--               that waited (a person's words, a pipeline) or a lost wake-up is asked again;
--   merge_wait  what the platform last waited for at the moment of merging, for the task page.
--
-- Additive by TD-032's list: a new table the previous build never names, registered below, and two
-- nullable columns, `merge_by` with a `not valid` check over its own values. `merge_wait` carries no
-- check (a shape check is not null-propagating by construction, TD-032 amendment C): its one
-- writer is the platform's, and the task read parses it with the published shape.
create table task_merges (
  task_id uuid not null references tasks (id) on delete cascade,
  head_sha text not null,
  outcome text not null,
  provider_status text,
  merge_commit_sha text,
  plan_decision text not null,
  plan_approval_id uuid references approvals (id) on delete set null,
  change_digest text,
  commit_count integer,
  rebased_to text,
  attempted_at timestamptz not null,
  signal_passes integer not null default 0,
  primary key (task_id, head_sha),
  constraint task_merges_outcome_known check (
    outcome in (
      'merged', 'refused', 'failed', 'rebased', 'rebase_refused', 'rebase_conflict',
      'rebase_changed'
    )
  ),
  constraint task_merges_plan_decision_known check (
    plan_decision in ('approved_by_person', 'approved_by_platform', 'not_required')
  ),
  constraint task_merges_change_digest_shape check (change_digest ~ '^[0-9a-f]{64}$'),
  constraint task_merges_rebased_to_shape check (rebased_to ~ '^[0-9a-f]{7,64}$'),
  constraint task_merges_commit_count_nonnegative check (commit_count >= 0),
  constraint task_merges_head_sha_shape check (head_sha ~ '^[0-9a-f]{7,64}$'),
  constraint task_merges_merge_commit_shape check (merge_commit_sha ~ '^[0-9a-f]{7,64}$'),
  constraint task_merges_provider_status_shape check (provider_status ~ '^[a-z0-9_]{1,64}$'),
  constraint task_merges_signal_passes_nonnegative check (signal_passes >= 0)
);

-- `read_write`: the duty inserts a row once, the recovery pass counts its passes.
insert into platform_table_policy (table_name, app_access)
values ('task_merges', 'read_write');

comment on table task_merges is
  'The platform''s merge attempt per task and reviewed head (S-28.15, TD-038): merged, refused or failed, the provider''s word, the merge commit and the plan decision it rested on; one decisive call per (task, head). The task leaves Ready only through mr.merged.';

alter table task_merge_checks add column merge_by text;
alter table task_merge_checks add column merge_wait text;

alter table task_merge_checks
  add constraint task_merge_checks_merge_by_known check (merge_by in ('person', 'platform')) not valid;

comment on column task_merge_checks.merge_by is
  'Who merges this task as last decided (S-28.15): person or platform; a platform row with no task_merges row for the reviewed head is due again in the recovery pass.';
comment on column task_merge_checks.merge_wait is
  'What the platform last waited for at the moment of merging (S-28.15, TD-038 decision 3), for the task page; null when nothing.';
