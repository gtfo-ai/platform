-- 0036 — the two marks the last sites of the lost-wake-up class need (WP-48; PROGRESS backlog 36,
-- 106, and the bound of 105).
--
-- `packages/application/src/recovery/stranded.ts` is one pass over a table of sites: *find the row
-- whose wake-up was lost, enqueue the wake-up again, once, and end the row when that attempt did not
-- take*. Two sites could not be rows of it until this migration, and for **different** reasons.
--
-- ## 1. The curation has no mark, so "it ran and proposed nothing" is spelled like "it never ran"
--
-- Backlog **36**, in the words the entry and `stranded.ts` both use. `recordLibrarianProposals`
-- writes `kb_proposals` rows and nothing else, and a model that had nothing repeatable to say is a
-- legitimate, common outcome — so a sweep keyed on *"a `LibrarianProposals` artifact with no
-- proposal rows"* would re-run the curation of every quiet task, for ever (standing rule 18).
--
-- `knowledge_curations` is that mark, and it is **keyed on the artifact** because the artifact is
-- what a curation is *of*: one row per curated artifact, written by the job in the same transaction
-- as the proposals. That makes it the site's **idempotency key** as well as its mark — the insert
-- claims the artifact, so a second delivery of the same wake-up (the queue is at-least-once, and
-- this pass adds a deliberate second one) writes **no second set of proposals** rather than
-- doubling the queue a maintainer reads.
--
-- **Four columns and no more.** `curated_at` is the mark; `proposals` is what it produced, so zero
-- from a curation that ran is distinguishable on the row itself; `recovery_attempted_at` is the
-- recovery's own column, exactly as migration 0032 added one to `history_bootstrap_batches` and
-- `task_asks`; `abandoned_at`/`detail` is the ending backlog 105 requires — a wake-up that did not
-- take after its one re-enqueue stops being re-enqueued and says so.
--
-- **No `project_id`, no `task_id`.** Both are one join away (`artifacts.task_id`, `tasks.project_id`)
-- and the recovery's query reads them there anyway to build the job payload. A copy here would be
-- two more columns to keep true and nothing would read them.
--
-- A **late** curation is admitted after an abandonment: the claim's predicate is `curated_at is
-- null`, not "and not abandoned". The row then carries both instants, which is the honest record of
-- what happened — the platform gave up at one instant and the work arrived at another — and the
-- alternative (refusing it) would throw away proposals the project paid a run for.
--
-- ## 2. A chunk whose `record` wake-up was lost has no ending, and its batch bricks the project
--
-- Backlog **106**. `record.ts`'s `artifact.created` handler enqueues `{kind: 'record', …}` through
-- `afterCommit`, which is at-most-once (TD-004). Losing it leaves `history_bootstrap_chunks.
-- recorded_at` null for ever; `completeIfDone` is one of only two writers of
-- `history_bootstrap_batches.completed_at`, so the batch never completes, and
-- `history_bootstrap_batches_one_live` then refuses **every later bootstrap of that project** with
-- `already_running` — backlog 101's brick, reached from a different lost wake-up.
--
-- The site needed two things the chunk did not have: the recovery's mark, and an **ending that is
-- not a lie**. `recorded_at` cannot be the ending — `history_bootstrap_chunks_counts_need_a_report`
-- exists precisely so that a stamped row means *"this run reported"*, and stamping one that never
-- did would publish `proposals = 0` as a finding. So the ending is its own column: a chunk the
-- platform gave up on is `abandoned_at` with the reason in `detail`, `completeIfDone` counts it as
-- reported (the adapter's predicate, not a constraint here), and the batch completes with
-- `chunks_recorded < chunks` — which is the signal `record.ts`'s docblock already claims makes this
-- loss visible on the batch screen.
--
-- `history_bootstrap_chunks_one_ending` is what keeps the pair honest: a chunk is recorded or
-- abandoned, never both. `markChunkRecorded` gains `abandoned_at is null` in its predicate, so a
-- late `record` job answers `false` and skips instead of raising this constraint.

alter table history_bootstrap_chunks add column recovery_attempted_at timestamptz;
alter table history_bootstrap_chunks add column abandoned_at timestamptz;
-- Platform text: why the platform stopped waiting for this run's findings. Never a model's words.
alter table history_bootstrap_chunks add column detail text;

alter table history_bootstrap_chunks
  add constraint history_bootstrap_chunks_one_ending
  check (recorded_at is null or abandoned_at is null);
alter table history_bootstrap_chunks
  add constraint history_bootstrap_chunks_abandon_pair
  check ((abandoned_at is null) = (detail is null));

create table knowledge_curations (
  artifact_id uuid primary key references artifacts (id) on delete cascade,
  -- When the curation ran. Null on a row this pass wrote first, which is the recovery's own mark.
  curated_at timestamptz,
  -- What it produced, so that zero is a finding rather than silence (standing rule 18).
  proposals integer not null default 0,
  recovery_attempted_at timestamptz,
  abandoned_at timestamptz,
  detail text,
  created_at timestamptz not null default now(),
  constraint knowledge_curations_proposals_nonnegative check (proposals >= 0),
  -- A count of what a curation proposed is a claim about a curation that ran.
  constraint knowledge_curations_counts_need_a_curation
    check (curated_at is not null or proposals = 0),
  -- "Given up on" is one fact with two columns, the shape `history_bootstrap_batches_completed_pair`
  -- uses: a row that was abandoned says why, and one that was not says nothing.
  constraint knowledge_curations_abandon_pair check ((abandoned_at is null) = (detail is null))
);

-- The recovery's query drives off `artifacts`, filtered to the two types this queue curates and to
-- rows older than the grace. A partial index on that predicate keeps it from scanning every
-- artifact every project has ever produced — the shape `task_asks_pending_idx` uses for exactly the
-- same query one table across.
create index artifacts_curated_types_idx on artifacts (created_at)
  where type in ('LibrarianProposals', 'ResearchReport');

-- Registered rather than defaulted, so the "the registry lists every table" invariant of
-- `test/integration/db/migrations.integration.test.ts` stays true. `read_write`: a row is written
-- once by the curation, or written by the recovery and then updated at most twice (its attempt,
-- then its curation or its ending).
insert into platform_table_policy (table_name, app_access)
values ('knowledge_curations', 'read_write');
