-- 0018 — the librarian stage's artifact type and the KB health report (WP-18b).
--
-- Two changes, and both exist because something that was named in the design had nowhere to be
-- written.
--
-- 1. **`artifact_type` gains `LibrarianProposals`.** technical/12's `pipeline.yml` example carries
--    a `librarian` stage with no `produces`, and the stage executor stores an artifact only when
--    the template names a type — so a Librarian run's structured output was validated against a
--    schema and then dropped. The type is added to `@platform/contracts` and to technical/12 in the
--    same change; this is the storage half. `ALTER TYPE ... ADD VALUE` runs inside the migrator's
--    transaction (PostgreSQL has allowed that since 12) and nothing below uses the new label, which
--    is the one thing that would not be allowed until the transaction commits.
--
-- 2. **`kb_health_reports`.** technical/07 § "Librarian pipeline" step 6 names this table by name
--    ("health report stored in `readiness_evaluations`-like table `kb_health_reports`") and no
--    migration had created it, so the nightly hygiene pass had nowhere to put what it found. The
--    shape follows `readiness_evaluations` (0008) deliberately: an id, the project, a jsonb array of
--    findings, the source that produced it, and the instant — a report is an observation, never a
--    state machine.
--
-- What is **not** here, stated so the next reader does not go looking: no column on `kb_proposals`.
-- The apply policy's decision is already legible from the two columns that exist — `significance`
-- and `status` — together with the project's thresholds, so a `decision_reason` would be a third
-- spelling of a value nothing would read (the API's `KnowledgeProposalRecord` is strict and has no
-- field for it). A human's decision is `decided_by`/`decided_at`, which 0008 already created, and
-- the commit a proposal landed in is `applied_commit_sha`.

-- `before 'ShadowReport'` rather than a bare append: `test/integration/db/enums.integration.test.ts`
-- compares the database's labels with the zod enum **in order**, and the artifact belongs beside the
-- retrospective it curates rather than at the end of the list.
alter type artifact_type add value 'LibrarianProposals' before 'ShadowReport';

create table kb_health_reports (
  id uuid primary key default uuidv7(),
  project_id uuid not null references projects (id) on delete cascade,
  -- The vault commit the pass read, or null when it could not read one (the index was never built,
  -- or the mirror is unavailable). Null is "no commit", never "the empty commit".
  commit_sha text,
  -- How many indexed documents the pass looked at, so a report of zero findings over zero documents
  -- is distinguishable from a clean vault (standing rule 18's shape at a read).
  documents integer not null default 0,
  -- `[{kind, path, detail}]` — the same vocabulary as the Librarian artifact's `health`, because a
  -- finding a model noticed and a finding the nightly pass computed are the same kind of thing to
  -- whoever reads them.
  findings jsonb not null default '[]'::jsonb,
  -- `hygiene` (the nightly pass) or `librarian` (a run's own report).
  source text not null,
  created_at timestamptz not null default now(),
  constraint kb_health_reports_documents_nonnegative check (documents >= 0)
);

create index kb_health_reports_project_idx on kb_health_reports (project_id, created_at desc);
