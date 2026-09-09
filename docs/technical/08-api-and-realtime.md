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
| Webhooks | `POST /webhooks/:provider/:integrationId` (signature verified; 2xx immediately; `inbox`) |
| Events | `GET /events?topics=org,project:<id>,task:<id>,run:<id>` (SSE), `POST /events/subscriptions` (add/remove topics for the connection id) |
| Ops | `GET /healthz`, `GET /readyz`, `GET /metrics` (Prometheus; optional basic auth), `GET /api/version` |

## SSE contract
`event: <type>` from the domain/transcript catalogue; `id: <topic>:<seq>`; `data: JSON`; `retry: 1000`; `: ping` every 20 s; on shutdown `event: shutdown`. Reconnect: `Last-Event-ID` per topic → replay from `events`/`run_messages` (transcript topic replays `run_messages` rows and coalesced partial blocks); if the requested seq is older than the buffer/retention, `event: reset` → client refetches. Partial text deltas are forwarded (coalesced ≥ 50 ms) only for runs with active subscribers; the transcript topic can request `?partials=0`.

## Auth and RBAC
- Session cookie (`__Host-session`), CSRF via SameSite + Origin check + `X-Requested-With`; API keys via `Authorization: Bearer` for scripts (scoped to org actions).
- Roles: org `admin | maintainer | member | viewer`; project membership with the same levels; capability map in `packages/domain/permissions` (e.g. `task.answer_question: member`, `task.approve_plan: maintainer`, `run.steer: member`, `kb.proposal.decide: maintainer`, `project.settings.write: admin`, `budget.write: maintainer`, `transcript.read: member`).
- External identities (Jira, GitLab, Slack) resolved by email to users; unmapped identities cannot trigger actions (BD-006/Q10).

## Rate limits and safety
Per-user rate limits on mutating endpoints; webhook endpoints limited per integration; `POST /api/runs/:id/steer` limited to 1 message per 5 s per user; all human actions recorded in `human_actions` and `config_audit`.
