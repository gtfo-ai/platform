-- 0030 — the history bootstrap (WP-35, product/06 step 3b, product/18:27, product/19 §18).
--
-- > *"During onboarding, mines the last N merged MRs and their review comments plus closed tickets
-- > for conventions, pitfalls and recurring reviewer requests; proposes KB items with provenance
-- > (MR links) … results land in the proposal queue"*
--
-- `listMergedMergeRequests` was built at WP-09 and had no caller until WP-34; `matchTickets` has had
-- one since WP-15c; commit messages had **no read at all** until this work package added
-- `GitProviderPort.listCommits`. What none of them had was somewhere to put what they read, which is
-- what this migration is.
--
-- ## Four enum values, and why they are a separate statement from the tables
--
-- `alter type … add value` may run inside a transaction block (PostgreSQL 12+), which is what this
-- migration runner holds every file in, but the new label may **not be used** in the same
-- transaction. Nothing below uses one: the batch's own status is a `text` column with a check
-- constraint rather than an enum, and the first row naming `'bootstrap'`, `'historian'`,
-- `'HistoryFindings'` or `'history'` is written by a run in a later transaction. Migrations 0018 and
-- 0024 are the precedent.
--
-- Each value is **appended**, because `alter type … add value` without `before`/`after` appends and
-- `test/integration/db/enums.integration.test.ts` compares the database's labels with the zod enums
-- *in order*.
alter type run_mode add value 'bootstrap';
alter type agent_role add value 'historian';
alter type artifact_type add value 'HistoryFindings';
-- The one that is not merely additive bookkeeping. `knowledge_proposal_source` already has
-- `'bootstrap'`, written by exactly one producer — the **Discovery** recorder
-- (`onboarding/record.ts`, whose comment reads *"this one came from onboarding, not from a
-- retrospective"*) — so before this value a reader of the proposal queue could not tell a page the
-- Discovery agent *drafted* from a convention the bootstrap *mined*. They are different kinds of
-- evidence: a drafted page is a model's reading of a repository it has just met, and a mined page
-- cites the merge requests the claim was observed in, which a maintainer can follow.
alter type knowledge_proposal_source add value 'history';

-- ## The batch
--
-- One row per `POST /api/projects/:id/history-bootstraps`: what the operator asked for, what they
-- were shown before it started, and where it got to.
--
-- `cap_usd` and `estimated_usd` are **copied at creation** for `shadow_batches.budget_usd`'s reason:
-- the figure a reader is shown beside a batch's actual spend has to be the one that applied to it,
-- and a later settings edit must not rewrite what this batch was allowed to spend. `merge_requests`,
-- `batch_size` and `days` are copied for the same reason — the estimate is derived from them, so a
-- reader can re-derive the number they were shown.
--
-- `status` is `text` with a check rather than an enum: the four values are this feature's own
-- vocabulary, nothing else joins on them, and an enum would be a fifth `alter type` the next time
-- the collection learns a new way to find nothing.
create table history_bootstrap_batches (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  requested_by uuid references users (id) on delete set null,
  -- product/19 §18's N, as asked for. The number actually collected is the chunks' sum.
  merge_requests integer not null,
  -- product/19 §18's *"batches of ~20 MRs per Sonnet 5 run"*, as it stood for this batch.
  batch_size integer not null,
  -- The window both halves of the sample were read over — product/19's *"last 6 months"*.
  days integer not null,
  cap_usd numeric(12, 6) not null,
  estimated_usd numeric(12, 6) not null,
  status text not null default 'collecting',
  -- Platform text: why a batch is `empty`, or what the collection had to leave out. Never a
  -- provider's words — the three things that can go wrong here are the platform's own facts.
  detail text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  constraint history_bootstrap_batches_status_known
    check (status in ('collecting', 'mining', 'completed', 'empty')),
  constraint history_bootstrap_batches_merge_requests_positive check (merge_requests > 0),
  constraint history_bootstrap_batches_batch_size_positive check (batch_size > 0),
  constraint history_bootstrap_batches_days_positive check (days > 0),
  constraint history_bootstrap_batches_cap_positive check (cap_usd > 0),
  -- "Finished" is one fact with two columns: a batch that says `completed` or `empty` has an
  -- instant, and one that does not have neither. The shape `task_asks_answered_triple` uses.
  constraint history_bootstrap_batches_completed_pair
    check ((status in ('completed', 'empty')) = (completed_at is not null))
);

create index history_bootstrap_batches_project_idx
  on history_bootstrap_batches (project_id, created_at desc);

-- **One live batch per project, enforced rather than checked.** The command reads first and answers
-- `already_running`, and this index is what decides when two requests race — the same division of
-- labour `tasks (project_id, ticket_key, mode)` makes for the discovery command. It matters more
-- here than there: a second batch would re-read the same history, create a second set of tasks and
-- spend a second cap for an answer the first one is already producing.
create unique index history_bootstrap_batches_one_live
  on history_bootstrap_batches (project_id)
  where completed_at is null;

-- ## The chunks
--
-- One row per mining **run**: product/19 §18's *"batches of ~20 MRs per Sonnet 5 run"*, which is a
-- task of its own (`HISTORY_BOOTSTRAP_TEMPLATE`) because a template's stage list is fixed data and
-- the number of runs a collection needs is not.
--
-- `task_id` is `not null`: a chunk exists because a task was created for it, in the same
-- transaction, and a chunk with no task would be a run nobody can find. The counts are the
-- **platform's** — what the collection actually put in the sample — and they are here rather than
-- derived from `tasks.history_sample` so that the batch screen can be rendered without reading a
-- megabyte of somebody else's review comments.
--
-- `proposals` and `refused_proposals` are written once by the recorder when the run's artifact
-- lands, and `recorded_at` is what makes the pair unambiguous: zero proposals from a run that has
-- reported is a finding (the batch showed nothing repeatable), and zero from a run that has not is
-- silence.
create table history_bootstrap_chunks (
  id uuid primary key default uuidv7(),
  batch_id uuid not null references history_bootstrap_batches (id) on delete cascade,
  chunk_index integer not null,
  task_id uuid not null references tasks (id) on delete cascade,
  merge_requests integer not null,
  tickets integer not null,
  commits integer not null,
  -- TD-012's only signal that a redactor stopped working, counted over the text as it was **read**
  -- rather than as it is stored — the `inbox` and `ticket_snapshot` precedent.
  redaction_count integer not null default 0,
  truncated boolean not null default false,
  recorded_at timestamptz,
  proposals integer not null default 0,
  refused_proposals integer not null default 0,
  created_at timestamptz not null default now(),
  constraint history_bootstrap_chunks_index_nonnegative check (chunk_index >= 0),
  constraint history_bootstrap_chunks_counts_nonnegative
    check (merge_requests >= 0 and tickets >= 0 and commits >= 0
           and redaction_count >= 0 and proposals >= 0 and refused_proposals >= 0),
  -- A count of what a run proposed is a claim about a run that reported. Both counters are zero
  -- until `recorded_at` is set, and after it they are whatever the recorder found.
  constraint history_bootstrap_chunks_counts_need_a_report
    check (recorded_at is not null or (proposals = 0 and refused_proposals = 0)),
  constraint history_bootstrap_chunks_one_per_index unique (batch_id, chunk_index)
);

create index history_bootstrap_chunks_task_idx on history_bootstrap_chunks (task_id);

-- ## The sample
--
-- `tasks.history_sample` is the batch of merged history **one** mining run reads, and it is the
-- fifth place this schema stores somebody else's words — after `inbox`, `kb_chunks`,
-- `tasks.ticket_snapshot` and `tasks.review_subject`. It is stored the same way all four are:
-- **bounded and redacted at the write** (TD-012, BD-022), never rendered as markup, and dying with
-- the task row it sits on.
--
-- It is a column on `tasks` rather than a table of its own for `review_subject`'s reason: it is the
-- input to *this* task's one stage, written by the same `insert` that creates the task, so it has
-- exactly one writer and cannot be the read-modify-write standing rule 79 is about
-- (`tasks-column-ownership.test.ts` reads that off disk rather than trusting this sentence).
--
-- No `varchar` and no size constraint: the writer has already cut the text to
-- `HISTORY_SAMPLE_MAX_TEXT_CHARS`, and a column bound here would refuse a row the writer believed
-- it had bounded — turning a short sample into a failed collection. `task_asks` states the same.
alter table tasks add column history_sample jsonb;

-- Registered rather than defaulted, so the "the registry lists every table" invariant of
-- `test/integration/db/migrations.integration.test.ts` stays true. Both are `read_write`: a batch
-- row moves through its three statuses and a chunk row is stamped once by the recorder.
insert into platform_table_policy (table_name, app_access)
values ('history_bootstrap_batches', 'read_write'), ('history_bootstrap_chunks', 'read_write');
