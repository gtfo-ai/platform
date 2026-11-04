-- migration-class: additive
-- 0096 — `workers`, `worker_device_codes`, and `runs.worker_id`/`run_offers.worker_id` (WP-280,
-- TD-031 decisions 7 and 10c, BD-032 decision 8).
--
-- A **worker** is one developer machine registered against the core through a device-login flow
-- (RFC 8628's shape, research/17 § 7): the machine asks `POST /api/worker/v1/device` for a code
-- pair, its owner approves the short `user_code` on `/workers/approve` while signed in, and the
-- machine's `device/token` poll collects the worker credential **once**. The credential is
-- `wkr_<base32 id>_<43 base64url chars>`; only its SHA-256 is stored (`credential_hash`) — it is
-- high-entropy, so a slow hash buys nothing (TD-022) — and the plaintext exists in the core only in
-- the one response that hands it over.
--
-- **Revocation** sets `revoked_at` (and `state = 'revoked'`): every later call with the credential
-- is refused. In the revoking transaction the worker's live runs get `lease_expires_at = now()` and
-- nothing else, so the ordinary lease sweep ends them (TD-031 §7, §12) — which is what
-- `runs.worker_id` is for. Nothing writes it in this release: the remote claim (WP-281) is its first
-- writer, as it is of `run_offers.worker_id`.
--
-- **Device codes.** Both codes are stored hashed: the `device_code` is 32 random bytes (the poll's
-- bearer secret), and the `user_code` — eight letters of a 20-letter alphabet — is looked up by its
-- hash, so a read of this table cannot be turned into an approval. `client_address` and
-- `user_agent` are what the approval page shows against code phishing (TD-031 §10c); the address
-- is also the key of the outstanding-code limit. `interval_seconds` grows by 5 on every `slow_down`
-- (RFC 8628 §3.5). A row is **pending** until it is approved, denied or expires; an approved row is
-- **consumed** by the poll that mints the worker (`worker_id`), after which the code answers
-- `expired_token`. Retention: rows are small and bounded by the limits; none is deleted here.
--
-- **Additive** (TD-032 §1 and its 2026-11-04 amendment): two tables this file creates, with their
-- unique indexes, checks and registry rows (A); every reference to `users` states `on delete
-- cascade` (B); and two **new** nullable columns with an inline `references workers … on delete set
-- null` — a `not valid` key over WP-274's columns would have been `contract` (amendment C), which is
-- why WP-274 left `worker_id` out.
create table workers (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  -- The machine's name, chosen by the person who approved it.
  name text not null,
  credential_hash text not null,
  created_at timestamptz not null default now(),
  -- Written by the worker protocol (WP-281): the last authenticated call, the protocol it spoke and
  -- the image digests it reported.
  last_seen_at timestamptz,
  protocol_version integer,
  image_digests jsonb not null default '[]',
  state text not null default 'active',
  revoked_at timestamptz,
  -- TD-031 §11 (WP-285): a usage-limited worker pauses itself until `paused_until`.
  paused_until timestamptz,
  paused_reason text,
  concurrency integer not null default 1,
  constraint workers_name_shape check (length(name) between 1 and 200),
  constraint workers_credential_hash_shape check (credential_hash ~ '^[0-9a-f]{64}$'),
  constraint workers_state_known check (state in ('active', 'revoked')),
  constraint workers_revoked_shape check ((state = 'revoked') = (revoked_at is not null)),
  constraint workers_paused_reason_known check (paused_reason in ('usage_limited')),
  constraint workers_concurrency_bounds check (concurrency between 1 and 64),
  constraint workers_protocol_positive check (protocol_version > 0)
);

create unique index workers_credential_hash_key on workers (credential_hash);
create index workers_user_idx on workers (user_id);

create table worker_device_codes (
  id uuid primary key,
  device_code_hash text not null,
  user_code_hash text not null,
  client_address text not null,
  user_agent text,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  interval_seconds integer not null,
  last_polled_at timestamptz,
  approved_at timestamptz,
  approved_by uuid references users (id) on delete cascade,
  worker_name text,
  denied_at timestamptz,
  denied_by uuid references users (id) on delete cascade,
  consumed_at timestamptz,
  worker_id uuid references workers (id) on delete cascade,
  constraint worker_device_codes_device_hash_shape check (device_code_hash ~ '^[0-9a-f]{64}$'),
  constraint worker_device_codes_user_hash_shape check (user_code_hash ~ '^[0-9a-f]{64}$'),
  constraint worker_device_codes_address_shape check (length(client_address) between 1 and 64),
  constraint worker_device_codes_user_agent_shape check (length(user_agent) <= 512),
  constraint worker_device_codes_expiry_after_creation check (expires_at > created_at),
  constraint worker_device_codes_interval_bounds check (interval_seconds between 1 and 600),
  constraint worker_device_codes_one_decision check (approved_at is null or denied_at is null),
  constraint worker_device_codes_approval_shape check (
    (approved_at is null) = (approved_by is null) and (approved_at is null) = (worker_name is null)
  ),
  constraint worker_device_codes_denial_shape check ((denied_at is null) = (denied_by is null)),
  constraint worker_device_codes_consumed_shape check (
    (consumed_at is null) = (worker_id is null) and (consumed_at is null or approved_at is not null)
  ),
  constraint worker_device_codes_worker_name_shape check (length(worker_name) between 1 and 200)
);

create unique index worker_device_codes_device_hash_key on worker_device_codes (device_code_hash);
create unique index worker_device_codes_user_hash_key on worker_device_codes (user_code_hash);
-- The outstanding-code limits' count: pending codes per address, and in total.
create index worker_device_codes_pending_idx on worker_device_codes (client_address, expires_at)
  where approved_at is null and denied_at is null;

-- `read_write`: a worker row is created by the poll, renamed, paused and revoked in place; a device
-- code is created, polled, decided and consumed in place.
insert into platform_table_policy (table_name, app_access)
values ('workers', 'read_write'), ('worker_device_codes', 'read_write');

-- The remote claimant (WP-281) writes both; null for every run the server's runner took.
alter table runs add column worker_id uuid references workers (id) on delete set null;
alter table run_offers add column worker_id uuid references workers (id) on delete set null;

-- Revocation's lease expiry (TD-031 §7) reads a worker's live runs.
create index runs_worker_live_idx on runs (worker_id)
  where worker_id is not null and status in ('created', 'starting', 'running');

comment on table workers is
  'A registered developer machine (WP-280, TD-031 decision 7): one row per machine, tied to the user who approved its device code. credential_hash is the SHA-256 of the wkr_ credential, which is never stored. Revocation sets revoked_at and state = revoked, and expires the leases of the worker''s live runs in the same transaction.';

comment on table worker_device_codes is
  'The device flow''s codes (WP-280, TD-031 decision 10c): device_code and user_code stored as SHA-256, the requesting address and user agent shown on the approval page, interval_seconds grown by slow_down, approved or denied by a signed-in user, consumed by the poll that mints the worker.';

comment on column runs.worker_id is
  'The remote worker holding the run (WP-280''s column, written by WP-281''s claim); null for a run the server''s runner took.';

comment on column run_offers.worker_id is
  'The remote worker that claimed the offer (WP-280''s column, written by WP-281''s claim); null while open and for a server claim.';
