-- migration-class: additive
-- 0122 — `user_invites`: one-time invite links (TD-022's 2026-11-26 amendment).
--
-- With sign-up off (Q39) the only way to add a person was Better Auth's admin `create-user` with a
-- password the administrator chose. An administrator now makes a **link**, shares it however they
-- like, and whoever opens it chooses their own email, name and password.
--
-- One row per link. The token is 32 random bytes (base64url), shown once in the creation answer;
-- only its SHA-256 (hex) is stored, so a reader of this table cannot use a link. `role` is the role
-- the account gets. A link is **pending** while it is neither accepted nor revoked and `expires_at`
-- is ahead of the database's `now()` (1–720 hours after `created_at`, checked by the route).
--
-- **Accepting claims first**: one conditional `update … set accepted_at = now() where accepted_at
-- is null and revoked_at is null and expires_at > now() returning`, and only a claimed link reaches
-- Better Auth's `createUser`. A refusal of the email releases the claim (`accepted_at` back to null);
-- a crash between the two leaves `accepted_at` set and `accepted_user_id` null — the link is spent
-- and no account was made, never two. `accepted_user_id` is written once the account exists.
-- `revoked_at`/`revoked_by` are an administrator's revocation, allowed only while not accepted.
--
-- The three references to `users` are nullable with `on delete set null` (TD-032 amendment B): a
-- deleted administrator or account leaves the link's history, never a refused delete.
--
-- **Additive** (TD-032 §1 and amendment A/B): a table this file creates, its unique index, its
-- checks and its registry row; the previous build never names it.
create table user_invites (
  id uuid primary key,
  token_sha256 text not null,
  role user_role not null,
  created_by uuid references users (id) on delete set null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  accepted_at timestamptz,
  accepted_user_id uuid references users (id) on delete set null,
  revoked_at timestamptz,
  revoked_by uuid references users (id) on delete set null,
  constraint user_invites_token_shape check (token_sha256 ~ '^[0-9a-f]{64}$'),
  constraint user_invites_expiry_after_creation check (expires_at > created_at),
  constraint user_invites_one_ending check (accepted_at is null or revoked_at is null),
  constraint user_invites_accepted_shape check (accepted_user_id is null or accepted_at is not null),
  constraint user_invites_revoked_shape check (revoked_by is null or revoked_at is not null)
);

create unique index user_invites_token_key on user_invites (token_sha256);
-- The administrator's list, newest first.
create index user_invites_created_idx on user_invites (created_at);

-- `read_write`: a link is claimed, released, accepted and revoked in place.
insert into platform_table_policy (table_name, app_access) values ('user_invites', 'read_write');

comment on table user_invites is
  'One-time invite links (TD-022 2026-11-26 amendment): the SHA-256 of a 32-byte base64url token, never the token; the role the account gets; pending while not accepted, not revoked and before expires_at (1-720 h). Accepting claims accepted_at first, then creates the account; a refused email releases the claim.';
