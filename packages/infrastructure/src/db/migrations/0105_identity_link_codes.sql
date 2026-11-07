-- migration-class: additive
-- 0105 — a person links their own tracker or git account, proven by the provider (S-26.6, TD-031's
-- 2026-11-06 amendment item 9).
--
-- A linked identity gains authority: it answers questions and approves plans (BD-006, BD-022,
-- Q10). So a link is never typed and never matched by email. The person asks for a **link code**,
-- writes it as a comment from their own account, the platform reads the comment's authenticated
-- author from a verified delivery (or through the binding, *I wrote it on …*), and the person then
-- **confirms** that account. Only the confirmation writes `user_identities`.
--
-- **`identity_link_codes`.** One row per issued code. The code is `agentic-link-` and ten Crockford
-- base32 characters (50 bits from a CSPRNG); only its SHA-256 is stored (`code_hash`), so a reader
-- of this table cannot post a code. A code is **live** while it is neither consumed nor voided and
-- younger than `expires_at` (30 minutes). One live code per user: a new one voids the previous with
-- `void_reason = 'replaced'` in the issuing transaction, and the partial unique index below holds
-- it. At most five are issued per user per hour (the issuing transaction counts `created_at`).
-- `void_reason` says why a code stopped: replaced, a second distinct author matched it
-- (`second_author`), or the author is linked to another user (`identity_linked_elsewhere`).
-- `consumed_match_id` is the confirmed match, set with `consumed_at` (and `null` again only if the
-- match's integration is deleted).
--
-- **`identity_link_matches`.** What a comment carrying a code proved, and nothing else: the
-- provider account that wrote it (`provider`, `external_id`, the redacted and bounded
-- `display_name`), the comment's id and the integration it came through. **Nothing of the comment's
-- text is stored** (BD-022): the code regex is its only reader. `outcome` is one of
--   match    the comment carried a live code (`code_id` set) — a proposal the person may confirm;
--   miss     the comment carried a code-shaped string that is no live code (`code_id` null);
--   ignored  the author reached five misses in 24 hours and is ignored for the day — the audit row.
-- A match is never a link: it expires with its code, and a second distinct author voids the code.
-- One match per author per code, one miss per author per comment.
--
-- **Additive** (TD-032 §1 and amendment B): two tables this file creates, with their indexes,
-- checks and registry rows; the references to `users` and `integrations` state `on delete cascade`,
-- and the two tables' references to each other need nothing. The previous build never names either.
create table identity_link_codes (
  id uuid primary key,
  user_id uuid not null references users (id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_match_id uuid,
  voided_at timestamptz,
  void_reason text,
  constraint identity_link_codes_hash_shape check (code_hash ~ '^[0-9a-f]{64}$'),
  constraint identity_link_codes_expiry_after_creation check (expires_at > created_at),
  constraint identity_link_codes_one_ending check (consumed_at is null or voided_at is null),
  -- A consumed code names its match until an integration's deletion cascades the match away.
  constraint identity_link_codes_consumed_shape check (
    consumed_match_id is null or consumed_at is not null
  ),
  constraint identity_link_codes_void_shape check ((voided_at is null) = (void_reason is null)),
  constraint identity_link_codes_void_reason_known check (
    void_reason in ('replaced', 'second_author', 'identity_linked_elsewhere')
  )
);

create unique index identity_link_codes_hash_key on identity_link_codes (code_hash);
-- One live code per user (TD-031 item 9): a code that has neither ended nor been replaced holds the
-- slot until the next issue voids it, so an expired one still counts here and is replaced first.
create unique index identity_link_codes_one_open_per_user on identity_link_codes (user_id)
  where consumed_at is null and voided_at is null;
-- The five-per-hour count.
create index identity_link_codes_user_created_idx on identity_link_codes (user_id, created_at);

create table identity_link_matches (
  id uuid primary key,
  outcome text not null,
  code_id uuid references identity_link_codes (id) on delete cascade,
  integration_id uuid not null references integrations (id) on delete cascade,
  provider text not null,
  external_id text not null,
  display_name text,
  comment_id text not null,
  created_at timestamptz not null,
  confirmed_at timestamptz,
  constraint identity_link_matches_outcome_known check (outcome in ('match', 'miss', 'ignored')),
  constraint identity_link_matches_code_shape check ((outcome = 'match') = (code_id is not null)),
  constraint identity_link_matches_confirmed_shape check (
    confirmed_at is null or outcome = 'match'
  ),
  constraint identity_link_matches_provider_shape check (length(provider) between 1 and 64),
  constraint identity_link_matches_external_id_shape check (
    external_id ~ '^[A-Za-z0-9:._-]{1,255}$'
  ),
  constraint identity_link_matches_comment_id_shape check (
    comment_id ~ '^[A-Za-z0-9:._-]{1,255}$'
  ),
  constraint identity_link_matches_display_name_shape check (length(display_name) <= 128)
);

-- One match per author per code: a redelivery, or the same comment read again, adds nothing.
create unique index identity_link_matches_one_per_author on identity_link_matches
  (code_id, provider, external_id) where outcome = 'match';
-- One miss per author per comment, so a thread read twice does not count its misses twice.
create unique index identity_link_matches_one_miss_per_comment on identity_link_matches
  (provider, external_id, comment_id) where outcome = 'miss';
-- The 24-hour miss count and the ignored check, per author.
create index identity_link_matches_author_idx on identity_link_matches
  (provider, external_id, outcome, created_at);

alter table identity_link_codes
  add constraint identity_link_codes_consumed_match_fkey
  foreign key (consumed_match_id) references identity_link_matches (id) on delete set null;

-- `read_write`: a code is issued, voided and consumed in place; a match is confirmed in place.
insert into platform_table_policy (table_name, app_access)
values ('identity_link_codes', 'read_write'), ('identity_link_matches', 'read_write');

comment on table identity_link_codes is
  'Self-service account link codes (S-26.6, TD-031 2026-11-06 amendment item 9): agentic-link- plus 10 Crockford base32 characters, stored as SHA-256 only. Live while not consumed, not voided and before expires_at (30 min); one open per user; at most five issued per user per hour.';

comment on table identity_link_matches is
  'What a comment carrying a link code proved: the provider account that wrote it and the comment id, never its text (BD-022). outcome match (code_id set, a proposal the person confirms), miss (no live code) or ignored (five misses in 24 h, the audit row). A match is not a link: only the person''s confirmation writes user_identities.';
