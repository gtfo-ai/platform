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
| Org | `GET/PATCH /api/org` (**WP-93**: the organisation settings document — the command, autonomy and WIP maximums, quiet hours and the default chat account, technical/12 § "The organisation settings document"; `GET` is `org.read`, `PATCH` replaces the sections it names and is `org.settings.write`, admin, audited, `Idempotency-Key` optional; a stored document that does not parse is `409 invalid_organisation_config`; a lowered maximum applies at the next read and never moves a task's frozen dial), `GET /api/org/budgets`, `PUT /api/org/budgets/:id`, `GET /api/org/stats?range=…`, `GET /api/org/audit?…`, `GET /api/org/users`, `POST /api/org/users/invite`, `GET/POST /api/org/identities`, `GET /api/org/identities/candidates` (**WP-44**: refused accounts nobody has mapped — a proposal for the mapping form, never a write; `org.users.manage`), `GET /api/org/dead-letters` and `POST /api/org/dead-letters/:position/requeue` (**WP-95**, PROGRESS backlog 126: the events WP-49 dead-lettered — position, type, stream, the handler that spent the bound, attempts, the error **redacted and bounded**, the task the sink escalated or `null`, and `total` beside the page; the re-queue clears `dead_lettered_at` and `attempts` on the **same** queue row under its row lock — nothing is appended and handlers that already succeeded are skipped — refusing `409 event_not_dead_lettered`, `409 event_already_dispatched` or `404`; one `human_actions` row per accepted re-queue, `task_id` the escalated task; `Idempotency-Key` optional and honoured; both `org.dead_letters.manage`, admin) |
| Integrations | `GET/POST /api/integrations`, `PATCH /api/integrations/:id` (**WP-100**: `config` sets keys and `remove` deletes them, and the merged document passes the create's checks — no credential key, declared hosts, the provider's own schema — `400 invalid_integration_config` naming the key paths; `integration.write`), `GET /api/integrations/providers` (**WP-100**: each shipped provider's non-credential `config_fields`, `required` when its schema supplies no default, and its `secret_fields`, read off the provider's schema — what the create form renders; `integration.read`), `POST /api/integrations/:id/test`, `GET /api/integrations/:id/setup-guide`, `GET /api/integrations/:id/refused-deliveries` (**WP-44**: the newest inbound deliveries the platform **refused** — since WP-73b filtered on `inbox.error_reasons`, never an ordinary ignore — with the accounts refused as `unmapped_identity`; `integration.read`) |
| Projects | `GET/POST /api/projects`, `GET/PATCH /api/projects/:id`, `GET /api/projects/:id/config` (effective, with sources), `PUT /api/projects/:id/config`, `POST /api/projects/:id/config/export` (to repo MR, **served since WP-63**), `POST /api/projects/:id/config/refresh` (**WP-63**: re-read the default branch's `.agentic/config.yml`), `GET /api/projects/:id/readiness`, `POST /api/projects/:id/discovery`, `GET/POST /api/projects/:id/rediscovery` (**WP-94**: a maintainer's re-evaluate — `discovery.run`, `Idempotency-Key` required, a new one-off discovery task with every guard the first had; the `GET` publishes the gate, the stage's run budget as the ceiling and the last discovery's cost), `POST /api/projects/:id/interview` (**WP-64**: the wizard's step 3 — one knowledge proposal per answered section, never a commit; `Idempotency-Key` required, `kb.write`), `GET/PUT /api/projects/:id/bindings`, `GET/PUT /api/projects/:id/budgets`, `GET /api/projects/:id/stats` |
| Tasks | `GET /api/projects/:id/tasks?state=…`, `POST /api/projects/:id/tasks` (manual start from ticket key), `GET /api/tasks/:id` (with stages, artifacts, checks), `POST /api/tasks/:id/{pause,resume,cancel,retry-stage,return-to-stage,take-over,hand-back,rework}` (**take-over's stop of a live run is accepted, then applied or refused** — WP-85, TD-028 decision 9: the pause and the stop are recorded in one transaction, the run is found in the database and its id recorded on `task.taken_over`, and the process holding the run applies the stop; the response's `workspace_export: "requested"` is that tense), `GET /api/tasks/:id/events`, `GET /api/tasks/:id/export` (JSON), `POST /api/tasks/:id/questions/:qid/answer`, `POST /api/tasks/:id/approvals/:aid/decide`, `POST /api/tasks/:id/feedback`, `POST /api/tasks/:id/ask` (ask-the-task), `GET /api/artifacts/:id` (one artifact's body, gated at `artifact.read`; **added at WP-52**, and until then `GET /api/tasks/:id` published every artifact with a literal `null` `url` and no route served a body) |
| Runs | `GET /api/runs/:id`, `GET /api/runs/:id/messages?after=<seq>&limit=`, `GET /api/runs/:id/prompt`, `GET /api/runs/:id/context-pack`, `POST /api/runs/:id/{steer,cancel}` (**steer is accepted, then applied or refused** — WP-85, TD-028 decision 9: it answers `202` with the `run_commands` id and never claims the model heard it; the process holding the run applies it and stamps the row, and a command still pending when the run ends is refused `run_ended`; limited to one per five seconds per user **across every process**, read off the user's recorded steers under a per-user advisory lock since WP-101. **Cancel stops the session when a process holds it** — WP-101, TD-028 decision 11: with a live lease it pauses the task, records a `cancel` row for the holder and answers `202` with `command_id`, and the holder interrupts the session and ends the run `cancelled` with the cost the session measured, charged once and not late; if that holder dies first the lease sweep ends the run `lease_expired` and closes the row `run_ended`. With no live lease (absent or expired) it ends the record in place and answers `200` with `command_id: null`. A steer still pending behind a stop is not delivered and is closed `run_ended` by the run's ending), `GET /api/runs/:id/commands` (**WP-85**: the run's steers, take-over stops and — since WP-101 — cancels, newest first, each `pending`, `applied` or `refused` with its reason — what the run screen reads; `transcript.read`), `POST /api/runs/:id/retry` (model/effort override), `GET /api/runs/:id/transcript.jsonl` and `GET /api/runs/:id/export.tar` (**WP-44**, the take-over's two downloads — **served, not copied** (Q93): the transcript is `run_messages` rendered one entry per line through the `/messages` projection, as an attachment, gated at `transcript.read`; the tarball is the launcher's file on the shared export volume read through the SPA's realpath guard, gated at `task.take_over`, kept fourteen days) |
| Agents | `GET /api/org/agents` (running runs) |
| Inbox | `GET /api/org/inbox` (questions + approvals pending for the caller) |
| Knowledge | `GET /api/projects/:id/kb/tree`, `GET /api/projects/:id/kb/doc?path=`, `PUT /api/projects/:id/kb/doc` (creates commit/MR), `GET /api/projects/:id/kb/search?q=`, `GET /api/projects/:id/kb/proposals`, `POST /api/projects/:id/kb/proposals/:pid/{approve,reject,edit}`, `GET /api/projects/:id/kb/health`, `POST /api/projects/:id/kb/bootstrap` |
| Shadow | `POST /api/projects/:id/shadow-batches` (ticket keys), `GET /api/projects/:id/shadow-batches`, `GET /api/shadow-batches/:batch_id` — **amended at WP-34**, and the three differences from the sketch above are each a decision. **`shadow-batches`, not `shadow/runs`**: a *run* is a specific thing in this platform (`runs`, `GET /api/runs/:id`, the `run:<id>` SSE topic), and a shadow batch creates N **tasks**, each of which then has several runs — naming the command after runs would make the word mean two things on one API. **No `budget` in the body**: the cap is `features.shadow_mode.budget_usd` in the project's configuration document, which is where every other per-feature cap lives; taking one per request would give the number two homes and let a caller raise it. **The batch is read by its own id, not per project**: `shadow_reports` is a row per *task*, so *"the project's reports"* is a list with no grouping, and product/19 §13's aggregate is *"per shadow batch"*. The list endpoint additionally publishes `can_start`/`blocked_reason`, so the screen states why a batch cannot be started instead of offering a button that answers 409 |
| Webhooks | `POST /webhooks/:provider/:integrationId` (signature verified; 2xx once recorded; `inbox`). **Unauthenticated by design** — the credential is the signature over the body (TD-024), so TD-022's CSRF rule neither applies nor fires (it refuses only a mutating request *carrying a session cookie*). The body reaches the handler **unparsed**, through a content-type parser scoped to this route, because every scheme signs the bytes. Answers: `202 {accepted: true, delivery_id}` performed or already performed; `202 {accepted: false, delivery_id: null}` authentic but unkeyable (a wiki or release hook — a 4xx would have the vendor disable the webhook, standing rule 20); `401` signature; `400` a body that is not a JSON object; `404` an unknown integration id or a provider that does not match it |
| Events | `GET /events?topics=org,project:<id>,task:<id>,run:<id>` (SSE), `POST /events/subscriptions` (add/remove topics for the connection id) |
| Ops | `GET /healthz`, `GET /readyz`, `GET /metrics` (Prometheus; optional basic auth), `GET /api/version` |

> **`/readyz` answers per process, and a split deployment has two answers (WP-72).** Every role
> reports `database` and `migrations`; every role that holds a job client reports `queue` — which
> since WP-72 is every role, because `ROLE=api` holds an **enqueue-only** pg-boss client it hands a
> command's effect to the workers through (`apps/server/src/enqueue-only-jobs.ts`); every role that
> runs a dispatcher — `all`, `worker`, `runner`, `indexer` — reports `dispatch`, which is `down`
> while the process cannot compose a complete consumer (TD-023's amendment). So a split deployment
> can legitimately show the API process **ready** beside a worker that is **503 for `dispatch`**, and
> `test/e2e/topology/two-processes.e2e.test.ts` asserts exactly that through two processes on one
> database.
>
> **`agent_runs` is about the instance, and `degraded` is still ready (WP-86, PROGRESS backlog
> 135).** Every role that holds a job client also reports `agent_runs`, read from pg-boss's tables
> rather than from the process: it is `degraded` — with `details: {"agent_runs": "unserved"}` — when
> `stage.execute` holds a job that has been eligible for more than five minutes and no process has
> claimed a `stage.execute` job in that time (none active, none started), which is what a deployment
> with no runner looks like; `unknown` when the read failed. A `degraded` report answers **200**, a
> `down` one 503: a missing runner stops agent stages and the platform gates and nothing else, so it
> must not take the API out of a load balancer. The launcher itself is still not reported. The
> matching metrics are `jobs_queued{queue}` (ready, unclaimed jobs per declared queue, `0`
> included) and `jobs_queued_oldest_age_seconds{queue}` (only for a queue with something waiting).

> **Five of the Knowledge row's eight endpoints are served** — four since WP-18b and `kb/health`
> since WP-15h part 2 — and the other three are not, which is worth stating because the row reads as
> one surface. Served: `GET …/kb/tree`, `GET …/kb/doc?path=`, `GET …/kb/proposals`,
> `POST …/kb/proposals/:pid/{approve,reject,edit}` and `GET …/kb/health`. Not served, and each for a
> different reason: `PUT …/kb/doc` is a human writing a page, which needs the same commit path the
> Librarian uses plus an editor the SPA does not have; `GET …/kb/search` duplicates the `kb_search`
> platform tool over HTTP and nothing calls it; `POST …/kb/bootstrap` is product/18's history
> bootstrap, which is its own work package. `apps/server/src/routes/client-census.test.ts` is the
> list that is kept true — it compares the client's calls against the router in both directions.
> `kb/health` was the one endpoint it could not see until **WP-95**: no screen called it, so the
> census was blind to it by construction and carried the assertion by hand. The knowledge screen's
> health panel calls it now (PROGRESS backlog 37), and the census sees it like any other path.
>
> **Two refusals changed shape at WP-57.** `GET …/kb/health` answered a bare **404** for a project
> whose nightly pass has not run yet — the same status and code as a project that does not exist — so
> *"no report yet"* was told apart from *"no such project"* only by prose. It now answers **409
> `kb_health_not_reported`**, and **200 with `findings: []`** is a report that found nothing (rule 18).
> A report can carry a sixth finding kind, `invalid`: a document the parser refused, which is in no
> pack (technical/07 § "Source of truth and sync"). And `GET /api/runs/:id/context-pack` has a
> **success branch**: it answers the record the run's planner built (migration 0041 gave
> `run_context_pack` a writer and the run row the pack's header), **200 with empty tiers** for a run
> whose pack was empty, and keeps **409 `context_pack_not_recorded`**, with the row count, only for a
> run created before that migration.
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
> command surface (the list two paragraphs down) and two more reads — `GET /api/org` (**served
> since WP-93**) and the project-scoped `GET …/stats`. **WP-41 served the organisation's:** `GET /api/org/stats?range=…`
> answers a published DTO (`orgStatsResponseSchema`), and product/10:24's *"CSV export"* is a
> **second path**, `GET /api/org/stats.csv`, which this table does not name — a route cannot
> publish both a strict object schema and a `text/csv` body honestly, so the two representations
> are two routes (Q45 records the shape and the reasoning).
>
> **WP-21 served the onboarding wizard's seven** (product/06): `POST /api/projects`,
> `POST /api/integrations`, `POST /api/integrations/:id/test`, `GET/PUT /api/projects/:id/bindings`,
> `PUT /api/projects/:id/config` and `POST /api/projects/:id/discovery`. Each of the three that
> **create** requires an `Idempotency-Key` and each of the writes records a `human_actions` row.
> Idempotency is **two** mechanisms: a retry is answered from the unique key underneath the command
> (`projects.key`, `(integrations.org_id, type, name)`, `(tasks.project_id, ticket_key, mode)`), and
> a **different** request under a used key is refused `409 idempotency_key_reused` by comparing a
> digest of the canonical request recorded beside the key. There is no stored *response*: a
> legitimate retry is answered by re-reading the resource. **Amended at WP-67:** the record beside
> the key is `command_idempotency`, not the `human_actions` row (next paragraph), and discovery
> claims its key like the task commands do; the two creates keep their natural key and **state a
> divergence** — two *concurrent* creates under one key are stopped by the unique key, and a
> concurrent *different* body is answered with the first resource rather than a `409`. The other
> three wizard writes (`…/test`, `PUT …/bindings`, `PUT …/config`) take no key: a `PUT` is
> idempotent by its own shape and the probe changes nothing a retry could duplicate.
>
> **The idempotency record (WP-67, migration 0053).** `command_idempotency` holds one row per
> `(user_id, action, key)` — the digest of the canonical request, when the key was claimed, and the
> `human_actions` row that recorded the performed command. Until WP-67 the record was that audit
> row, read with a JSON predicate, so two requests that arrived **together** both read "no attempt"
> under READ COMMITTED and both performed. What the header now buys, stated as the contract:
>
> - **Scope** `(user_id, action, key)`, the table's primary key (next paragraph for why the user).
> - **Retention: none.** A key is honoured for as long as the audit it points at is kept, which is
>   forever; a window after which a key is forgotten is a window after which a retry performs twice.
> - **A replay answers the first attempt** — `performed: false` and what the first attempt's audit
>   row recorded (the ids it made), never a second performance and never a second audit row.
> - **A different request digest under a used key** is `409 idempotency_key_reused`, whether the
>   first request performed or is still performing.
> - **Ordering: claim before the effect.** The key's row is committed **before** the command runs,
>   because the effect is an application command in a transaction the route does not hold; a second
>   request under a held key is `409 idempotency_key_in_flight`, a refusal (409, 404, `already`)
>   releases the key, and the audit row completes it. The trade is a double-perform for a key that
>   names a command nobody performed: a process that dies between the claim and the audit row leaves
>   the key claimed, and after five minutes a retry is `409 idempotency_attempt_unknown` — check the
>   resource, use a new key. It is never re-claimed automatically, because that is the double-perform.
>   Where the route **does** hold the effect's transaction (the business interview) the claim is
>   inserted in it instead, and there is no window at all. `apps/server/src/routes/idempotency.ts`
>   carries the argument and the one residual the other way round (an audit insert refused without
>   the process dying releases a performed key).
> - `human_actions` stays append-only and complete, duplicates included; the migration backfilled
>   every keyed row, the **first** of any duplicates winning.
>
> **An `Idempotency-Key` belongs to the caller.** Every lookup, for the wizard's creates and for
> every command below, is scoped `(user_id, action, key)` — the acting user, the command,
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
> takes one of two branches since WP-101 (TD-028 decision 11). **A process holds the run's lease**:
> the task is paused and a `cancel` row is recorded for that process in the same transaction, the
> answer is `202`, and the holder interrupts the session — so the run ends `cancelled` in its own
> process with what the session measured, charged once by the ordinary ledger handler. **No process
> holds it** (the lease absent or expired): the run is ended **as a record** in place and the answer
> is `200`; a session that was in fact still running somewhere (a holder cut off from the database)
> then has its **verdict** discarded, and its **spend** — since WP-47 — written onto the terminal row
> through the narrow `runs.recordCost` and charged from the same transaction, labelled late (Q70
> (b)). What is still unmeasured is a session whose process dies before it reports: a recorded cancel
> is then closed `run_ended` by the lease sweep, whose `run.failed` carries no cost.
> And **no HTTP request escalates a task**: a spent iteration loop and an exhausted write-conflict
> bound are both answered to the caller rather than parking the task in `needs_human`.
>
> What is still unbuilt on those rows: `PATCH /api/projects/:id`. **WP-100 removed
> `PATCH /api/integrations/:id`**: the create parses `config` with the provider's schema, and a row
> written before it — whose configuration every binding load would refuse — publishes a
> `config_refusal` on `GET /api/integrations` and answers `/test` with `409
> invalid_integration_config`, each naming the key paths and this `PATCH` (PROGRESS backlog 328).
> **WP-93 removed `PATCH /api/org`** and served `GET /api/org` beside it: the organisation layer
> the pipeline had composed since WP-63 had no writer but SQL (PROGRESS backlogs 146 (2), 223). Both
> read and write the whole document through one strict schema; `PUT …/autonomy` above its
> `autonomy.maximum` is `409 autonomy_above_organisation`, and `GET …/autonomy` publishes
> `organisation_maximum` and `level_in_force`. The screen is the organisation settings page. **WP-63 removed
> `POST /api/projects/:id/config/export`**: the settings layer as `.agentic/config.yml` plus the
> `CLAUDE.md` pointer, one commit on an `agentic/config/*` branch and a merge request through the
> knowledge apply path's two writes — never a direct commit (Q94 (b)) — with a required
> `Idempotency-Key` whose replay answers the first attempt from its `human_actions` row, and
> `base_hash` refusing a stale export `409 config_conflict`. It added
> `POST /api/projects/:id/config/refresh`, the re-read of the default branch's file, and
> `GET /api/projects/:id/config` now answers `effective` (the merge of the organisation's command
> maximum, the settings and the repository's file, the repository winning — Q94 (a)) and
> `repository` (the reading) beside `config`, which stays the settings layer; a repository file
> that does not parse makes it **409 `invalid_repository_config`** naming the key paths.
> **WP-91 added** to the export a `status: 'open'` answer — the previous export's merge request,
> recorded on its `human_actions` row and re-read through the executor, is still open, so nothing is
> committed or opened (a provider that cannot say refuses the export `409 config_export_unavailable`
> rather than guessing) — and to `GET …/config` `last_export` (the newest export as recorded) and
> `not_applied` (the settings' unread keys, and a WIP limit the organisation's maximum lowered),
> which `PUT …/config` also answers with; a `pipeline.wip` above the organisation's maximum is
> `409 wip_above_organisation`.
> **WP-27 removed three
> of them** — `POST /api/runs/:id/steer` and `POST /api/tasks/:id/{take-over,hand-back}` are served,
> and `POST /api/runs/:id/steer` is the one endpoint this document gives a rate limit to (below).
> **WP-85 made steer and take-over reach a run on the shipped topology** (TD-028 decision 9,
> PROGRESS backlog 134). Until then both looked the run up in the answering process's live-run
> register, and the process that serves the API never holds a run — so every steer answered
> `409 run_not_reachable` and every take-over recorded `run_id: null` and stopped nothing. Now the
> command is **accepted, then applied or refused**: it writes a `run_commands` row in the command's
> own transaction (after reading the run live under a `for share` lock, beside `run.steered` or
> `task.taken_over`), wakes the run's lease holder with `pg_notify` on a topic keyed by
> `runs.lease_owner`, and the holder — which also polls its leased runs' pending rows on every
> lease heartbeat, because a notification is not delivered to a connection that was reconnecting —
> applies it to its in-process register and stamps `applied_at`, or `refused_reason =
> register_miss`; a delivery the closing session refused turns the stamp into `delivery_failed`, never
> back to pending, and an unreadable row is refused `undecodable` by itself. A row still pending when the run ends is closed `run_ended` by the run's ending,
> in its transaction, so it is never applied late. `POST /api/runs/:id/steer` answers **`202`** with
> `command_id`; `run_not_reachable` no longer exists. The take-over's session id is read off the
> run's own `system`/`init` transcript entry, the first place the database learns it.
> **WP-31 removed `POST /api/tasks/:id/ask`** and added two reads this table did not name:
> `GET /api/tasks/:task_id/asks` (the Q&A thread product/10:57 asks for) and
> `GET /api/tasks/:task_id/audit` — the `human_actions` rows of one **task**, which
> `GET /api/projects/:id/audit` can never serve because that predicate is `params->>'project_id'`
> and `human_actions` has no `project_id` column (PROGRESS backlog 52). It also added
> `GET/POST /api/org/identities`, the mapping of a provider account to a platform user: the table
> `user_identities` has had a reader since WP-15c and had **no writer at all**, so every ticket and
> chat author was `unmapped_identity` on every instance (PROGRESS backlog 79). `POST` is `admin`
> (`org.users.manage`), because the mapping decides who may act as whom, and it takes no `email`:
> a match the platform performed itself is the route BD-022 and Q10 refuse. It records a
> `human_actions` row like every other command — *"all human actions recorded"* below applies to the
> one write whose subject is who may act as whom — and it takes **no `Idempotency-Key`**, which is
> the one command in the product that does not: the write is an upsert on the primary key
> `(provider, external_id)`, so a retry creates nothing second, and a *different* body under a used
> key is the re-mapping an operator performs when somebody leaves and must be allowed rather than
> refused. Neither route has a screen, so both are asserted by hand — in `routes/org.test.ts` and,
> for the auth, in the client census. **Since WP-61** the same command also **declares an account a
> machine** — `{provider, external_id, kind: "machine"}` with no `user_id` (PROGRESS backlog 88,
> migration 0045): somebody else's bot, whose merge-request comments and approvals the human-time
> projector then refuses rather than counting as a person reviewing, and which resolves to no user
> anywhere else. It is an operator's statement, never an inference from a name; the published row
> carries `kind` and a nullable `user_id`.
> `POST /api/tasks/:id/ask` requires an `Idempotency-Key` — a repeat starts a second run the project
> pays for — and asking is `task.ask` (**member**, the shipped capability map) while reading the
> thread is `task.read` (viewer) and reading the task audit is `org.audit.read` (maintainer).
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
> outside it **by construction**, not by omission — there are **none** today. The last was
> `kb/health` (WP-18b's report), asserted by hand in the census until **WP-95** gave it the knowledge
> screen's health panel. WP-27's `take-over` and `hand-back` and WP-40's breakdown pair were the
> other four until **WP-44** gave them a screen (the task page's take-over control and breakdown
> panel), and their hand-written census cases were deleted in the same change. This paragraph is the only record of
> that class, so it is the one to correct when one of them gains a caller.
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
- Session cookie (`__Host-session`), CSRF via SameSite + Origin check + `X-Requested-With` (a refusal is `403 cross_site_request`, WP-73d); API keys via `Authorization: Bearer` for scripts (scoped to org actions).
- Roles: org `admin | maintainer | member | viewer`; project membership with the same levels; capability map in `packages/domain/permissions` (e.g. `task.answer_question: member`, `task.approve_plan: maintainer`, `run.steer: member`, `kb.proposal.decide: maintainer`, `project.settings.write: admin`, `budget.write: maintainer`, `transcript.read: member`).
- External identities (Jira, GitLab, Slack) resolved by email to users; unmapped identities cannot trigger actions (BD-006/Q10).

## Rate limits and safety
Per-user rate limits on mutating endpoints; webhook endpoints limited per integration; `POST /api/runs/:id/steer` limited to 1 message per 5 s per user; all human actions recorded in `human_actions` and `config_audit`.

> **As built at WP-101 (PROGRESS backlog 295): the steer limit is one window for the
> installation.** Until WP-101 it was a `Map` in each API process, so N processes serving the API
> admitted N steers per user per five seconds — and since WP-85 every admitted steer is a turn the
> run pays for. Now the command's own transaction takes a `pg_advisory_xact_lock` on the user and
> reads that user's `steer` rows in `run_commands` inside the interval, before it records the new
> one; a second steer through any process waits for the first to commit and is refused
> `429 rate_limited`. No new table: the rows the window counts are the steers it admitted. A steer
> refused for another reason (the run ended, the role) records nothing and so spends no slot.

> **As built at WP-88 (PROGRESS backlog 199): a decision taken in chat is a human action too.** A
> Slack click that approves a plan, or a Slack click or thread reply that answers a question, is
> decided by the Approval or Question aggregate in the webhook delivery's transaction (WP-43), and
> since WP-88 that transaction also writes one `human_actions` row — the mapped user, the task, the
> route's own `action` (`task.approval.decide`, `task.question.answer`) and `params` keys, plus
> `channel`, `provider`, `integration_id` and `delivery_id` — and none for a refused one, the
> command routes' rule. The two command routes now carry `channel: 'ui'` in theirs, so the two doors
> leave one shape. `GET /api/tasks/:task_id/audit` still reads `human_actions` only: the
> alternative, an audit panel that also reads `inbox` rows, was rejected in technical/13's WP-88
> row as two readers of one audit.

> **As built at WP-87 (Q60): the webhook limit.** `POST /webhooks/:provider/:integrationId` takes a
> token from a bucket keyed per `integrations.id` — never global — **after** the integration lookup
> (so a caller cannot grow the set of buckets by inventing ids; that read — the `integrations` row by
> primary key, left-joined to its `bindings` — is what a limited request still costs) and **before**
> the credentials are read and decrypted, the adapters built, the signature checked, and any row
> written.
> Past it the answer is **429** with `Retry-After` in whole seconds, rounded up; the delivery writes
> **no** `inbox` row (the answer an unverified delivery gets) and **no** `integration_actions` row
> (one row per refusal would be the amplification the limit closes), and is counted on
> `webhook_deliveries_rate_limited_total{provider}` with one log line per integration per minute.
> The policy is `DEFAULT_WEBHOOK_RATE_LIMIT_POLICY` (a burst of 120, 10 a second), generous because a
> vendor that keeps receiving errors disables its webhook; it is **per process**, so N API replicas
> admit N times it. A held connection's envelope (Slack Socket Mode) is never limited — the platform
> opened that socket, and limiting what it acknowledged would drop a notification. This note is
> about the webhook clause only; the steer limit is the WP-101 note above, and — unlike this bucket —
> it is shared by every process.
