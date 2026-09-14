-- 0024 — ask-the-task (WP-31, product/10:57, product/18:34, Q72).
--
-- A human asks *"why did you choose X?"* about a task and the platform answers from its own record.
-- Q72 decided that the answer is produced by a **run**, because `runs.task_id` is `not null` and an
-- ask already has a task while `runs.task_stage_id` has been nullable since 0004 for exactly this
-- (technical/03:40-42 names ask-the-task as one of the three run kinds with no stage). So the
-- admission guard, the cost ledger, the transcript sink, the budget cap and the escalation are the
-- ones every other run gets, and this migration adds no second path for any of them.
--
-- ## Three enum values, and why they are a separate statement from the table
--
-- `alter type … add value` may run inside a transaction block (PostgreSQL 12+), which is what this
-- migration runner holds every file in, but the new label may **not be used** in the same
-- transaction. Nothing below uses one: `task_asks` stores no enum column, and the first row that
-- names `'ask'` is written by a run in a later transaction. Migration 0018 is the precedent.
--
-- Each value is **appended**, because `alter type … add value` without `before`/`after` appends and
-- `test/integration/db/enums.integration.test.ts` compares the database's labels with the zod enum
-- *in order*.
alter type run_mode add value 'ask';
alter type agent_role add value 'ask';
-- `AskAnswer` is the run's **output contract**: the runner derives the JSON schema it hands the SDK
-- and the validator it re-checks the answer with from the same `artifactDataSchemas` entry
-- (technical/04's defence in depth). It is a real `artifacts` row like any other artifact — which is
-- what lets a citation resolve through the read endpoints WP-15h shipped — and it is the one type
-- `packages/domain`'s `PROMPT_EXCLUDED_ARTIFACT_TYPES` keeps out of a *later stage's* prompt.
alter type artifact_type add value 'AskAnswer';

-- ## The thread
--
-- `task_asks` is the Q&A thread product/10:57 asks for, and it exists because the two halves of an
-- ask have no other home. A human's **question** precedes the run that answers it, so it cannot
-- live on `runs`; and `questions` is the opposite direction — technical/02:24 defines a Question as
-- *"a stage's request for human input"* — so a human's question to the platform has no storage
-- anywhere in this schema.
--
-- **`question`, `answer`, every citation's `detail` and `reference`, every `unanswered` line and the
-- asker's `display_name` are stored external text**, the sinks after `inbox`, `kb_chunks` and
-- `tasks.ticket_snapshot`: each is written **bounded and redacted**
-- (TD-012, `MAX_ASK_QUESTION_CHARS` / `MAX_ASK_ANSWER_CHARS` in `packages/domain/src/ask`), and
-- `redaction_count` is the only signal a redactor that stopped working would leave. The bounds are
-- deliberately **not** repeated as column types: a `varchar` here would refuse a row the writer had
-- already cut, which turns a short answer into a failed one.
--
-- **`asked_by_user_id` and `asked_by_identity` are two different facts and both are kept.** The
-- first is the platform user, which the API route knows from the session; the second is the
-- provider account a ticket-side ask came from, recorded even though it is redundant for a mapped
-- author, because "who asked" on the ticket side is what an operator reads when they are deciding
-- whether the mapping in `user_identities` is right. A ticket ask with **no** mapped user is never
-- stored at all — `classifyTicketComment` refuses an unverified identity before anything is written
-- (technical/02:161, BD-022, Q10) — so `asked_by_user_id` is `not null`.
create table task_asks (
  id uuid primary key default uuidv7(),
  task_id uuid not null references tasks (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  -- Where the question came from. `ui` is the task page's thread, `ticket` is a comment in the
  -- provider's own thread that carried the trigger.
  source text not null,
  asked_by_user_id uuid not null references users (id) on delete cascade,
  -- The provider account for a `ticket` ask: `{provider, external_id, display_name}`. Null for `ui`.
  asked_by_identity jsonb,
  -- The provider's own comment id, for a `ticket` ask. It is what makes a redelivered webhook
  -- idempotent (`task_asks_ticket_comment_unique`), and it is a provider string rather than a
  -- platform identity, so it is bounded by the unique index and by nothing else.
  ticket_comment_id text,
  question text not null,
  -- The run that answers it; null until admission creates one, and null for ever for an ask that
  -- admission refused (a spent budget). `on delete set null` rather than cascade: losing the run row
  -- must not delete the question a human asked.
  run_id uuid references runs (id) on delete set null,
  status text not null default 'pending',
  answer text,
  -- `AskAnswer.citations`, after the ones that leave this task have been dropped (product/11:30).
  citations jsonb not null default '[]'::jsonb,
  -- How many citations the model wrote that named another task's or another project's row. A count
  -- rather than a copy: the dropped citation is the model's claim about somewhere else and storing
  -- it would be the leak the drop exists to prevent.
  dropped_citations integer not null default 0,
  -- The `artifacts` row the answer was stored as, so the thread and the audit agree on one object.
  answer_artifact_id uuid references artifacts (id) on delete set null,
  -- Why an ask has no answer, in the platform's own words. Set for `refused` and `failed`.
  refusal_reason text,
  redaction_count integer not null default 0,
  -- Q72 (d): the ticket mirror is off by default and is a project setting
  -- (`features.ask.mirror_to_ticket`). `mirrored_at` is set by the `ask_answer` outbound duty when
  -- the comment has actually been posted, so a project that turns the mirror on later does not
  -- retroactively claim to have posted the answers it never sent.
  mirrored_at timestamptz,
  created_at timestamptz not null default now(),
  answered_at timestamptz,
  constraint task_asks_source_known check (source in ('ui', 'ticket')),
  constraint task_asks_status_known
    check (status in ('pending', 'answered', 'refused', 'failed')),
  -- "Answered" is one fact with three columns. A row with an answer and no instant could not be
  -- ordered in the thread, and a row whose status says `answered` with no answer would render as an
  -- empty reply — which is the shape standing rule 18 refuses.
  constraint task_asks_answered_triple check (
    (status = 'answered') = (answer is not null) and (answer is null) = (answered_at is null)
  ),
  -- The mirror image: a refusal has a reason and nothing else has one.
  constraint task_asks_refusal_pair check (
    (status in ('refused', 'failed')) = (refusal_reason is not null)
  ),
  constraint task_asks_redaction_count_nonnegative check (redaction_count >= 0),
  constraint task_asks_dropped_citations_nonnegative check (dropped_citations >= 0),
  -- A ticket comment produces **exactly one** ask, however many times the webhook is redelivered.
  -- The `inbox` row already deduplicates a delivery, and this deduplicates the *comment* — a
  -- provider that sends the same comment under two delivery ids (an edit, a replay) would otherwise
  -- start a second paid run for one question.
  constraint task_asks_ticket_comment_unique unique (project_id, ticket_comment_id)
);

-- The thread, newest first, which is the one read the task page makes.
create index task_asks_task_id_idx on task_asks (task_id, created_at desc);
-- The recovery read: an ask whose run never started or never finished.
create index task_asks_pending_idx on task_asks (created_at) where status = 'pending';

-- Registered rather than defaulted, so the "the registry lists every table" invariant of
-- `test/integration/db/migrations.integration.test.ts` stays true. `read_write`, because a row is
-- updated at most three times over its life — the run is attached, the answer is stored, the mirror
-- is stamped — and nothing else ever touches it.
insert into platform_table_policy (table_name, app_access)
values ('task_asks', 'read_write');
