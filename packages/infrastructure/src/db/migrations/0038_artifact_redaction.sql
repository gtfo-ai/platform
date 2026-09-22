-- 0038 — a redaction count on `artifacts`, and the two prompt columns start being written
-- (WP-52, PROGRESS backlog 35, Q64; TD-012's WP-52 amendment).
--
-- ## Why `artifacts` needs a count at all
--
-- TD-012 is redaction *at the write* and its enumeration has always named **artifacts**. Exactly
-- one of its six paths applied it: the transcript sink. `createClaudeRunner` returned
-- `structuredOutput` untouched and the stage executor stored it verbatim, so a credential the
-- platform injected into a run reached `artifacts.data`, `questions.text` and — through
-- `recordMergeRequest` — the `tasks` row. It is measured rather than inferred: the librarian e2e
-- plants an `ANTHROPIC_API_KEY` through the **production** runner and found it verbatim in the row.
--
-- 0004 created `artifacts` with no `redaction_count`, so a redaction that *did* happen left no
-- trace. The column is TD-012's only visible signal: a redactor that silently stops working writes
-- rows that look exactly like clean ones.
--
-- ## Why it is nullable, which is *not* what 0013 and 0014 did
--
-- Those two added the column to tables whose existing rows were either absent (`integration_actions`
-- was empty) or non-existent (`inbox` had never been written), so `not null default 0` followed by
-- `drop default` cost nothing and bought a database-level refusal of a writer that forgets.
--
-- `artifacts` has rows, and **their true count is not zero, it is unknown**: they were written
-- before any redactor ran. Backfilling `0` would say "the redactor ran over this artifact and
-- replaced nothing", which is the precise confusion `redaction_count` exists to prevent (standing
-- rule 18). So the column is nullable with **no default**, and the three states are distinct:
--
--   null  — no redactor ran (every artifact written before this migration)
--   0     — the redactor ran and replaced nothing
--   n > 0 — it replaced n
--
-- The refusal 0013 bought is kept by a **NOT VALID** check: PostgreSQL exempts the existing rows
-- from validation and still enforces the constraint on every subsequent insert and update, so a
-- writer that omits the column from here is refused by the database rather than recorded as a null.
-- (It is asserted, not assumed: `test/integration/db/migrations.integration.test.ts` inserts an
-- artifact without the column and expects the refusal, and reads a pre-existing null back.)
alter table artifacts add column redaction_count integer;

alter table artifacts
  add constraint artifacts_redaction_count_recorded
  check (redaction_count is not null and redaction_count >= 0) not valid;

comment on column artifacts.redaction_count is
  'TD-012 replacements made in this row''s `data` at the write. null = written before migration 0038, when no redactor ran; 0 = the redactor ran and replaced nothing.';

-- ## `runs.redaction_count` keeps its default, and that is a decision rather than an omission
--
-- The column shipped in 0004 as `integer not null default 0` and migrations are forward-only, so
-- this file could drop the default and make an insert that forgets it fail — the 0013 answer.
-- It does **not**, for two reasons stated here because the next reader will ask.
--
-- 1. **It cannot repair the past.** Every `runs` row written before today already reads `0` from
--    that default, and no run has ever had a redactor at its creation — so the ambiguity the drop
--    exists to prevent is already in the table, and dropping the default only moves the boundary to
--    this migration's date without making the rows either side distinguishable.
-- 2. **The boundary is legible without it, from a column pair.** From this migration the *same
--    statement* that writes the count writes `system_prompt`, which has no default and can never be
--    the empty string (`RunSpec.systemPromptAppend` is `nonEmptyStringSchema`). So
--    `system_prompt is null` is exactly "no WP-52 writer touched this row", and
--    `system_prompt is not null and redaction_count = 0` is exactly "the redactor ran over this
--    run's prompts and replaced nothing". That is a stronger discriminator than a missing default,
--    because it distinguishes the *writer* rather than the *value*.
--
-- The cost of the drop is the third reason and the weakest, so it is last: twenty-one raw
-- `insert into runs` statements across twelve test files seed rows for other work packages'
-- concerns, and forcing each to declare a redaction count would put a number in them whose only
-- meaning is "this fixture had to say something".
comment on column runs.redaction_count is
  'TD-012 replacements made in `system_prompt` + `user_prompt` at run creation (WP-52). A row whose `system_prompt` is null predates that writer, and its 0 is 0004''s default rather than a measurement.';

-- ## The two prompt columns get their first writer
--
-- `system_prompt` and `user_prompt` have existed since 0004:75-76 and **nothing has ever written
-- either** (Q64): `RunRepository.insert` named twelve columns and neither was among them, so
-- `GET /api/runs/:id/prompt` refused every run by name with 409 `prompt_not_recorded` and the run
-- screen's Prompt tab was a permanent error state. No schema change is needed for them — they are
-- already `text` and already nullable, which is the right shape, because a row written before this
-- migration genuinely has no prompt and null is how it says so. This comment is here so that the
-- migration that *started writing them* is findable from the schema, which is the only place a
-- reader looks for when a column came alive.
comment on column runs.system_prompt is
  'Layers 1-3 of the assembled prompt (`RunSpec.systemPromptAppend`), redacted at the write (TD-012). Written since migration 0038; null means the run predates that writer.';

comment on column runs.user_prompt is
  'Layers 4-6 of the assembled prompt (`RunSpec.userPrompt`) — the task block, the context pack and the output contract — redacted at the write (TD-012). Written since migration 0038.';
