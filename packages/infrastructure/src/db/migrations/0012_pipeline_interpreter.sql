-- 0012 — what the pipeline interpreter needs on top of 0004 (WP-15).
--
-- 0004 wrote the pipeline tables before there was an interpreter to fill them, and left two notes
-- for this work package: "State, outcome and return reason are free-form until WP-15 fixes the
-- interpreter's vocabulary" on `task_stages`, and no home at all for the two pieces of a Task
-- aggregate that are neither state nor counters. This adds them.

-- The per-stage attempt counters (`Task.stageAttempts`). They are what `task.stage.entered.attempt`
-- carries and what a re-validating `stage.execute` job compares itself against, so they have to
-- survive a restart. Derivable from `task_stages` with a `max(attempt) group by stage`, and stored
-- anyway: the interpreter reads them on every transition, and a projection that has to be
-- recomputed to load an aggregate is a projection that will one day disagree with it.
alter table tasks add column stage_attempts jsonb not null default '{}'::jsonb;

-- BD-008's bounded loops, frozen at task start with the rest of the effective configuration
-- (technical/12: "computed at task start and frozen"). Not read from settings at transition time on
-- purpose: a project that lowers `code_review_iterations` while a task is mid-loop would otherwise
-- escalate it retroactively.
alter table tasks add column iteration_limits jsonb not null default '{}'::jsonb;

-- Convergence detection (product/04 S4 "three identical failures in a row", S5 "the same findings
-- as the previous round") compares a *stable* signature across attempts. It cannot live in
-- `outcome`: that column is written by whichever path closes the row — the executor writes the
-- verdict, the transition writes `returned` — so a signature stored there is overwritten by the
-- very transition it exists to stop. Measured as a defect before this column existed: three
-- identical CI failures never converged, because each signature was replaced by `returned`.
alter table task_stages add column signature text;

create index task_stages_signature_idx on task_stages (task_id, stage, attempt)
  where signature is not null;

-- Which stage attempt an approval belongs to. `questions` has carried `task_stage_id` since 0004;
-- approvals had nothing, so an approved plan would have approved every *later* plan of the same
-- task as well — a task that returns to Architecture and produces a second `ImplementationPlan`
-- has to be approved again (product/04 S2).
alter table approvals add column stage text;
alter table approvals add column attempt integer;

alter table approvals add constraint approvals_attempt_positive
  check (attempt is null or attempt >= 1);

create index approvals_task_stage_idx on approvals (task_id, kind, stage, attempt);

-- The stage a question was asked from. `questions.task_stage_id` links to the row, but the pipeline
-- resumes by *stage id* — it re-enters the stage that asked — and resolving that through a join on
-- every answer would make the read path depend on a row the writer had to look up first.
alter table questions add column stage text;
