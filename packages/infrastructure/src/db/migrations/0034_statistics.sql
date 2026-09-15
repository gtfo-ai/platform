-- 0034 — the statistics deep-dive's two projections (WP-41, product/16, product/19 §10).
--
-- `GET /api/org/stats` answers thirty-three metrics — twenty-four computed and nine named absent
-- with an owner — and **two** of the facts behind them need storage. Everything else
-- is already a row somewhere with its own timestamp — `tasks`, `task_stages`, `questions`,
-- `cost_rollup_daily`, `cost_entries`, `human_time_entries`, `kb_proposals` — and a rollup that
-- copied those would be a second number to keep in step with the first (standing rule 41). The rule
-- this migration is written to is therefore narrow: *a fact that exists only in the event log gets a
-- projection; a fact that is already a row is read where it lives.*
--
-- Two facts qualify.
--
-- ## `stats_task_delivery` — when a task's merge request merged
--
-- product/19 §10 defines *"Tasks delivered = count(tasks with `mr.merged` and mode=normal) per
-- period (**merge time**)"*, and no table records the merge time. `tasks.completed_at` is the end of
-- the **retrospective**, one stage later, and a task that merged and is still in retro has none at
-- all — so bucketing deliveries by it would move every delivery forward by the retro's duration and
-- drop the ones still in flight. One row per delivered task, keyed by the task, written by the
-- projector on `mr.merged`.
--
-- It is what makes the per-task metrics answerable at read time: cycle time, first-pass acceptance,
-- cost per delivered task and estimate accuracy are all *joins from this row* to tables that already
-- exist, rather than four more counters that could disagree with them.
--
-- `on conflict do nothing`: the **first** merge is the delivery. A merge request that is reopened
-- and merged again is one delivered task, and taking the later instant would move a task between
-- buckets after a reader had already seen it in the earlier one.
--
-- ## `stats_event_daily` — the counters whose only record is an event
--
-- `task.rebase.checked`, `task.conflict.warned`, `task.review.observed` and `task.lint.posted`
-- (WP-24, WP-25, WP-26) each carry a metric product/16 and product/18:59-63 ask for, and each was
-- declared `unconsumed` with WP-41's number on it. They write no row of their own anywhere, so
-- without this table the numbers can only be had by scanning the log per request.
--
-- One row per `(project, civil day, metric)` with a **count** and a **total**: the count is how many
-- events contributed, the total is the quantity they summed (overlapping paths, threads, questions
-- in a lint comment). Both are needed and neither implies the other — six review observations
-- carrying eighteen accepted threads is a different fact from eighteen observations carrying
-- eighteen — and a metric that has no quantity simply leaves `total` at zero, which is a measured
-- zero rather than an absent one because the row exists at all.
--
-- The metric vocabulary is the **writer's**, fixed in
-- `packages/application/src/stats/metrics.ts` and held to this table by its own test. It is `text`
-- here rather than an enum for TD-011's reason: a new counter would otherwise be an `alter type` in
-- a migration, and the value is chosen by the platform rather than by a provider, so nothing
-- untrusted reaches the column.
--
-- ## Why the day is a civil date and which calendar cuts it
--
-- `rollupDay(at, timezone)` — the organisation's zone, exactly the calendar `cost_rollup_daily` and
-- the budget windows already use (Q12, BD-010). One calendar for all three, deliberately: a
-- dashboard showing today's deliveries beside today's spend beside a budget that resets at midnight
-- must agree on when the day turned (standing rule 9).
--
-- **The residual, stated where it is made:** the zone is read at fold time, so an organisation that
-- changes its timezone leaves the days it has already folded cut by the old calendar. The
-- alternative — storing the instant and bucketing at read time — costs the counter its idempotency
-- under redelivery, which is what makes the projection replayable at all (`events/replay.ts`). The
-- same trade is already made by `cost_rollup_daily`.
--
-- Forward-only (TD-011). Nothing backfills here: the history is in `events`, and
-- `events/replay.ts` is how a range of it reaches these tables — which is the point of writing them
-- from a handler rather than from a query.

create table stats_task_delivery (
  task_id uuid primary key references tasks (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  -- The `mr.merged` envelope's `occurred_at`, which is the platform's own clock at append rather
  -- than the provider's rendering of a merge time. It is the instant every delivery metric buckets
  -- by, so it is stored as an instant and cut into days at read time by the same `rollupDay`.
  merged_at timestamptz not null,
  created_at timestamptz not null default now()
);

comment on table stats_task_delivery is
  'One row per task whose merge request merged, at merge time (WP-41). A projection over `mr.merged`; rebuildable through events/replay.ts.';

create index stats_task_delivery_project_idx on stats_task_delivery (project_id, merged_at desc);

create table stats_event_daily (
  project_id uuid not null references projects (id) on delete cascade,
  day date not null,
  metric text not null,
  count bigint not null default 0,
  total numeric(18, 6) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (project_id, day, metric),
  -- Both are sums of non-negative quantities; a negative one would be a fold that ran backwards,
  -- and the constraint is free while the table is empty (migration 0025 made the same call).
  constraint stats_event_daily_count_nonnegative check (count >= 0),
  constraint stats_event_daily_total_nonnegative check (total >= 0)
);

comment on table stats_event_daily is
  'Daily counters folded from the metric events nothing else reads (WP-41): rebase settlements, conflict warnings, review-only observations and ticket-lint comments. A projection; rebuildable through events/replay.ts.';

-- `read_write` for both, registered rather than defaulted — the reason migration 0014 gave for
-- `inbox`, 0024 for `task_asks` and 0025 for `human_time_entries`: *"the registry lists every
-- table"* is only useful as an invariant if it is true.
--
-- Not `append_only`, and for `stats_event_daily` that is the whole shape: the counter is an upsert
-- that adds to a row, which is an UPDATE. `stats_task_delivery` is only ever inserted into, and it
-- is still `read_write` rather than `append_only` because a projection that can never be corrected
-- cannot be rebuilt after a defect is found in the fold — the same reading `budget_windows` and
-- `cost_rollup_daily` have.
insert into platform_table_policy (table_name, app_access)
values ('stats_task_delivery', 'read_write'), ('stats_event_daily', 'read_write');
