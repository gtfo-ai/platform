-- migration-class: additive
-- 0095 — `run_plans`: the run's planned spec, sealed, written in the run's creation transaction and
-- cleared at its terminal write (WP-275a, TD-031's 2026-11-04 amendment on decisions 1–3 and 6, §2).
--
-- Once the stage job ends at the offer (WP-276), the run is executed and settled by a claimant that
-- has only what is stored. Two inputs were stored nowhere: the `RunSpec` itself (the planner's output
-- over a point-in-time read — re-planning yields another document) and the review checklists the
-- planner applied. So the plan is persisted **once**, beside the run row, where the prompt columns
-- and the context pack are written, and never re-derived.
--
-- **The spec is sealed, not redacted.** `sealed_spec` is `storedRunSpecSchema` (`@platform/contracts`):
-- the spec with every secret `env` value removed (the names stay in `secret_env_names`), prompts
-- included byte-identical, envelope-sealed under `APP_SECRET_KEY` with the mechanism `secrets` uses
-- (`packages/infrastructure/src/secrets/envelope.ts`, the run id as the bound identity) — so the
-- session is handed exactly the bytes the planner assembled. It is served by no route and no export,
-- and `RunRepository.finish` sets it null in the run's terminal transaction: a sealed spec exists only
-- while its run is live. The readable record of the prompt stays `runs.system_prompt`/`user_prompt`.
--
-- `secret_env_names`, `review_checklists` and `question_timeout` are platform text and stay readable:
-- settle needs them after the seal is cleared (a repeated settle builds the same redactor).
--
-- **Additive under TD-032 §1 and its 2026-11-04 amendment**: a table this file creates and its
-- registry row (A); its one reference to an existing table names `on delete cascade` (B); no
-- `not valid` constraint (C). It does **not** raise the rollback floor: an older build never reads
-- the table.
create table run_plans (
  run_id uuid primary key references runs (id) on delete cascade,
  -- The sealed spec's shape (`RUN_PLAN_FORMAT`), bumped when it changes.
  format smallint not null,
  -- Envelope-sealed `storedRunSpecSchema`; null once the run is terminal.
  sealed_spec bytea,
  -- The APP_SECRET_KEY generation that sealed it (as `secrets.key_id`).
  key_id text not null,
  -- The spec's `secretEnvNames`: names, never values.
  secret_env_names text[] not null,
  -- `AppliedChecklistRecord[]` the planner gave a Reviewer run; null = recorded nothing (WP-45).
  review_checklists jsonb,
  -- `questionTimeoutOf(settings)` at plan time.
  question_timeout text not null,
  created_at timestamptz not null default now(),
  constraint run_plans_format_positive check (format > 0),
  constraint run_plans_key_id_shape check (length(key_id) between 1 and 128),
  constraint run_plans_question_timeout_shape check (length(question_timeout) between 1 and 64)
);

-- `read_write`: written at the run's creation, its seal cleared by the run's terminal writer.
insert into platform_table_policy (table_name, app_access)
values ('run_plans', 'read_write');

comment on table run_plans is
  'The run''s planned spec (WP-275a, TD-031''s 2026-11-04 amendment §2): written in the run''s creation transaction, sealed_spec envelope-sealed under APP_SECRET_KEY with secret env values removed, cleared (null) by the run''s terminal writer. Served by no route.';
