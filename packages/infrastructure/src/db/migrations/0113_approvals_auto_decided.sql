-- migration-class: additive
-- 0113 — an approval the platform decided itself (S-28.8, the M28 ruling amending BD-006).
--
-- A project may opt in to `policies.plan_approval_risk`: a plan the platform's own facts and the
-- Architect's self-assessment both call low-risk goes ahead without a person. The approval row is
-- still written — its subject, its one reason (`low_risk_auto`, what the rule saw), status
-- `approved` and **no decider** — so the task page, the audit and the stage attempt's lookup all see
-- that the plan was decided and by what. `auto_decided` is what tells it from a person's approval:
-- written once, at insert (`ApprovalRepository.insert`), never by `save`.
--
-- **Additive by TD-032's list**: a `not null default` column the previous build never names (its
-- inserts take the default, `false`, which is what every one of its approvals is), like 0100's.
--
-- **Rollback residual (TD-032)**: an older build reading an auto-decided row ignores this column
-- and reads an approved approval with no decider, which is true; but its strict parse of
-- `approvals.reasons` does not know `low_risk_auto` or the other S-28.8 reason codes and refuses
-- the row (a 500 on that task's read) — filed as BACKLOG 1553.
alter table approvals add column auto_decided boolean not null default false;

comment on column approvals.auto_decided is
  'S-28.8: true when the platform approved this plan under the project''s low-risk rule (policies.plan_approval_risk) — no decider, reasons = [low_risk_auto]. Written once at insert.';
