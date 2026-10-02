-- 0073 — a repository reading says how its prompt texts were redacted, and what it withheld
-- (WP-121, TD-012's M7 amendment, PROGRESS backlog 359 and 363).
--
-- ## `project_repository_config.prompts_redaction`
--
-- Since WP-107 a reading redacts the prompt files of `.agentic/prompts/` by the exact values of the
-- credentials the platform holds for the project (TD-012 step 1) before the pattern rules (step 2).
-- A row written before that was redacted by the pattern rules **only**, so a binding credential
-- committed in a shape no rule knows is still in it, and every run of the project was handed it and
-- kept it in `runs.user_prompt` until the next successful reading (backlog 359).
--
-- `patterns` for **every row that exists when this migration runs** — none of them can be shown to
-- have had the exact pass, and the cheap direction is to re-read one that did — and `exact` for every
-- row written after it: `RepositoryConfigStore.record` writes the column on every insert and update.
-- The default is dropped after the backfill, so a writer that forgets the column fails rather than
-- marking a reading it did not redact.
--
-- What reads it: every reader of the row goes through `snapshotOfRow`
-- (`packages/infrastructure/src/config/postgres-repository-config-store.ts`), which serves **no**
-- prompt text from a `patterns` row — the planner gets none and `GET …/config` publishes none — and
-- says why in the withheld record below. The process that runs the knowledge index re-reads each
-- `patterns` project, a bounded number per pass (`rereadPatternReadings`), which replaces the row
-- with an `exact` one; a re-read that fails records its reason here and leaves the mark.
alter table project_repository_config
  add column prompts_redaction text not null default 'patterns';

alter table project_repository_config alter column prompts_redaction drop default;

alter table project_repository_config
  add constraint project_repository_config_prompts_redaction_known check (
    prompts_redaction in ('patterns', 'exact')
  );

-- ## `project_repository_config.prompts_withheld`
--
-- Why this reading holds no prompt texts although it may have read some (backlog 363): until WP-121
-- only an `error` log line said so, and a run's convention-append files vanished with nothing naming
-- why. `{"reason": <sentence>, "integrations": [{"integration": <label>, "reason": <why>}, …]}` —
-- `integrations` names each account whose credentials could not be decrypted (WP-107's fail-closed
-- direction, backlog 358), and is empty when the reason is a `patterns` reading that could not be
-- re-read. A label is `integration "<name>" (<provider>, <id>)` and a reason is the secret store's
-- sentence: never a credential value. `null` is *"nothing was withheld"*.
alter table project_repository_config add column prompts_withheld jsonb;

alter table project_repository_config
  add constraint project_repository_config_prompts_withheld_shape check (
    prompts_withheld is null
    or coalesce(
      jsonb_typeof(prompts_withheld) = 'object'
      and jsonb_typeof(prompts_withheld -> 'reason') = 'string'
      and jsonb_typeof(prompts_withheld -> 'integrations') = 'array',
      false
    )
  );

-- A reading that withheld its prompt texts stores none (0063's `null`), so the two never disagree.
alter table project_repository_config
  add constraint project_repository_config_withheld_has_no_prompts check (
    prompts_withheld is null or prompts is null
  );

-- ## `runs.prompts_withheld`
--
-- The same record, frozen with the run that was planned from the reading (backlog 363): a stage
-- whose convention-append file is missing from its prompt says why on `GET /api/runs/:id/prompt`.
-- Written by the stage executor's insert from the settings it planned with, never updated. `null` is
-- *"nothing was withheld"* — and every run created before this migration, which recorded nothing
-- either way (stated, not recovered).
alter table runs add column prompts_withheld jsonb;

alter table runs
  add constraint runs_prompts_withheld_shape check (
    prompts_withheld is null
    or coalesce(
      jsonb_typeof(prompts_withheld) = 'object'
      and jsonb_typeof(prompts_withheld -> 'reason') = 'string'
      and jsonb_typeof(prompts_withheld -> 'integrations') = 'array',
      false
    )
  );
