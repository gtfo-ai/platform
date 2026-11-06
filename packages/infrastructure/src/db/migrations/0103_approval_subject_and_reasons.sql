-- migration-class: additive
-- 0103 — what an approval approves, and why it was asked (S-25.1, TD-035 decision 3, BD-006's
-- 2026-11-06 amendment).
--
-- Until now an `approvals` row had no subject and no reason: the plan gate loaded the plan and
-- evaluated the policy, then threw both away, so the task page could only say "Plan approval ·
-- requested". Three nullable columns, **written once, at insert**, by the gate that asks:
--
--   subject_artifact_id  the `ImplementationPlan` artifact the plan gate loaded. Artifacts are
--                        written once per `(task_id, type, version)`, so its version is read
--                        through this key rather than copied.
--   subject_detail       the budget gate's snapshot: `{estimate_usd, threshold_usd, estimate_basis,
--                        estimate_samples}`.
--   reasons              every reason the gate asked for — TD-035's closed vocabulary, a non-empty
--                        JSON array when present (an empty list is refused here).
--
-- `ApprovalRepository.save` never names them (its decision-columns-only rule), so a decision cannot
-- rewrite what was asked. **No backfill**: a data rewrite is `contract` under TD-032 §1, and for
-- every row the exact chain cannot pin it would be a guess. A row written before this file reads
-- *not recorded*; the read may derive a plan subject for it through one exact chain and labels it
-- `derived` (TD-035 decision 5).
--
-- **Additive by TD-032's list**: nullable columns the previous build never names, a foreign key and
-- a check each added `not valid` and then validated — every existing row is `null`, which both
-- admit, and the previous build inserts without the columns, so its rows are `null` too.
-- `on delete set null` matches `artifacts`' own lifetime: an artifact goes only with its task, and
-- the task's approvals go with it (`approvals.task_id … on delete cascade`).
alter table approvals add column subject_artifact_id uuid;
alter table approvals add column subject_detail jsonb;
alter table approvals add column reasons jsonb;

alter table approvals add constraint approvals_subject_artifact_id_fkey
  foreign key (subject_artifact_id) references artifacts (id) on delete set null not valid;
alter table approvals validate constraint approvals_subject_artifact_id_fkey;

-- The check TD-035 asks for ("a non-empty array when present") in the one form TD-032's amendment C
-- admits on an existing table — a column compared with a literal, so a `null` passes by
-- construction: an empty list is refused. That the value is an **array** of known reasons, and that
-- `subject_detail` is the budget snapshot, is held by the one writer's strict zod schemas
-- (`approvalReasonsSchema`, `budgetApprovalSubjectDetailSchema`) and by the read, which parses the
-- same schemas and refuses a row that does not (never a default). `jsonb_typeof` is a function call,
-- which amendment C cannot read as null-propagating, so it is not used here.
alter table approvals add constraint approvals_reasons_not_empty
  check (reasons <> '[]') not valid;
alter table approvals validate constraint approvals_reasons_not_empty;

comment on column approvals.subject_artifact_id is
  'TD-035: the ImplementationPlan the plan gate loaded when it asked. Written once at insert; null = not recorded (every row before 0103, and every non-plan approval).';
comment on column approvals.subject_detail is
  'TD-035: the budget gate''s snapshot {estimate_usd, threshold_usd, estimate_basis, estimate_samples}. Written once at insert; null = not recorded.';
comment on column approvals.reasons is
  'TD-035: every reason the gate asked, in its closed vocabulary (a non-empty JSON array). Written once at insert; null = not recorded.';
