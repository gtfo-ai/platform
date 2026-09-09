-- 0011 — Better Auth's tables (TD-022), applied to the placeholder identity schema of 0003.
--
-- 0003 wrote `users` and `sessions` from technical/03 and said in its own comments that WP-06
-- "owns the columns it needs" once Better Auth lands. This is that migration. It is forward-only
-- (TD-019): 0003 is untouched, the columns Better Auth needs are added here, and the two tables it
-- needs that did not exist are created.
--
-- The shape below is not invented. It is what `getMigrations()` from `better-auth/db/migration`
-- generates for the platform's auth configuration (`apps/server/src/auth/better-auth.ts`), and
-- `test/integration/auth/better-auth-schema.integration.test.ts` asserts that Better Auth itself
-- finds nothing left to create or add after this migration has run — so a Better Auth upgrade that
-- widens the schema fails a test rather than a login.
--
-- Naming: the platform's wire format is snake_case everywhere (CLAUDE.md), so every camelCase
-- Better Auth field is mapped to a snake_case column through the `fields` maps in the auth
-- configuration. Ids stay `uuid` (the rest of the schema is uuid) via
-- `advanced.database.generateId: 'uuid'`.

-- ── users ────────────────────────────────────────────────────────────────────
-- `role` already exists as the `user_role` enum of 0002 and stays that way: Better Auth's admin
-- plugin writes the role as text, and PostgreSQL casts the parameter to the enum, so the database
-- keeps enforcing the four-role vocabulary of TD-022 instead of accepting whatever string a plugin
-- default happens to carry. The auth configuration therefore sets `defaultRole: 'member'` and
-- `adminRoles: ['admin']` — labels the enum has.
alter table users add column email_verified boolean not null default false;
alter table users add column image text;
alter table users add column banned boolean;
alter table users add column ban_reason text;
alter table users add column ban_expires timestamptz;

-- Credentials move to `accounts.password` (provider `credential`), which is where Better Auth
-- reads and writes them. Keeping a second, unread password column would be a place for a stale
-- hash to sit and look authoritative.
alter table users drop column password_hash;

comment on column users.role is
  'Org-level role (TD-022). Better Auth''s admin plugin reads and writes it; the enum keeps the vocabulary.';
comment on column users.status is
  'Account lifecycle: active | invited | disabled (technical/08 UserSummary). Better Auth''s own ban fields are separate.';

-- ── sessions ─────────────────────────────────────────────────────────────────
-- The placeholder rows of 0003 have no token and can therefore authenticate nothing; they are
-- removed so `token` can be added NOT NULL. In practice the table is empty — nothing has ever
-- written to it, because no session issuer existed before this migration.
delete from sessions;

alter table sessions add column token text not null;
alter table sessions add constraint sessions_token_key unique (token);
alter table sessions add column updated_at timestamptz not null default now();
alter table sessions add column ip_address text;
alter table sessions add column user_agent text;
alter table sessions add column impersonated_by text;

comment on table sessions is
  'Opaque database sessions (TD-022): 7-day sliding, revocable, addressed by the `token` in the session cookie.';

-- ── accounts ─────────────────────────────────────────────────────────────────
-- One row per credential or external identity a user can authenticate with. `provider_id` is
-- `credential` for email + password; TD-022's OIDC path adds rows here with the issuer's id, which
-- is why the table is separate from `user_identities` (that one maps *ticket* authors to users and
-- can never authenticate anybody, BD-006/Q10).
create table accounts (
  id uuid primary key default uuidv7(),
  account_id text not null,
  provider_id text not null,
  user_id uuid not null references users (id) on delete cascade,
  access_token text,
  refresh_token text,
  id_token text,
  access_token_expires_at timestamptz,
  refresh_token_expires_at timestamptz,
  scope text,
  -- Argon2id hash (TD-022), never a password. Redacted from every API response by never being
  -- selected into one.
  password text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index accounts_user_id_idx on accounts (user_id);
create unique index accounts_provider_account_idx on accounts (provider_id, account_id);

comment on table accounts is
  'Authentication credentials and linked external accounts (TD-022). `password` holds an Argon2id hash.';

-- ── verifications ────────────────────────────────────────────────────────────
-- Short-lived tokens: e-mail verification, password reset. Rows expire and are deleted by Better
-- Auth itself, so there is no partition or retention policy.
create table verifications (
  id uuid primary key default uuidv7(),
  identifier text not null,
  value text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index verifications_identifier_idx on verifications (identifier);

comment on table verifications is
  'Pending e-mail verification and password-reset tokens (TD-022). Rows are short-lived.';

-- ── Storage policy ───────────────────────────────────────────────────────────
-- Every table registers itself with `platform_table_policy` (migration 0001), which is what drives
-- the grant set. `read_write` is the default for an unregistered table, so these four rows change
-- no privilege today — they are here because "the registry lists every table" is only useful as an
-- invariant if it is actually true: the moment one table is missing, the registry stops being
-- readable as the answer to "what may the application do to this table?".
--
-- All four are read_write and none is partitioned. Sessions and verifications expire and are
-- deleted by Better Auth itself rather than by partition retention, and `users`/`accounts` are
-- mutable state, not an audit trail.
insert into platform_table_policy (table_name, app_access)
values
  ('users', 'read_write'),
  ('sessions', 'read_write'),
  ('accounts', 'read_write'),
  ('verifications', 'read_write')
on conflict (table_name) do nothing;
