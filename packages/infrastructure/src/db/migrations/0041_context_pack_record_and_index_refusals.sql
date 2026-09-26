-- 0041 — the context pack gets a record it can hold, and the index keeps what the parser refused
-- (WP-57; PROGRESS backlog 31 and backlog 37's second half; technical/03 and technical/07 amended
-- in the same change).
--
-- ## 1. `run_context_pack` — option (a): keep the table
--
-- technical/03 has listed `run_context_pack` since 0004 as the per-run record of what an agent was
-- shown, and nothing ever inserted a row. It could not have held the record if something had:
-- `ContextPackRecord` (`packages/contracts/src/records.ts`) has a `budget_tokens`, a `total_tokens`
-- and a `kb_commit` that describe the **pack**, not any one document, and no column held them; and
-- the published tier-1 entry requires `reason` and `score`, which are nullable here.
--
-- **The header goes on the run row.** It is one value per run, written by the statement that
-- creates the run (`RunRepository.insert`), so "the run exists and its pack was not recorded" and
-- "the run's pack was recorded and was empty" are two states of one row rather than a join that
-- has to guess:
--
--   context_budget_tokens is null      — no pack was recorded for this run (every row before 0041)
--   context_budget_tokens is not null,
--     zero `run_context_pack` rows     — the pack was recorded and was empty
--   context_budget_tokens is not null,
--     n rows                           — the pack, one row per document
--
-- `context_total_tokens` is stored rather than summed from the rows: the assembler's total counts
-- tier 0 and the *admitted* tier-1 documents and not a tier-1 entry recorded `validated: false`, and
-- a reader that re-derived it would be a second spelling of that rule (standing rule 41).
-- The pair is nullable with no default and held together by a check; neither is backfilled,
-- because a pre-0041 run's pack is not zero, it is unknown (standing rule 18).
alter table runs add column context_budget_tokens integer;
alter table runs add column context_total_tokens integer;
-- `ContextPackRecord.kb_commit`, which is nullish in the record: a null here on a row with a
-- budget is "the pack names no commit", which is what every pack this build assembles says.
alter table runs add column context_kb_commit text;

alter table runs
  add constraint runs_context_pack_header_paired
  check ((context_budget_tokens is null) = (context_total_tokens is null));
alter table runs
  add constraint runs_context_pack_header_nonnegative
  check (context_budget_tokens is null or (context_budget_tokens >= 0 and context_total_tokens >= 0));
alter table runs
  add constraint runs_context_kb_commit_needs_a_pack
  check (context_kb_commit is null or context_budget_tokens is not null);

-- **`reason` and `score` are filled at the write, not relaxed in `@platform/contracts`.** Every
-- tier-1 entry the assembler produces carries both, so the published record keeps requiring them.
-- A tier-0 row carries neither: the tier-0 entry has no such fields, and its audit label (`index`,
-- `rules`, `root_instructions`, `code_map`) is not a value of `context_pack_reason`.
--
-- **`ordinal`** is the entry's position within its tier. The record is an ordered list — tier 1 by
-- score, ties by path under JavaScript's `localeCompare` — and neither the primary key nor any
-- database collation reproduces that order, so a reader that sorted would publish a different
-- record from the one `run.started` carries.
alter table run_context_pack add column ordinal integer;

-- `real` rounds the assembler's score to ~7 significant digits, so the record the endpoint serves
-- would differ from the one `run.started` carries. The table has never held a row, so the rewrite
-- costs nothing.
alter table run_context_pack alter column score type double precision;

-- `NOT VALID`, as 0038 did for `artifacts.redaction_count`: PostgreSQL exempts rows that already
-- exist and enforces the check on every later insert and update. No writer existed before this
-- migration, but a row inserted by hand would otherwise make it fail to apply; the reader refuses
-- such a row by name, because it belongs to a run with no recorded header.
alter table run_context_pack
  add constraint run_context_pack_row_complete
  check (
    ordinal is not null and ordinal >= 0
    and (tier <> 1 or (reason is not null and score is not null))
  ) not valid;

-- ## 2. `kb_index_refusals` — what the parser refused, kept where the nightly pass can read it
--
-- technical/07:8 says validation on index *"feeds the KB health report"*. A document whose
-- frontmatter the parser refuses is never indexed, so it was in no table at all: `IndexReport.invalid`
-- lived for the length of one job and reached a log line. Such a page is silently absent from every
-- context pack — a project can commit it, see it in git, and never learn that no agent is shown it.
--
-- The index run **replaces** a project's rows in the same transaction as its documents, so the
-- table always describes the commit `kb_index_state` names. Derived state, like the rest of the
-- index (BD-012): a rebuild re-creates it.
create table kb_index_refusals (
  project_id uuid not null references projects (id) on delete cascade,
  -- The repository path of the refused document.
  path text not null,
  -- The parser's diagnosis. It can quote a frontmatter key a human wrote, so it is untrusted text
  -- (BD-022), and the writer bounds it (technical/03).
  reason text not null,
  -- The frontmatter line the parser stopped at, when it knows one.
  line integer,
  -- The commit the index run read.
  commit_sha text not null,
  recorded_at timestamptz not null default now(),
  primary key (project_id, path),
  constraint kb_index_refusals_reason_bounded check (char_length(reason) between 1 and 1000),
  constraint kb_index_refusals_line_positive check (line is null or line >= 1)
);

-- `read_write`: an index run deletes the project's rows and writes the new set.
insert into platform_table_policy (table_name, app_access)
values ('kb_index_refusals', 'read_write');

-- ## 3. Every existing index is re-read once, so its refusals are not "none" by default
--
-- The index run skips a commit it has already indexed (`kb_index_state.commit_sha` equal to the
-- head, `fts_built_at` set). A project indexed before this migration therefore has **no** refusal
-- rows and would keep none until its default branch moved — so the health report would say "no
-- invalid page" where the truth is "not looked" (standing rule 18).
--
-- Nulling `commit_sha` makes the next index run (the project's next task, merge or default-branch
-- move) a full rebuild, which writes the refusals. `fts_built_at` is **left alone** on purpose:
-- nulling it would turn every context pack into `not_indexed` until that run — an empty pack for a
-- project whose index is fine — and the onboarding readiness read into "never built". The index
-- stays usable; what reads `null` in the window is the commit on `GET …/kb/tree` and on the next
-- health report, which is the honest answer ("the commit this index describes is being re-read").
update kb_index_state set commit_sha = null where commit_sha is not null;
