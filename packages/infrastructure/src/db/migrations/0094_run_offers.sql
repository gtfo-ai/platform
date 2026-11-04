-- migration-class: additive; raises-rollback-floor
-- 0094 — `run_offers` and `runs.lease_epoch`: every agent run is an offer one claim takes, fenced by
-- an epoch (WP-274, TD-031 decisions 1–2 and its 2026-11-04 amendment).
--
-- Until now a run was the property of the `stage.execute` (or `task.ask`) job that created it: the
-- job held the task's singleton, created the row, claimed the lease in the same transaction and ran
-- the session. TD-031 splits that into an **offer** — one row per run, written in the run's own
-- creation transaction — and a **claim**: one SQL statement every claimant uses (`for update skip
-- locked` over open offers), which increments `lease_epoch` and writes the run's `lease_owner`,
-- `lease_expires_at` and `lease_epoch` in the same statement. Every later write a claimant makes is
-- conditional on `(lease_epoch, lease_owner)`, so a claimant that lost the run writes nothing.
--
-- **In this release the server's runner is the only claimant and nothing else changes**: the job
-- writes the offer and claims it at once, in the run's transaction, and the run still executes inside
-- the job. Later rows move the run out of the job (WP-276) and add remote claimants (WP-281).
--
-- **The per-task partial unique index replaces the job singleton for a run's duration** (TD-031 §1,
-- §3): at most one `open` or `claimed` stage offer per task. So every terminal writer closes the
-- run's offer in the run's terminal transaction — `RunRepository.finish` does it for all of them,
-- after it wins the row — or the next stage's offer would violate it. An `ask` offer runs beside a
-- stage (TD-031 §13) and is outside the index.
--
-- **Columns.** All of TD-031 decision 1's columns but `worker_id`, which WP-280's migration adds with
-- an inline `references workers` (TD-032's 2026-11-04 amendment C): the later M22 rows that write
-- them (WP-276, WP-278, WP-281, WP-282) ship no migration. `ssh_signatures` is TD-031's 2026-11-04
-- amendment (backlog 693): the per-run signature cap, counted in the database because any API
-- replica may answer `ssh-sign`.
--
-- **Additive by TD-032's amended list** (A–D): a table this file creates, its unique index, checks
-- and registry row (A); every reference to an existing table names `on delete cascade` (B); and a
-- `runs` column that is `not null default 0`, which the previous build never names and whose
-- inserts take the default. **It raises the rollback floor** (TD-032 §2): a build before this one
-- writes no offer, so a task it starts a stage for would leave no row for the index this build
-- relies on — `org.platform.rollback-floor` moves from 1 to 2 in the same change.
create table run_offers (
  id uuid primary key,
  run_id uuid not null unique references runs (id) on delete cascade,
  task_id uuid not null references tasks (id) on delete cascade,
  project_id uuid not null references projects (id) on delete cascade,
  -- The stage entry the run serves; null for an `ask` offer, whose run belongs to no stage.
  stage text,
  attempt integer not null,
  kind text not null,
  state text not null default 'open',
  -- 0 while never claimed; incremented by every claim (TD-031 §2).
  lease_epoch integer not null default 0,
  claimant_kind text,
  -- TD-031 decision 8 (WP-278 writes them): who may claim, and from when.
  assignee_user_id uuid references users (id) on delete set null,
  assignee_until timestamptz,
  server_from timestamptz,
  workers_from timestamptz,
  excluded_worker_ids uuid[] not null default '{}',
  -- TD-031 decision 4 (WP-279/WP-281): the run and egress image digests the package names.
  image_digests jsonb,
  -- TD-031 decision 7 (WP-281): the run token minted at the claim, hashed, and its epoch.
  run_token_hash text,
  run_token_epoch integer,
  -- TD-031 decision 6 (WP-276/WP-285): the last unspent release.
  release_reason text,
  released_at timestamptz,
  -- TD-031's 2026-11-04 amendment (backlog 693): signatures `ssh-sign` made for this run.
  ssh_signatures integer not null default 0,
  offered_at timestamptz not null,
  claimed_at timestamptz,
  settled_at timestamptz,
  withdrawn_at timestamptz,
  withdrawn_reason text,
  expires_at timestamptz,
  constraint run_offers_kind_known check (kind in ('stage', 'ask')),
  constraint run_offers_state_known check (state in ('open', 'claimed', 'settled', 'withdrawn')),
  constraint run_offers_claimant_known check (claimant_kind in ('server', 'worker')),
  constraint run_offers_epoch_nonnegative check (lease_epoch >= 0),
  constraint run_offers_attempt_positive check (attempt > 0),
  constraint run_offers_signatures_nonnegative check (ssh_signatures >= 0),
  constraint run_offers_stage_shape check (kind = 'ask' or stage is not null),
  -- A claimed (or once-claimed, settled) offer names its claimant; an open one has none yet.
  constraint run_offers_claimed_has_claimant check (
    state not in ('claimed') or (claimant_kind is not null and lease_epoch > 0 and claimed_at is not null)
  ),
  constraint run_offers_withdrawn_has_reason check (
    state <> 'withdrawn' or (withdrawn_at is not null and withdrawn_reason is not null)
  ),
  constraint run_offers_withdrawn_reason_shape check (length(withdrawn_reason) between 1 and 64),
  constraint run_offers_release_reason_shape check (length(release_reason) between 1 and 64)
);

-- TD-031 §1: at most one open or claimed **stage** offer per task — the job singleton's successor.
create unique index run_offers_one_live_stage_per_task on run_offers (task_id)
  where kind = 'stage' and state in ('open', 'claimed');

-- The claim's scan: open offers, oldest first (TD-031 §2).
create index run_offers_open_idx on run_offers (offered_at) where state = 'open';

-- `read_write`: written at the offer, moved by the claim, closed by the run's terminal writer.
insert into platform_table_policy (table_name, app_access)
values ('run_offers', 'read_write');

-- The epoch the run's current claim holds (TD-031 §2): copied from the offer at the claim, and the
-- fence every later write by the claimant is conditional on. 0 for every run before this file and
-- for any run no claim took.
alter table runs add column lease_epoch integer not null default 0;

comment on table run_offers is
  'One offer per agent run (WP-274, TD-031 decision 1): written in the run''s creation transaction, claimed by one SQL claim that increments lease_epoch, closed (settled or withdrawn) by the run''s terminal writer. The partial unique index holds one open or claimed stage offer per task.';

comment on column runs.lease_epoch is
  'The epoch of the claim that holds this run (WP-274, TD-031 decision 2), copied from run_offers.lease_epoch; renew and finish by the claimant are conditional on it and on lease_owner.';
