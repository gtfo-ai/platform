# TD-022 — Auth: Better Auth (email + password, DB sessions, admin, API keys) with Argon2id; own project RBAC with numeric role levels; OIDC-ready schema

- **Status:** accepted
- **Date:** 2026-08-28
- **Relates to:** research/11, technical/08, product/11, BD-006 (Q10)

## Decision
Better Auth 1.7.x (pinned minor) mounted in Fastify: email/password with Argon2id (`@node-rs/argon2`, OWASP parameters), opaque DB sessions (7-day, sliding, revocable, `__Host-` cookie, SameSite=Lax + Origin/Sec-Fetch-Site check + custom header on mutations), `admin` plugin, `@better-auth/api-key` for PATs (hashed, prefixed for secret scanning). RBAC is our own: `org_memberships` and `project_memberships` with levels viewer 10 < member 20 < maintainer 30 < admin 40 and a pure `can(actor, action, resource)` with an exhaustive test; external identities mapped by email (`user_identities`). Schema is OIDC-ready (`accounts(issuer, provider_account_id)`, `sso_providers` with group→role mappings) so SSO via `genericOAuth`/`@better-auth/sso` is a v0.3 feature without migration. No bundled IdP.
