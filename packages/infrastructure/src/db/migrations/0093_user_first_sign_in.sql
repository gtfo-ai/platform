-- migration-class: additive
-- 0093 — `users.first_signed_in_at`: when an account first signed in (WP-291).
--
-- The sign-in page names `APP_BOOTSTRAP_ADMIN_EMAIL` only while nobody has signed in to the
-- instance (`GET /api/setup-state`). No existing column could answer that durably: Better Auth
-- deletes a `sessions` row at sign-out and when it finds one expired. The served Better Auth
-- instance's `session.create.after` hook sets this column once per user
-- (`… where id = $1 and first_signed_in_at is null`); the bootstrap's own instance has no hook,
-- because the server creating the operator's account is not the operator signing in.
--
-- **No backfill**: an `update` is not an additive statement (TD-032 §1), and a `contract` file for
-- one hint is the wrong trade. The read covers the instances that predate this column instead —
-- it also answers "not pending" when any `human_actions` row exists, as evidence the instance is
-- in use (`apps/server/src/queries/setup-state-queries.ts`).
--
-- **Additive by its own rule**: a nullable column with no default, which the previous build never
-- names, and Better Auth's adapter neither selects nor writes a column it was not configured with.
alter table users add column first_signed_in_at timestamptz;

comment on column users.first_signed_in_at is
  'When this account first signed in (WP-291); set once by the served instance''s session hook, null until then. Read by GET /api/setup-state.';
