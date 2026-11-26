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

## Amendment 2026-11-26 — project visibility (BD-035)

BD-035 narrows what a person sees without changing what they may do. Until now, the role was the only answer,
through `can()` and `effectiveRole` (`apps/server/src/auth/rbac.ts:51`). Visibility is a second question, asked
**before** the role, and it answers **404**. Decided:

1. **One function computes the set.** `visibleProjects(actor)` in `apps/server/src/auth/visibility.ts` returns
   `{ all: true }` or `{ all: false, ids }` and contains no other policy. It reads one statement in
   `apps/server/src/queries/project-visibility-queries.ts`, covering three sources:
   - `workers` where `revoked_at is null`, through `claim_project_ids`. A `null` or a legacy `'{}'` means every
     project;
   - `project_members`;
   - `tasks` where `owner_user_id` is the actor and the state is not terminal.

   "Every project" is decided by a new capability, `project.read_all: 'admin'`, in
   `packages/domain/src/permissions.ts`, so `can()` stays the only place a role is compared. The result is memoised
   on the request.
2. **Guarded routes.** A route guarded by `requirePermission(…, { project })` gets its 404 from the guard. This covers:
   - everything under `/api/projects/:project_id/**`. These routes are in `routes/`: `projects`, `settings`, `kb`,
     `bootstrap`, `owner-candidates`, `pipeline-graph`, `project-{bindings,ci-jobs,config,execution,readiness,repository}`,
     `rediscovery`, `shadow`, `task-start`, and `onboarding`'s config, discovery and interview;
   - through `scopeToProject`, everything under:
     - `/api/tasks/:task_id/**`, in `tasks`, `commands`, `asks`, `breakdown` and `pipeline-graph`;
     - `/api/runs/:run_id/**`, in `runs`, `commands` and `downloads`;
     - `/api/artifacts/:artifact_id` (`tasks`);
     - `/api/shadow-batches/:batch_id` (`shadow`).

   On 2026-11-26 each of these route modules passed a `project` hook to every guard of these families. Grep check:
   the `requirePermission(` calls without one were org-scoped routes only.

   The guard's order becomes 401, then 404 for a project that is missing or hidden, then 403. The 404 for a hidden
   project has the same code and message shape as `NotFoundError` for a missing id. `PermissionGuardDependencies`
   gains `visibleProjects`. A guard registered with a `project` hook that is not given this dependency is a
   startup error.
3. **Lists and aggregates take the set as a parameter.** These routes filter in SQL, never after the read:
   - `GET /api/projects` (`routes/projects.ts:541`);
   - `GET /api/org/inbox` and `GET /api/org/agents` (`routes/org.ts:291,255` over `queries/pipeline-queries.ts`);
   - `GET /api/org/stats` and `/stats.csv` (`routes/stats.ts:132,148`; totals too, and `?project_id=` of a hidden
     project is 404);
   - `GET /api/org/audit`, whose project rows are filtered and whose organisation rows are kept;
   - `GET /api/integrations`, whose `used_by` lists only visible projects;
   - `GET /api/integrations/:id/refused-deliveries`, which omits a row whose binding's project is hidden. A row
     that matched no binding belongs to the account and is kept. `setup-guide` and `providers` name no project.
4. **Visible by construction, and asserted.**
   - `GET /api/workers`: a member sees only their own workers, and `policy_skipped_offers` and `idle_reason` lie
     inside each worker's own scope.
     - **Residual:** `running` may hold the id of a run that a pick claimed outside the scope without assigning.
       It is an id only, and opening it is 404.
   - The worker protocol's `GET offers`, which is narrowed by the scope.
   - `GET /api/me/task-limit`, which counts the person's own tasks. Rule 1's ownership source makes those
     visible.
5. **Unchanged, with reasons.**
   - `GET /api/org/budgets` is the organisation's caps and names no project.
   - These are admin-only reads: failed jobs, dead letters, `org/identities`, `org/task-limits` and invites.
   - These name no project: `org/users`, `org/models`, `org`, `version`, `setup-state` and `me/identities` and
     `me/identity-links`. The `me/identity-links/read` route reads a ticket the person names for their own link
     code and returns only the match.
   - `POST /api/projects` is admin-only.
   - The worker protocol's run-token verbs act on the run the worker holds.
   - `offers/:id/claim` is a pick the person makes. It ignores the scope, as TD-031 decision 8 says; the pick makes
     them the owner, so rule 1's ownership source shows them the project afterwards.
   - Webhooks act for no user.
6. **Choosing is not seeing.** The card's list of projects comes from a new session read,
   `GET /api/workers/:id/claim-scope` (own worker only, else 404, the `PUT`'s rule). It is the session twin of the
   worker protocol's `GET claim-scope`: `projects` where the person is `member`+, each with its execution setting
   and `unassigned_has_taker`. The card and the wizard read it instead of `GET /api/projects` and
   `GET /api/projects/:id/execution`. `project_not_eligible` keeps the role rule. This read is the only one that
   names a hidden project, and it names no task. An admin who views somebody else's card still reads
   `GET /api/projects`; that admin sees every project and may not write the card
   (`claim_policy_owner_only`).
7. **The stream.**
   - `sse/topic-access.ts` asks for visibility before `can()`, so `project:`, `task:` and `run:` topics of a hidden
     project are 404, as a missing one is. This applies at `/events` and at `/events/subscriptions`.
   - On the `org` topic, each connection carries the person's set. The hub drops a frame whose `project_id` lies
     outside the set. This applies to replay and to live frames, as the `partials` filter does. A frame with no
     `project_id` is resolved through its `task_id` or `run_id`, and an unresolved frame is dropped for a
     narrowed connection.
   - The set is re-read at every subscription change and is never more than 60 s old. A topic that becomes hidden
     stops receiving frames within that bound, and one that becomes visible again starts. The frames carry ids
     only (S-23.14 decision 3), so this bound is the residual.
8. **Holding it.** A route census in `apps/server/src/routes/visibility-census.test.ts` reads every route the
   server registers through Fastify's `onRoute`. It holds each route to exactly one class from items 2–6, and checks
   both directions, as `client-census.test.ts` does. A new route is unclassified until somebody decides its class.
