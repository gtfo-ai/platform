# TD-022 — Auth: Better Auth (email + password, DB sessions, admin, API keys) with Argon2id; own project RBAC with numeric role levels; OIDC-ready schema

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/11, technical/08, product/11, BD-006 (Q10)

## Decision
Better Auth 1.7.x (pinned minor) mounted in Fastify: email/password with Argon2id (`@node-rs/argon2`, OWASP parameters), opaque DB sessions (7-day, sliding, revocable, `__Host-` cookie, SameSite=Lax + Origin/Sec-Fetch-Site check + custom header on mutations), `admin` plugin, `@better-auth/api-key` for PATs (hashed, prefixed for secret scanning). RBAC is our own: `org_memberships` and `project_memberships` with levels viewer 10 < member 20 < maintainer 30 < admin 40 and a pure `can(actor, action, resource)` with an exhaustive test; external identities mapped by email (`user_identities`). Schema is OIDC-ready (`accounts(issuer, provider_account_id)`, `sso_providers` with group→role mappings) so SSO via `genericOAuth`/`@better-auth/sso` is a v0.3 feature without migration. No bundled IdP.

## Amendment 2026-11-26 — invite links (the owner's request)

`technical/08` listed `POST /api/org/users/invite` from the start and nothing served it, so with sign-up off (Q39) the
only way to add a person was Better Auth's admin `create-user` with a password the administrator chose. An
**invite link** replaces that: an administrator makes a one-time link, shares it however they like, and whoever opens
it chooses their own email, name and password. Decided:

1. **Who and what.** `org.users.manage` (admin) creates, lists and revokes links. Each link carries the **role** the
   account gets, chosen at creation (viewer, member, maintainer or admin; member by default). An admin link is
   allowed and the form says what it means: whoever holds it becomes an administrator.
2. **Validity.** `valid_for_hours` 1–720 (24 by default, 30 days at most), counted from the database's `now()`;
   a table check holds `expires_at > created_at`. **One-time**: the first accepted use ends it. Revocable until then.
3. **The token.** 32 random bytes (base64url), **shown once** in the creation response, stored only as its SHA-256.
   The link is `<APP_BASE_URL>/invite#<token>` — in the **fragment**, so it never reaches an access log, a proxy or a
   `Referer` — and the SPA sends it in POST bodies only. Reading a link's state never consumes it.
4. **Accepting.** Public `POST /api/invites/inspect` (`{token}` → role, expiry, state) and `POST /api/invites/accept`
   (`{token, email, name, password}`). The route checks `PASSWORD_MIN_LENGTH`/`PASSWORD_MAX_LENGTH` itself, because
   Better Auth's `create-user` checks no length. Then it **claims first**: one conditional
   `update … where accepted_at is null and revoked_at is null and expires_at > now() returning`, and only a claimed
   link reaches `auth.api.createUser` (server-side, no headers, so no Argon2 runs for an unproven token). A refusal
   from Better Auth (an email already in use) **releases** the claim, so the link stays usable; a crash between the
   two burns the link rather than ever minting two accounts. The browser then signs in through the ordinary
   sign-in route.
5. **The email is unverified** — there is no mailer — and stays a sign-in name only: nothing resolves a person by
   email (BD-022, Q10; `resolveIdentity` has no caller), so typing a colleague's address claims none of their
   identities.
6. **No `Idempotency-Key`** on creation: there is no stored response to replay and the token is shown once; a double
   submit makes two links, each revocable. Every accepted command leaves one `human_actions` row —
   `org.user.invite` (role, hours), `org.user.invite_revoke`, and `org.user.invite_accept` recorded as the new user —
   never the token.
7. **Not in this amendment:** a link bound to an email address, sending the link by email, and `users.status =
   'invited'` (no `users` row exists until a link is accepted). Sign-up stays off (`APP_ALLOW_SIGNUP`).
