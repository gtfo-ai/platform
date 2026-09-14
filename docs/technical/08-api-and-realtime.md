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
> because `evaluated_at` and `criteria` would be invented. What is still missing from this document's tables is **part of** the
> command surface (the list two paragraphs down) and three more reads — `GET /api/org`,
> `GET /api/org/stats` and `GET …/stats`.
>
> **WP-21 served the onboarding wizard's seven** (product/06): `POST /api/projects`,
> `POST /api/integrations`, `POST /api/integrations/:id/test`, `GET/PUT /api/projects/:id/bindings`,
> `PUT /api/projects/:id/config` and `POST /api/projects/:id/discovery`. Each of the three that
> **create** requires an `Idempotency-Key` and each of the writes records a `human_actions` row.
> Idempotency is **two** mechanisms: a retry is answered from the unique key underneath the command
> (`projects.key`, `(integrations.org_id, type, name)`, `(tasks.project_id, ticket_key, mode)`), and
> a **different** request under a used key is refused `409 idempotency_key_reused` by comparing a
> digest of the canonical request recorded in the `human_actions` row beside the key. There is no
> stored *response*: a legitimate retry is answered by re-reading the resource.
>
> **An `Idempotency-Key` belongs to the caller.** Every lookup, for the wizard's three creates and
> for the eleven commands below, is scoped `(user_id, action, key)` — the acting user, the command,
> the string. This paragraph is where that is decided, because the tables above say only that the
> header goes on a command a client may retry: the string is generated per attempt by a client, so
> nothing distinguishes one account's `retry-1` from another's, and an installation-wide lookup
> would refuse a legitimate command because a stranger used the same word and would tell the caller
> that the stranger's command exists. What the scope gives up is stated at
> `findIdempotentAttempt`: two accounts sending one key perform two commands, which the aggregate,
> not the header, is what refuses.
>
> **WP-15i served the eleven task and run commands** — `POST /api/tasks/:id/{pause,resume,cancel,
> retry-stage,return-to-stage,rework,feedback}`, `POST /api/tasks/:id/questions/:qid/answer`,
> `POST /api/tasks/:id/approvals/:aid/decide` and `POST /api/runs/:id/{retry,cancel}`. Each loads
> the aggregate and lets it decide: a move the state machine does not have is **409** naming the
> transition (`illegal_transition`, plus `stage_not_current`, `iteration_limit_reached`,
> `run_not_live` and `task_conflict` for the refusals that are not edges), and each accepted command
> writes one `human_actions` row — **none** for a refused one — carrying the acting user, the
> command's shape, the `Idempotency-Key` and — for `pause` and `take-over` only — the reason the
> person typed, redacted, and naming the **task** in
> `task_id` even for the two commands whose path names a run (that column carries the table's only
> index, so a row without it is one no reader of the table will find). The header is **required** on the
> seven where a repeat would create a second thing (answer, decide, retry-stage, return-to-stage,
> rework, feedback, run retry) and **optional** on the four that are state assertions the aggregate
> already refuses twice over (pause, resume, task cancel, run cancel); a replay under a used key
> performs nothing and answers `performed: false` with the resource's current position. The guard
> asks the **role** and the aggregate asks the **state**, which is why a wrong role is 403 and a
> wrong state is 409. Those refusals are translated **at these routes** and not globally: the same
> `IllegalTransitionError` on a route that reads is this build's bug, not the caller's request, and
> stays a `500` (`apps/server/src/errors.ts`'s `commandRefusal`). Every piece of free text the
> commands take — a question's answer, an approval's reason, a return's reason, rework instructions,
> feedback, a hand-back summary and a steer message — is redacted (TD-012) at the command that
> *decides* it, because the answer is read back into the next prompt and the rest into events any
> projection carries. **Two of them are kept in the audit row and nowhere else**: `task.paused`
> carries the *kind* of pause and `task.taken_over` the branch and the session, so neither event has
> a field for a sentence — the command redacts those two and hands them back for the row rather than
> storing them itself, and the route never reads the request body for an audit field it has not
> redacted (WP-27's fix round; before it, `/pause` promised the record and wrote nothing and
> `/take-over` accepted a `reason` and dropped it).
>
> Two limits of that surface are the product's rather than the code's. `POST /api/runs/:id/cancel`
> ends the run **as a record** and pauses its task; it cannot interrupt the model's session, because
> reaching a live run from another process is Q52's unbuilt transport — the session ends on its own
> and its outcome is then discarded, which is also why a cancelled run's spend is not accounted for.
> And **no HTTP request escalates a task**: a spent iteration loop and an exhausted write-conflict
> bound are both answered to the caller rather than parking the task in `needs_human`.
>
> What is still unbuilt on those rows: `PATCH /api/org`,
> `PATCH /api/integrations/:id`, `PATCH /api/projects/:id`, `POST /api/projects/:id/config/export`
> and `POST /api/tasks/:id/ask` (WP-31). **WP-27 removed three
> of them** — `POST /api/runs/:id/steer` and `POST /api/tasks/:id/{take-over,hand-back}` are served,
> and `POST /api/runs/:id/steer` is the one endpoint this document gives a rate limit to (below).
> **WP-30 removed `GET/PUT /api/projects/:id/budgets`** and added four endpoints this table did not
> name: `GET/PUT /api/projects/:id/autonomy` (the materialised dial, BD-027), `GET /api/projects/:id/audit`
> (the `human_actions` rows of a project's settings — the table row 8 promises an audit of and that
> nothing read) and `GET/PUT /api/org/budgets`. The organisation budget is keyed by **window** rather
> than by the `:id` row 14 sketches, because an id-keyed write has no creator and
> `unique nulls not distinct (scope, scope_id, "window")` is the natural key the table already
> carries; the deviation is stated at `apps/server/src/routes/settings.ts`.
>
> **Only part of that list is kept true by a test, and the boundary is worth knowing.** The census is
> **client-driven**: it compares the paths `apps/web/src` names against the router, so its admitted
> gaps are the paths the SPA calls and the server does not serve — each with the row that owns it —
> and it is blind to everything no client calls. Since **WP-27** there are **none**: the list is
> empty, and the equality is asserted in both directions, so a new client call with no route fails
> whether or not anybody remembers to add an entry. WP-21's seven were never on that list: the
> client's calls and the routes landed in one change, so there was nothing to admit, and they are
> asserted **positively** in the census instead, as the eleven commands of WP-15i and WP-27's steer
> now are. The reads above, the writes no screen fires, and any route served but uncalled are
> outside it **by construction**, not by omission — there are **three** of those today: `kb/health`
> (WP-18b's report, which no screen asks for) and WP-27's `take-over` and `hand-back`, whose buttons
> are a UI row of their own. All three are asserted by hand in the census beside the automatic half.
> This paragraph is the only record of that class, so it is the one to correct when one of them
> gains a caller.
>
> **The two reads answer from the index, not from git.** `kb/tree` is the pages the platform has
> indexed at `kb_index_state.commit_sha` and `kb/doc` is a document's chunks re-joined, sanitised at
> parse (technical/07). A page committed since the last index run is not there.
>
> **The knowledge guards run at `preValidation`, not `preHandler`** — Fastify validates before
> `preHandler`, so a route with a required query parameter or a non-uuid path segment would answer
> an anonymous caller `400` describing its own shape instead of `401`. The wizard's commands (WP-21)
> and the fourteen task and run commands (WP-15i, WP-27) are there for the same reason one step further: they
> all take a **body**, which Fastify validates before `preHandler` too. Every remaining guarded route
> takes only uuids and never noticed.

## SSE contract
`event: <type>` from the domain/transcript catalogue; `id: <topic>:<seq>`; `data: JSON`; `retry: 1000`; `: ping` every 20 s; on shutdown `event: shutdown`. Reconnect: `Last-Event-ID` per topic → replay from `events`/`run_messages` (transcript topic replays `run_messages` rows and coalesced partial blocks); if the requested seq is older than the buffer/retention, `event: reset` → client refetches. Partial text deltas are forwarded (coalesced ≥ 50 ms) only for runs with active subscribers; the transcript topic can request `?partials=0`.

**Responses are compressed and the stream is not** (TD-002, WP-15j round 2). `@fastify/compress` is registered globally, so every route's JSON, `/metrics` and `/openapi.json` arrive `br` or `gzip` for a client that accepts one. **`/events` is never coded** — a compressed SSE response buffers in the compressor, and the frame the hub wrote is then a frame the browser has not received. Three things see to that and only one is ours: `@fastify/sse` commits the response by writing to `reply.raw`, so no `onSend` hook sees an SSE payload at all; the compressor's default type table excludes `text/event-stream`; and the route carries `compress: false`, which is this constraint stated in our own code and which, measured by mutation, decides nothing today. What is asserted is therefore the **outcome**, over a socket, including on an instance configured to compress every content type (`apps/server/src/web/compression.test.ts`). Two more decisions there: `/api/auth/*` is excluded as well (its bodies are the only ones on this origin carrying a bearer credential), and request **de**compression is off, so no endpoint — least of all the signature-verifying `/webhooks/*` — inflates a body a caller sent.

## Auth and RBAC
- Session cookie (`__Host-session`), CSRF via SameSite + Origin check + `X-Requested-With`; API keys via `Authorization: Bearer` for scripts (scoped to org actions).
- Roles: org `admin | maintainer | member | viewer`; project membership with the same levels; capability map in `packages/domain/permissions` (e.g. `task.answer_question: member`, `task.approve_plan: maintainer`, `run.steer: member`, `kb.proposal.decide: maintainer`, `project.settings.write: admin`, `budget.write: maintainer`, `transcript.read: member`).
- External identities (Jira, GitLab, Slack) resolved by email to users; unmapped identities cannot trigger actions (BD-006/Q10).

## Rate limits and safety
Per-user rate limits on mutating endpoints; webhook endpoints limited per integration; `POST /api/runs/:id/steer` limited to 1 message per 5 s per user; all human actions recorded in `human_actions` and `config_audit`.
