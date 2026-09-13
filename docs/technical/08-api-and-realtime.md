# 08 — API, real-time and auth surface

> Round 2 design. Decisions: TD-002, TD-014, TD-022. Sources: research/11, research/08, product/10.

## Principles
- REST + SSE on one origin; OpenAPI generated from zod route schemas (`@fastify/swagger`); the SPA client is generated from it.
- Every mutating endpoint is a **command** (imperative name), idempotent where a client may retry (`Idempotency-Key` header on POSTs that create).
- Authorisation via `can(actor, action, resource)`; project scoping on every route; audit of every human action.

## Endpoints (v1 outline)
| Area | Endpoints |
|---|---|
| Auth | Better Auth routes under `/api/auth/*` (sign-in, sign-out, session, password reset, API keys, admin user management) |
| Org | `GET/PATCH /api/org`, `GET /api/org/budgets`, `PUT /api/org/budgets/:id`, `GET /api/org/stats?range=…`, `GET /api/org/audit?…`, `GET /api/org/users`, `POST /api/org/users/invite` |
| Integrations | `GET/POST /api/integrations`, `PATCH /api/integrations/:id`, `POST /api/integrations/:id/test`, `GET /api/integrations/:id/setup-guide` |
| Projects | `GET/POST /api/projects`, `GET/PATCH /api/projects/:id`, `GET /api/projects/:id/config` (effective, with sources), `PUT /api/projects/:id/config`, `POST /api/projects/:id/config/export` (to repo MR), `GET /api/projects/:id/readiness`, `POST /api/projects/:id/discovery`, `GET/PUT /api/projects/:id/bindings`, `GET/PUT /api/projects/:id/budgets`, `GET /api/projects/:id/stats` |
| Tasks | `GET /api/projects/:id/tasks?state=…`, `POST /api/projects/:id/tasks` (manual start from ticket key), `GET /api/tasks/:id` (with stages, artifacts, checks), `POST /api/tasks/:id/{pause,resume,cancel,retry-stage,return-to-stage,take-over,hand-back,rework}`, `GET /api/tasks/:id/events`, `GET /api/tasks/:id/export` (JSON), `POST /api/tasks/:id/questions/:qid/answer`, `POST /api/tasks/:id/approvals/:aid/decide`, `POST /api/tasks/:id/feedback`, `POST /api/tasks/:id/ask` (ask-the-task) |
| Runs | `GET /api/runs/:id`, `GET /api/runs/:id/messages?after=<seq>&limit=`, `GET /api/runs/:id/prompt`, `GET /api/runs/:id/context-pack`, `POST /api/runs/:id/{steer,cancel}`, `POST /api/runs/:id/retry` (model/effort override) |
| Agents | `GET /api/org/agents` (running runs) |
| Inbox | `GET /api/org/inbox` (questions + approvals pending for the caller) |
| Knowledge | `GET /api/projects/:id/kb/tree`, `GET /api/projects/:id/kb/doc?path=`, `PUT /api/projects/:id/kb/doc` (creates commit/MR), `GET /api/projects/:id/kb/search?q=`, `GET /api/projects/:id/kb/proposals`, `POST /api/projects/:id/kb/proposals/:pid/{approve,reject,edit}`, `GET /api/projects/:id/kb/health`, `POST /api/projects/:id/kb/bootstrap` |
| Shadow | `POST /api/projects/:id/shadow/runs` (ticket keys, budget), `GET /api/projects/:id/shadow/reports` |
| Webhooks | `POST /webhooks/:provider/:integrationId` (signature verified; 2xx once recorded; `inbox`). **Unauthenticated by design** — the credential is the signature over the body (TD-024), so TD-022's CSRF rule neither applies nor fires (it refuses only a mutating request *carrying a session cookie*). The body reaches the handler **unparsed**, through a content-type parser scoped to this route, because every scheme signs the bytes. Answers: `202 {accepted: true, delivery_id}` performed or already performed; `202 {accepted: false, delivery_id: null}` authentic but unkeyable (a wiki or release hook — a 4xx would have the vendor disable the webhook, standing rule 20); `401` signature; `400` a body that is not a JSON object; `404` an unknown integration id or a provider that does not match it |
| Events | `GET /events?topics=org,project:<id>,task:<id>,run:<id>` (SSE), `POST /events/subscriptions` (add/remove topics for the connection id) |
| Ops | `GET /healthz`, `GET /readyz`, `GET /metrics` (Prometheus; optional basic auth), `GET /api/version` |

> **Five of the Knowledge row's eight endpoints are served** — four since WP-18b and `kb/health`
> since WP-15h part 2 — and the other three are not, which is worth stating because the row reads as
> one surface. Served: `GET …/kb/tree`, `GET …/kb/doc?path=`, `GET …/kb/proposals`,
> `POST …/kb/proposals/:pid/{approve,reject,edit}` and `GET …/kb/health`. Not served, and each for a
> different reason: `PUT …/kb/doc` is a human writing a page, which needs the same commit path the
> Librarian uses plus an editor the SPA does not have; `GET …/kb/search` duplicates the `kb_search`
> platform tool over HTTP and nothing calls it; `POST …/kb/bootstrap` is product/18's history
> bootstrap, which is its own work package. `apps/server/src/routes/client-census.test.ts` is the
> list that is kept true — it compares the client's calls against the router in both directions, and
> **`kb/health` is the one endpoint it cannot see**: no screen calls it, so the census is blind to it
> by construction and `routes/kb.ts` carries the assertion by hand.
>
> **The rest of the read surface is served since WP-15h**: the four run reads, `GET /api/tasks/:id`
> and `GET /api/org/{users,audit}` at part 1, and at part 2 `GET /api/org/agents`,
> `GET /api/org/inbox`, `GET /api/integrations`, `GET /api/integrations/:id/setup-guide`,
> `GET /api/projects`, `GET /api/projects/:id/{readiness,tasks}` — with `readiness` answering
> **409 `readiness_not_evaluated`** while nothing wrote `readiness_evaluations`, the shape
> `/context-pack` established. **WP-21 gave that table its writer**, so the read answers **200**
> for an evaluated project and keeps the 409, with the row count, for one whose discovery run has
> not happened; what a projection over `projects.readiness_level` could answer is still refused,
> because `evaluated_at` and `criteria` would be invented. What is still missing from this document's tables is **most of** the
> command surface and three more reads — `GET /api/org`, `GET /api/org/stats` and `GET …/stats`.
>
> **WP-21 served the onboarding wizard's seven** (product/06): `POST /api/projects`,
> `POST /api/integrations`, `POST /api/integrations/:id/test`, `GET/PUT /api/projects/:id/bindings`,
> `PUT /api/projects/:id/config` and `POST /api/projects/:id/discovery`. Each of the three that
> **create** requires an `Idempotency-Key` and each of the writes records a `human_actions` row.
> Idempotency is **two** mechanisms: a retry is answered from the unique key underneath the command
> (`projects.key`, `(integrations.org_id, type, name)`, `(tasks.project_id, ticket_key, mode)`), and
> a **different** request under a used key is refused `409 idempotency_key_reused` by comparing a
> digest of the canonical request recorded in the `human_actions` row beside the key. There is no
> stored *response*: a legitimate retry is answered by re-reading the resource. What is still unbuilt on those two rows: `PATCH /api/org`,
> `PATCH /api/integrations/:id`, `PATCH /api/projects/:id`, `POST /api/projects/:id/config/export`
> and `GET/PUT /api/projects/:id/budgets`, plus the twelve task and run commands.
>
> **Only part of that list is kept true by a test, and the boundary is worth knowing.** The census is
> **client-driven**: it compares the paths `apps/web/src` names against the router, so it holds the
> twelve task and run commands the SPA calls and does not serve — each with the row that owns it —
> and is blind to everything no client calls. WP-21's seven were never on that list: the client's
> calls and the routes landed in one change, so there was nothing to admit, and they are asserted
> **positively** in the census instead. The four reads above, the writes no screen fires, and any route served but uncalled
> (`kb/health` is the shipped example) are outside it **by construction**, not by omission. This
> paragraph is the only record of those, so it is the one to correct when one of them lands.
>
> **The two reads answer from the index, not from git.** `kb/tree` is the pages the platform has
> indexed at `kb_index_state.commit_sha` and `kb/doc` is a document's chunks re-joined, sanitised at
> parse (technical/07). A page committed since the last index run is not there.
>
> **The knowledge guards run at `preValidation`, not `preHandler`** — Fastify validates before
> `preHandler`, so a route with a required query parameter or a non-uuid path segment would answer
> an anonymous caller `400` describing its own shape instead of `401`. Every other guarded route
> takes only uuids and never noticed.

## SSE contract
`event: <type>` from the domain/transcript catalogue; `id: <topic>:<seq>`; `data: JSON`; `retry: 1000`; `: ping` every 20 s; on shutdown `event: shutdown`. Reconnect: `Last-Event-ID` per topic → replay from `events`/`run_messages` (transcript topic replays `run_messages` rows and coalesced partial blocks); if the requested seq is older than the buffer/retention, `event: reset` → client refetches. Partial text deltas are forwarded (coalesced ≥ 50 ms) only for runs with active subscribers; the transcript topic can request `?partials=0`.

## Auth and RBAC
- Session cookie (`__Host-session`), CSRF via SameSite + Origin check + `X-Requested-With`; API keys via `Authorization: Bearer` for scripts (scoped to org actions).
- Roles: org `admin | maintainer | member | viewer`; project membership with the same levels; capability map in `packages/domain/permissions` (e.g. `task.answer_question: member`, `task.approve_plan: maintainer`, `run.steer: member`, `kb.proposal.decide: maintainer`, `project.settings.write: admin`, `budget.write: maintainer`, `transcript.read: member`).
- External identities (Jira, GitLab, Slack) resolved by email to users; unmapped identities cannot trigger actions (BD-006/Q10).

## Rate limits and safety
Per-user rate limits on mutating endpoints; webhook endpoints limited per integration; `POST /api/runs/:id/steer` limited to 1 message per 5 s per user; all human actions recorded in `human_actions` and `config_audit`.
