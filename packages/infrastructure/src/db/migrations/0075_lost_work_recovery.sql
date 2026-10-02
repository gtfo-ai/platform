-- 0075 — two recovery rows for work a failed job dropped (WP-124, TD-004's M7 amendment, PROGRESS
-- backlog 366).
--
-- Since WP-108 a job that spent its retries is listed for an administrator, and for two queues the
-- census said *nothing recovers it*: `knowledge.apply` (a change a human accepted does not land) and
-- `onboarding.discovery` (a paid discovery run's evaluation and drafted pages are lost). Both lost
-- effects have a database trace, so both get a row of `recovery/stranded.ts`'s table: found, re-
-- enqueued once under a mark, and then made visible.
--
-- ## `kb_proposals`: the apply's mark and its ending
--
-- An approved proposal — `auto_applied`, or `queued` with a maintainer's decision — whose apply job
-- failed stays approved and unapplied (measured at WP-124: it reads `queued` with `decided_at` set,
-- the same card as an undecided one, and the nightly hygiene pass re-enqueues an apply for it every
-- night for ever). The recovery pass finds one with no live `knowledge.apply` job, marks it in
-- `apply_recovery_attempted_at` and enqueues one apply for its project; an hour later, if it is still
-- unapplied with no live job, it is moved to the new status **`apply_failed`** with a platform
-- sentence in `apply_failure_reason`. `apply_failed` is not awaiting apply (`isAwaitingApply`), so
-- neither the apply pass nor the hygiene sweep touches it again; a maintainer's re-approval moves
-- it back to `queued`, clears both columns and enqueues an apply.
--
-- A seventh status rather than a pair of columns on `queued`, against `decide.ts`'s argument for
-- the six: that argument was about a fact two existing columns already carried, and "the platform
-- tried to commit this and gave up" is carried by none of them — on `queued` it would be one more
-- column every reader of "approved" would have to remember to exclude.
--
-- `alter type … add value` runs inside the migration's transaction (PostgreSQL 12+); the new value
-- is not used in this transaction, which is the one thing that form forbids.
alter type knowledge_proposal_status add value 'apply_failed' after 'applied';

alter table kb_proposals
  add column apply_recovery_attempted_at timestamptz,
  add column apply_failure_reason text;

-- A reason is a claim about a proposal that failed to apply, and only such a proposal carries one.
-- Written as text rather than the enum so the new value is not used in its own transaction.
alter table kb_proposals
  add constraint kb_proposals_apply_failure_reason_pair
  check ((status::text = 'apply_failed') = (apply_failure_reason is not null));

-- ## `discovery_record_recoveries`: the discovery recorder's mark and its ending
--
-- One row per `DiscoveryDraft` artifact the recovery pass re-enqueued `onboarding.discovery` for:
-- `recovery_attempted_at` is the mark (the row is written with it), and `ended_at`/`detail` is the
-- ending — the discovery task escalates with a brief, or, since a discovery task is `done` by the
-- time its record runs and `done` has no edge to `needs_human`, its people are told and the reason
-- is published on the project's re-evaluation read (OPEN-QUESTIONS Q113). Keyed on the **artifact**,
-- like `knowledge_curations`, because the artifact is what the record job is *of*. No `project_id`
-- and no `task_id`: both are one join away (`artifacts.task_id`, `tasks.project_id`).
create table discovery_record_recoveries (
  artifact_id uuid primary key references artifacts (id) on delete cascade,
  recovery_attempted_at timestamptz not null,
  ended_at timestamptz,
  detail text,
  created_at timestamptz not null default now(),
  -- "Given up on" is one fact with two columns (`knowledge_curations_abandon_pair`'s shape).
  constraint discovery_record_recoveries_end_pair check ((ended_at is null) = (detail is null))
);

-- The recovery's query drives off `artifacts`, filtered to the one type this queue records and to
-- rows older than the grace — `artifacts_curated_types_idx`'s shape, for this type.
create index artifacts_discovery_draft_idx on artifacts (created_at)
  where type = 'DiscoveryDraft';

-- `read_write`: a row is written with its mark and updated at most once, by its ending. Registered
-- rather than defaulted, so the registry lists every table.
insert into platform_table_policy (table_name, app_access)
values ('discovery_record_recoveries', 'read_write');

comment on table discovery_record_recoveries is
  'The discovery recorder''s recovery mark and ending (WP-124, backlog 366): one row per DiscoveryDraft artifact the recovery pass re-enqueued onboarding.discovery for.';
