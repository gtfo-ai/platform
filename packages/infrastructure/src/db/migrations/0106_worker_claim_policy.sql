-- migration-class: additive
-- 0106 — what a person's machine takes by itself: its claim policy (S-26.4, TD-031's 2026-11-06
-- amendment item 6, BD-032's 2026-11-06 amendment 2).
--
-- `claim_policy` is the second axis of what a worker's **automatic** claims take, orthogonal to
-- `claim_project_ids` (migration 0101), which stays the project axis:
--
--   everything            any task of the projects the worker may take;
--   mine_and_unassigned   the tasks its user owns, and the tasks nobody owns that are not held
--                         elsewhere — the default a new worker is written with;
--   mine                  only the tasks its user owns (an ask: only the asks its user asked);
--   pick_only             nothing by itself — a run starts only when its owner picks it.
--
-- **Nullable, with no default, and no backfill**: `null` reads as `pick_only` when
-- `claim_project_ids = '{}'` (the legacy *pick only*) and as `everything` otherwise, so every row
-- the previous build wrote keeps the meaning it had without a data rewrite (a backfill would be a
-- contract migration, TD-032). The worker insert of the device flow writes `mine_and_unassigned`.
-- A legacy `'{}'` narrows **no** project once read through the policy (it reads as `null` wherever
-- the project list narrows), and the new writes never store `'{}'`.
--
-- The check is TD-032 amendment C's shape: `not valid` over a column this file adds,
-- null-propagating by construction, then validated (no row carries a value yet). Additive by
-- TD-032's list: a nullable column the previous build never names — which is also the rollback's
-- residual (BACKLOG 1082: the previous build reads every worker as `everything`).
alter table workers add column claim_policy text;

alter table workers add constraint workers_claim_policy_known
  check (claim_policy in ('everything', 'mine_and_unassigned', 'mine', 'pick_only')) not valid;

alter table workers validate constraint workers_claim_policy_known;

comment on column workers.claim_policy is
  'What the worker''s automatic claims take (S-26.4, TD-031 2026-11-06 item 6): everything | mine_and_unassigned | mine | pick_only. Null reads as pick_only when claim_project_ids = ''{}'', else everything.';
