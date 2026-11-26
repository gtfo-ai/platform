-- migration-class: additive
-- 0124 — `run_offers.excluded_worker_since`: when the offer excluded each machine (TD-031's
-- 2026-11-27 amendment item 1, BACKLOG 1670).
--
-- BACKLOG 1661 lets the task owner's excluded machine take the offer again after a backoff. Until
-- now `excluded_worker_ids` carried no instant, so one clock served the whole list — the later of
-- `offered_at` and `released_at` — and another machine's release restarted the owner's machine's
-- wait. This is the per-machine instant: an object `{"<worker id>": "<timestamptz>"}`.
--
-- Writers: `RunOfferRepository.insert` (each id the offer is written with, at the instant the
-- re-planned entry carried for it, else `offered_at`) and `RunOfferRepository.release` (the
-- released machine at the release's instant, overwritten when it was excluded already — it failed
-- again). Reader: the claim's eligibility (`exclusionAdmitsSql`) and `carriedExclusions`, which
-- fall back to the old shared clock for an id with no entry — every offer written before this
-- migration, and a release by a build that predates it.
--
-- **Additive by TD-032's list**: a `not null default` column the previous build never names (its
-- inserts and releases leave the default `{}` or the existing value), like 0100's and 0113's. Its
-- two writers build an object with `jsonb_object_agg`/`||`; no check is added (a function-call check
-- on an existing table is not additive by the scanner's rule, 0121's note).
alter table run_offers add column excluded_worker_since jsonb not null default '{}'::jsonb;

comment on column run_offers.excluded_worker_since is
  'BACKLOG 1670: when the offer excluded each machine of excluded_worker_ids, keyed by worker id; an id with no entry reads the later of offered_at and released_at.';
