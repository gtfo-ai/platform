-- 0029 — a shadow batch, and what each ticket of it was compared against (WP-34).
--
-- `shadow_reports` has existed since 0008 and has never held a row, because nothing ever set
-- `tasks.mode = 'shadow'`. The guard that refuses a shadow task's writes shipped at WP-07; the
-- producer is this work package. What 0008 does not carry is the **batch**: product/19 §13's second
-- sentence — *"Aggregate report per shadow batch: predicted cost per ticket by size, similarity
-- distribution, list of 'high similarity + low cost' tickets as the launch candidates"* — is a
-- statement about a set of tickets somebody selected on one day, and a set has to be recorded
-- somewhere before it can be aggregated.
--
-- ## Two tables, and why the second is keyed by ticket rather than by task
--
-- `shadow_batches` is the selection: one row per `POST /api/projects/:id/shadow-batches`, carrying
-- who asked, when, and the per-feature cap in force at the time (`features.shadow_mode.budget_usd`,
-- copied so that a later settings edit does not rewrite what this batch was allowed to spend — the
-- number a reader is shown beside the batch's actual cost has to be the one that applied).
--
-- `shadow_batch_tickets` is one row per ticket the caller named, and **a ticket in a batch may have
-- no task**. Q82 (a) is implemented as its recommendation: a shadow run is checked out at the
-- merge-base of the human merge request, *"and refuse the ticket from the batch by name when that
-- base cannot be resolved rather than silently running against today's default branch"* — a
-- Jaccard overlap between a diff written against today's tree and a human diff written against the
-- tree six months ago measures drift, not similarity. So a refused ticket is recorded with the
-- reason and **no** task, which is why the primary key is `(batch_id, ticket_key)` and `task_id` is
-- nullable. The check constraint makes the two states exclusive: a row is either a task or a
-- refusal, never both and never neither.
--
-- What each column of `shadow_batch_tickets` answers, and all four are Q82's:
--
--   * `task_id`        the shadow task, or null when the ticket was refused;
--   * `base_sha`       the commit the comparison is anchored at — the human merge request's
--                      `diff_refs.base_sha`, read from the **single** merge-request endpoint
--                      because GitLab does not publish `diff_refs` on the list one (measured
--                      against docs.gitlab.com/api/merge_requests on 2026-09-14);
--   * `human_mr_ref`   the merge request the agent's work is compared with, or null when the
--                      ticket has none — in which case the report carries **no overlap block at
--                      all** rather than an overlap of zero, which would read as *"the agent built
--                      something completely different"*;
--   * `human_mr_source` which of Q82 (b)'s two lookups produced it, `ticket_link` or `title_scan`,
--                      so a reader can judge the comparison rather than trust it.
--
-- Two more columns carry what the match already knew and the report needs later (WP-34 review
-- round 2). Both are written once, at batch time, because the match is made once:
--
--   * `human_mr_merged_at`  when the human merge request was merged. product/19 §16's review
--                           window runs *"to merge or last activity"*, and without this column the
--                           report duty had nothing to pass for *"to merge"* — every reviewer-minute
--                           figure under-counted a merge that followed the last comment, and the
--                           alternative is a fourth provider read per report;
--   * `human_mr_candidates` how many merged merge requests matched the ticket. The most recently
--                           merged wins, which understates the human's size when a ticket was
--                           delivered across several merge requests; the report's `notes` says so,
--                           and it cannot say it from a count nobody stored.
--
-- `refused_reason` is platform text, never a provider's: the three refusals this build can make are
-- named in `packages/application/src/shadow/batch.ts`.
--
-- Forward-only (TD-011). Nothing backfills: no shadow task has ever existed, so there is no history
-- for these tables to describe.

create table shadow_batches (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  requested_by uuid references users (id) on delete set null,
  -- `features.shadow_mode.budget_usd` as it stood when the batch was created; null when unset.
  budget_usd numeric(12, 6),
  created_at timestamptz not null default now(),
  -- Set by the `shadow.report.created` consumer once every task of the batch has a report.
  completed_at timestamptz,
  constraint shadow_batches_budget_positive check (budget_usd is null or budget_usd > 0)
);

create index shadow_batches_project_idx on shadow_batches (project_id, created_at desc);

create table shadow_batch_tickets (
  batch_id uuid not null references shadow_batches (id) on delete cascade,
  ticket_key text not null,
  task_id uuid references tasks (id) on delete cascade,
  base_sha text,
  human_mr_ref jsonb,
  human_mr_source text,
  human_mr_merged_at timestamptz,
  human_mr_candidates integer,
  refused_reason text,
  constraint shadow_batch_tickets_candidates_positive
    check (human_mr_candidates is null or human_mr_candidates > 0),
  created_at timestamptz not null default now(),
  primary key (batch_id, ticket_key),
  constraint shadow_batch_tickets_task_or_refusal
    check ((task_id is null) <> (refused_reason is null))
);

create index shadow_batch_tickets_task_idx on shadow_batch_tickets (task_id);
