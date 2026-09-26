-- 0042 — the index keeps what retrieval needs to judge a query term and to validate a `paths:` glob
-- (WP-58; OPEN-QUESTIONS Q58 and PROGRESS backlog 170; technical/03 and technical/07 amended in the
-- same change).
--
-- ## 1. `kb_term_statistics` — Q58's inverse document frequency, counted at index time
--
-- Q58's recommendation, implemented: *derive inverse document frequency from the project's own
-- index at index time, drop a query term whose document frequency exceeds a threshold*. One row per
-- keyword the project's indexed chunks contain, counted by `termStatisticsOf` in
-- `@platform/domain` — the same function the in-memory store calls, so both stores hold the same
-- numbers by construction (standing rule 1). `kb_index_state.term_documents` is the denominator.
--
-- The rows are **not** derived from `kb_chunks.search`: PostgreSQL's `simple` parser keeps a path as
-- one `file` lexeme where the platform's splitter reads its words, and a frequency counted by one
-- rule and compared with a term produced by another would be the frequency of a different word.
--
-- Derived state (BD-012): the index write replaces a project's rows in the transaction that writes
-- its documents, so the table always describes the commit `kb_index_state` names.
create table kb_term_statistics (
  project_id uuid not null references projects (id) on delete cascade,
  -- A keyword as `textKeywords` produces it: lowercased, `[\p{L}\p{N}_]+`, at least four characters.
  term text not null,
  -- How many of the project's indexed documents contain it at least once.
  documents integer not null,
  primary key (project_id, term),
  constraint kb_term_statistics_documents_positive check (documents >= 1)
);

insert into platform_table_policy (table_name, app_access)
values ('kb_term_statistics', 'read_write');

-- How many documents the statistics were counted over. Null until an index write after this
-- migration stores it — and null is read as "no statistics", which searches every term exactly as
-- before, rather than as a count of zero.
alter table kb_index_state add column term_documents integer;
alter table kb_index_state
  add constraint kb_index_state_term_documents_nonnegative
  check (term_documents is null or term_documents >= 0);

-- ## 2. `kb_index_state.path_witnesses` — what validate-on-read needs, and no more (backlogs 170, 175)
--
-- technical/07 step 3 drops a candidate whose `paths:` globs no longer resolve at HEAD, and the
-- planner had no listing to resolve them against, so every `paths:`-scoped page was recorded
-- `validated: false` and never admitted. The vault read already produces the tracked set at the
-- commit it indexes (`VaultSnapshot.repoPaths`, WP-18a).
--
-- **Not the listing — its witnesses.** WP-58's first draft stored the whole listing here (this
-- repository: 1 499 paths, 68 798 bytes, read by every planned run; a 100 000-path monorepo
-- extrapolates to ~4.6 MB per run — backlog 175). What step 3 asks is only *does at least one of
-- this page's globs match a tracked file*, so the write stores, for every `paths:` glob in the
-- vault, the first tracked path it matches (`pathWitnesses` in `@platform/domain`) — which answers
-- that question exactly as the listing would (a property in `globs.test.ts`) and is bounded by the
-- vault's distinct globs, not by the repository: the fixture vault's six globs store four paths.
-- It is still the answer *of the commit the index describes*, so a pack never validates against a
-- tree its documents did not come from.
--
-- Null is "none stored" — an index written before this migration — and never `{}`, which means no
-- glob in the vault resolves.
alter table kb_index_state add column path_witnesses text[];

-- ## 3. Every existing index is re-read once, as 0041 did and for the same reason
--
-- A project indexed before this migration has neither statistics nor witnesses, and the index run
-- skips a commit it has already indexed. Nulling `commit_sha` makes the next run a full rebuild
-- that writes both. `fts_built_at` is left alone so packs keep being built in the window; in the
-- window the floor reports `no_statistics` and the planner reports no listing, both by name.
update kb_index_state set commit_sha = null where commit_sha is not null;
