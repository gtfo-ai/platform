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
| Org | `GET/PATCH /api/org` (**WP-93**: the organisation settings document — the command, autonomy and WIP maximums, quiet hours and the default chat account, technical/12 § "The organisation settings document"; `GET` is `org.read`, `PATCH` replaces the sections it names and is `org.settings.write`, admin, audited, `Idempotency-Key` optional; a stored document that does not parse is `409 invalid_organisation_config`; a lowered maximum applies at the next read and never moves a task's frozen dial; **WP-113**: the `PATCH` answer's `capped_projects` names every project whose autonomy level or WIP limit **in force** the write lowered, before and after, computed from the project rows the write's own transaction read — `[]` when nothing fell, which raising a maximum always answers, and `null` on an `Idempotency-Key` replay; unbounded by design — at most three entries per project the organisation has (the autonomy level and the two WIP limits), in the answer and in its audit row (WP-113 review round 1)), `GET /api/org/budgets`, `PUT /api/org/budgets/:id`, `GET /api/org/stats?range=…`, `GET /api/org/audit?…`, `GET /api/org/users`, `POST /api/org/users/invite`, `GET/POST /api/org/identities`, `DELETE /api/org/identities/:provider/:external_id` (**S-26.6**: an admin's unlink of a person's or a machine's mapping, whoever linked it; `org.users.manage`; `404 identity_not_found`; one `human_actions` row `org.identity.unmap`), `GET /api/org/identities/candidates` (**WP-44**: refused accounts nobody has mapped — a proposal for the mapping form, never a write; `org.users.manage`; **S-26.6**: also the unlinked tracker assignees of live tasks off `tasks.ticket_assignee`, never a `platform` one, with `assigned_tasks` and the tracker's untrusted `display_name`, `deliveries: 0` for an account seen only as an assignee), `GET /api/org/dead-letters` and `POST /api/org/dead-letters/:position/requeue` (**WP-95**, PROGRESS backlog 126: the events WP-49 dead-lettered — position, type, stream, the handler that spent the bound, attempts, the error **redacted and bounded**, the task the sink escalated or `null`, and `total` beside the page; the re-queue clears `dead_lettered_at` and `attempts` on the **same** queue row under its row lock — nothing is appended and handlers that already succeeded are skipped — refusing `409 event_not_dead_lettered`, `409 event_already_dispatched` or `404`; one `human_actions` row per accepted re-queue, `task_id` the escalated task; `Idempotency-Key` optional and honoured; both `org.dead_letters.manage`, admin), `GET /api/org/failed-jobs?limit=&cursor=` (**WP-108**, PROGRESS backlog 325: the jobs pg-boss moved to `failed` after their last retry, newest first — **WP-114** (backlog 324): paged by an opaque `next_cursor`, a keyset over the failed instant at microsecond precision and the job id, `null` on the page that reached the oldest; the SPA's *Show older* follows it, as it does the dead letters' `next_cursor` — queue, attempts, retry limit, the two instants, the failure's message **redacted and bounded**, and the census row of the queue (`exhaustion`: `bounds_itself`/`relies_on_retries`, since **WP-124** its declared `shape` — `recovery_row`, `bound_and_escalate`, `notification_shaped`, or `per_duty` for `pipeline.outbound` (TD-004's M7 amendment) — what a failed job drops, what recovers it; `null` for an undeclared queue) — with `total` beside the page; the payload is never published and there is **no** re-queue; `org.dead_letters.manage`, admin; `503 failed_jobs_unavailable` on a process that reads no job queue) |
| Integrations | `GET/POST /api/integrations` (**S-23.23**: the list carries `can_write`, `integration.write` over the caller's organisation role — the write routes' own `can()` — so the screens offer the writes only to an administrator; absent reads `false`), `PATCH /api/integrations/:id` (**WP-100**: `config` sets keys and `remove` deletes them, and the merged document passes the create's checks — no credential key, declared hosts, the provider's own schema — `400 invalid_integration_config` naming the key paths; `integration.write`), `GET /api/integrations/providers` (**WP-100**: each shipped provider's non-credential `config_fields`, `required` when its schema supplies no default, and its `secret_fields`, read off the provider's schema — what the create form renders; **WP-114**: each field's `kind` (`string`, `integer`, `number`, `boolean`, `string_list`, `choice` with its `choices`, `other`), so the forms offer the optional fields with typed controls; `integration.read`), `POST /api/integrations/:id/test`, `POST /api/integrations/:id/secrets` (**WP-114**, PROGRESS backlog 331: **re-seals** credentials — `secret_refs` maps a credential field to the **name** of an environment variable on `APP_INTEGRATION_SECRET_ENV`, exactly as on the create; the server reads and seals the value into a new `secrets` row and deletes the named field's old one, a field not named keeps its own, `health` resets to `unknown`; `Idempotency-Key` **required**, a replay answers `performed: false` and seals nothing; `403 secret_name_not_permitted`, `400 missing_secret`; one `human_actions` row naming fields, never values; `integration.write`), `DELETE /api/integrations/:id` (**WP-114**: **retires** — deletes the integration's `secrets` rows, empties `secret_ids` and `health`, sets `retired_at` and **keeps the row**, because `integration_actions.integration_id` is a `NOT NULL` foreign key and the audit names the credential each call used (BD-003); refused `409 integration_bound` while a project binds it and `409 integration_has_live_credential` while a minted run credential of it is unexpired and not confirmed revoked (TD-028 decision 10), and `409 integration_is_organisation_default` while `notifications.organisation_default` names it (a mint in flight across the retire is revoked by the mint itself, backlog 386), the check and the retire one transaction under the integration's row lock, which a bind takes `for share`; a repeat answers `performed: false`; a retired integration is listed with `retired_at`, is never loaded, and every write to it — `PATCH`, `/test`, `/secrets`, a binding — is `409 integration_retired`, its name staying taken (`409 integration_name_retired` on a create); `integration.write`), `GET /api/integrations/:id/setup-guide`, `GET /api/integrations/:id/refused-deliveries` (**WP-44**: the newest inbound deliveries the platform **refused** — since WP-73b filtered on `inbox.error_reasons`, never an ordinary ignore — with the accounts refused as `unmapped_identity`; `integration.read`). **WP-137** (a static run credential, TD-028 decision 13): the create, the `PATCH` and the re-seal refuse a broken one by name — `400 run_credential_refused` (no `run_token`, the API token as the run token, an expiry passed or more than 90 days ahead; `static` beside `mint_credentials: true` or without a username or expiry is `400 invalid_integration_config`) — and the bindings `PUT`, or a `PATCH` into `static`, refuses a second project's binding with `409 static_run_credential_shared`; `POST /api/integrations/:id/test`'s `checks` carries `run_credential` beside `connection` for such an integration (the run-token user's role on the one bound project, read with the API token; refused below the push role or above Developer; `ok` is every check's). **WP-141** (TD-028 decision 13a): for `run_token_owner: operator` — refused as `400 invalid_integration_config` beside anything but `static` — `run_credential` is instead the scope proof (one `GET /user` with the run token; passes only on `403`) and a third check, `default_branch_protection`, reads the bound project's default branch (push "No one", force push off). **WP-146** (TD-028 decision 13b): `run_credential: deploy_key` (gitlab.com only) — refused by name at the create and the re-seal as `400 run_credential_refused` (no `run_ssh_private_key`, a passphrase, a key that is not Ed25519 or not `run_ssh_public_key`'s, a `run_token` beside it) or `400 invalid_integration_config` (beside `mint_credentials: true`, a public key that is not an Ed25519 line, a self-managed `base_url`), and bound by one project only (`409 static_run_credential_shared`); its probe's `run_credential` reads the bound project's deploy keys for the public key **with write access** and `default_branch_protection` requires push "No one" (no deploy key admitted), both with the API token. **WP-157** (PROGRESS backlog 413): each item of `GET /api/integrations` carries `credentials_readable` — `true`/`false` for a live organisation communication account by whether its sealed credentials decrypt, `null` (*not checked*) for every other row and on the commands' answers — and `credentials_consequence`, the platform sentence for `false` (*the prompt files of every project are withheld*), else `null`; neither carries a value. **S-25.3** (product/08's 2026-11-06 amendment): each item — and every command's answer that returns one — also carries `activity` (the newest outbound call that reached the provider, `{at, ok}`, and the newest verified inbound delivery's instant, from `integration_actions` and `inbox`), `current_health` (`working`, `degraded`, `failing`, `not_checked_recently` or `never_checked`, with the `basis` — `call`, `delivery` or `probe` — and instant that decided it, derived server-side against `INTEGRATION_HEALTH_STALE_AFTER_HOURS` = 24, so a probe older than the bound with nothing since is never `working`) and `used_by` (each binding project's id, key and name, with `uses`: the provider's identifying settings for it from the catalogue's `usageFields`, never a credential); `health` stays the last probe alone |
| Projects | `GET/POST /api/projects` (**S-23.23**: the list carries `can_create`, `project.create` over the caller's organisation role, the create route's own `can()`; absent reads `false`), `GET/PATCH /api/projects/:id`, `GET /api/projects/:id/config` (effective, with sources; **WP-181**: `status_mapping_superseded`, required — `true` exactly when the project's task-management binding maps a lifecycle slot other than `pick_up_from`, asked of the same reading the pipeline's settings port makes, so `status_mapping` is not applied (TD-029 decision 3) and the screen warns beside the key; `false` for no binding, two bindings or a block that fails its schema, which the pipeline also reads as no lifecycle; **WP-113**: `repository.prompts` is the reading's prompt half — per file under `.agentic/prompts/` the path, status, pre-cut length and whether the 8 000-character cut applies, never the text, `null` when the reading holds no prompt directory — and `stage_prompts` is the planner's own resolution of each agent stage's `prompt`/`prompt_append`: the path, whether the configuration names it, the status a run would render and whether it is given; **WP-121**: `repository.prompts_withheld` is why the reading serves no prompt text — the sentence and the integrations whose credentials could not be decrypted, or a reading stored before exact-value redaction that has not been read again — and `null` when nothing was withheld; **WP-125**: its `409 invalid_stored_config` names an unknown key by zod's message under the key's parent path or `(root)`, never by the parent's value, and says how many knowledge curations of the project's finished tasks the refused document holds back, each re-offered at every recovery interval until it parses), `PUT /api/projects/:id/config`, `POST /api/projects/:id/config/export` (to repo MR, **served since WP-63**), `POST /api/projects/:id/config/refresh` (**WP-63**: re-read the default branch's `.agentic/config.yml`, and since WP-92 `.agentic/prompts/` with it; the answer's `repository` carries the same prompt half as `GET …/config`), `GET /api/projects/:id/readiness` (**WP-143**: `notices` — the CI-rules warning `ci_rules_skip_agent_branch` or note `ci_rules_not_seen`, `{code, severity, message}`, untrusted `message`; `[]` when there is none; since BD-026's 2026-10-06 amendment also the note `verification_mode_ci_suggested`, and each criterion's `not_checked` — a not-checked criterion is never in `next_improvements`; **WP-181** (BD-031 ruling 7, product/17's 2026-10-08 amendment): after the stored notices, one note `lifecycle_slot_unmapped` per ticket lifecycle slot the task-management binding leaves empty, or one `lifecycle_not_configured` for a binding with no `lifecycle` block — computed from the binding at the read, never stored, platform text, never a criterion and never a level; none for a project with no task-management binding; and, Q118 (a), the note `binding_account_is_a_person` when the binding's own account is mapped in `user_identities` as a person — the account is read through the executor (`selfIdentity`) by `PUT …/bindings` and stored on the binding (`bindings.account_identity`, migration 0090), so **this read makes no provider call** (WP-181 review round 2); a person's token stays allowed and is named, an account the save could not read is unknown and adds nothing), `POST /api/projects/:id/discovery`, `GET/POST /api/projects/:id/rediscovery` (**WP-94**: a maintainer's re-evaluate — `discovery.run`, `Idempotency-Key` required, a new one-off discovery task with every guard the first had; the `GET` publishes the gate, the stage's run budget as the ceiling and the last discovery's cost; **WP-124**: and `last_discovery.findings_unrecorded` — the instant and platform sentence when the recovery pass re-asked for that discovery's recording once and gave up, `null` otherwise; **WP-155**: and `last_discovery.escalation` — `{at, reason, brief}` off that task's newest `task.escalated` event, published only while it is `needs_human` and `null` otherwise, which the wizard's step 2 shows; the brief is rendered as untrusted text; **WP-168**: the brief is bounded at 1 000 characters (UTF-16 code units, `NOTIFICATION_DETAIL_MAX`, the chat notification's bound on the same brief) — the read cuts a longer one with no marker — and `brief_original_chars` is its length before the cut, `null` when nothing was cut, which the wizard announces as *shortened from N characters* in its own text), `POST /api/projects/:id/interview` (**WP-64**: the wizard's step 3 — one knowledge proposal per answered section, never a commit; `Idempotency-Key` required, `kb.write`; **WP-109**: a re-submission discards the earlier undecided page of each re-answered section with a reason, and four lost races on the project stream in a row answer the retryable **`409 project_stream_contended`**, never a 500), `GET/PUT /api/projects/:id/bindings` (**WP-148**: the PUT keeps an unchanged binding's row and its poll state — cursors and default-branch head — and starts a new one fresh; an integration named twice is `400 invalid_request`; **WP-181** (TD-029 decision 1, BD-031 ruling 7): a task-management binding whose effective `lifecycle` block names a status — `pickup_status`, the `pick_up_from` slot, included — is checked **before** anything is written against the statuses of the binding **as proposed** (the account the request names with the overlay it carries), read through `IntegrationActionExecutor`: a name the tracker does not list, compared case-insensitively, is `422 lifecycle_status_unknown` with one `details` entry per name, its `path` the binding key (`lifecycle.in_review`, `lifecycle.returned[1]`, `pickup_status`) and its message the slot and the name; a tracker that cannot be read — or a process with no integration stack — is `503 lifecycle_statuses_unavailable`; either leaves the stored bindings unchanged and records no `human_actions` row; the write's own refusals — credential keys, undeclared hosts, the provider's schema, a slot naming `pickup_status` — come first, so no provider is asked about a binding the write would refuse; a block that names no status, and a binding with no block, need no statuses read: every slot may be empty; since WP-181's review the write also reads each task-management binding's own account (`selfIdentity`) after its own checks and stores it as `bindings.account_identity` for the readiness note — a failed read stores `null` (unknown) and never refuses the save), `GET /api/projects/:id/ticket-statuses` (**WP-181**, its caller WP-182's pick lists: the tracker's statuses as the saved task-management binding's `listStatuses()` answers them — `{items: [{id, name, category: todo|in_progress|done|unknown, raw_category}]}`, untrusted provider text, at most `MAX_TICKET_STATUSES` (500; a tracker past it is refused at the port, never cut) — read through the executor as `list_statuses`; `project.pipeline.write` (maintainer, WP-139's reading); `409 no_task_management_binding` when the project has none, `503 lifecycle_statuses_unavailable` when the tracker cannot be read, never an empty list; the bindings pair moved to `apps/server/src/routes/project-bindings.ts` beside it), `GET/PUT /api/projects/:id/budgets`, `GET /api/projects/:id/spend?window=day|week|month|total` (**S-25.7**: the Budgets tab's breakdown — the project's booked cost since the window's start the budgets read uses (`budgetWindowStart`, organisation timezone; `month` when omitted) and compared with `cost_entries.created_at`, the row's write time — a budget is charged at the run's ending event, so a run that ended just before a window turned and was booked just after it falls in different windows on the two reads per stage, most first — `stage: null` for spend outside a stage, an ask, which the ledger books as `'(none)'` — and its five most expensive tasks with ticket key, title and mode; each line's `estimated_usd` is the part the platform priced (`cost_entries.is_estimate`); a projection over `cost_entries`, so a run nothing could price is in no figure; `project.read`, guarded at `preValidation`), `GET /api/projects/:id/stats`, `GET /api/projects/:id/repository` (**WP-139**: the stored `default_branch` beside the git provider's own answer — its default branch and where its CI configuration lives, `repository`/`external`/`unknown` — read through `IntegrationActionExecutor`; `provider: null` with `provider_unavailable` when there is no git binding or the read failed; `live_tasks`, what the change would refuse on), `PUT /api/projects/:id/default-branch` (**WP-139**: `{default_branch}`, a git branch name — the same rule `POST /api/projects` applies; maintainer (`project.pipeline.write` — the ruling named `project.settings.write`, which is admin on this build, so the role decided over the name, as WP-94 did); `Idempotency-Key` optional and honoured; one `human_actions` row `project.default_branch.write` with `before`/`after`; **`409 project_has_live_tasks`** while any of the project's tasks is not `done` or `cancelled`; **WP-142**: an accepted change clears the project's poll baseline (`bindings.mr_poll_default_head`) in its transaction and, once committed, requests a `knowledge.index` run of the new branch — a failed request is logged and the next task start requests one; **WP-147**: the transaction also marks the project's `project_repository_config` reading (the old branch's) `invalid` with a detail naming the change, so every run is refused `repository_config_invalid` until the new branch is read; once committed the new branch's `.agentic/config.yml` is read and a readiness re-check is enqueued pinned to the commit read, before any index run — the response waits on that read (a mirror fetch); a failed reading is logged and the change stands), `GET/PUT /api/projects/:id/execution` (**WP-278**, TD-031 decision 8: where the project's agent runs execute — `mode` `server_only`/`workers_only`/`hybrid`, `prefer`, `fallback_after_seconds` (`null` = the preference's default, 15 s / 300 s), `assignee_window_seconds`, `offer_timeout_seconds`; the `GET` (`project.read`) adds `effective_fallback_after_seconds`, `stored` (`false` = TD-031 §8's defaults), `server_claimant` `running`/`none` (a fresh `server_claimants` row anywhere on the instance) and a platform `notice` saying what no server claimant does to the mode; the `PUT` is the whole setting, strict, administrator (`project.settings.write`), `Idempotency-Key` optional and honoured, one `human_actions` row `project.execution.write` with `before`/`after`; it routes offers written after it. Never a key of `.agentic/config.yml`, whose schema refuses `execution` by name) |
| Tasks | `GET /api/projects/:id/tasks?state=…`, `POST /api/projects/:id/tasks` (manual start from a ticket key — **served since WP-122**, product/04 S0's manual "Start": `task.create`, member; `{ticket_key}` only, letters, digits, `.`, `_`, `-`, at most 64; `Idempotency-Key` required, claimed before the read, so a replay answers `performed: false` and reads nothing; the ticket is read **outside any transaction** through the project's task-management binding and `IntegrationActionExecutor`, then **one transaction** appends the same `ticket.matched` intake consumes, with `rule: "manual"` and the user as actor, and the `human_actions` row `task.start`; `202 {performed, event_id, ticket}` names the match, not a task — the pick-up rule is bypassed and **nothing else**: intake applies the WIP limits (above them the task is `queued`), the protected-branch check, the issue type's template and one task per ticket; refusals record nothing — `409 no_task_management_binding`, `409 project_does_not_pick_up_tickets` (the dial is Observe, whose intake would drop the match silently), `409 ticket_has_task`, `409 ticket_outside_binding_scope` (the binding declares the provider projects it reads — Jira's `project_keys`, the filter its webhook applies — and the ticket, judged by the key the provider answered, is outside them; the refusal names the list; a provider or binding that declares no scope admits any key), `404 ticket_not_found`, `502 ticket_unreadable`; the `task.start` audit row has `task_id` **null** — no task exists when it commits, intake creates one later in its own job — and `human_actions` is append-only, so it stays null; since **WP-134** (PROGRESS backlog 416) every task audit read — `GET /api/tasks/:id/audit`, the export and `get_task_context`'s `audit` — also returns the one `task.start` row whose `params.event_id` is the task's originating `ticket.matched` (the `task.created` event's cause, or the lost match a reconciled one re-emitted) in the task's project, so *Who did what* lists the person who started the task; since **WP-134** (backlog 418) one task per ticket is decided by the provider's **stable id** where it sends one (`TicketRef.id`, Jira's numeric issue id; `tasks.ticket_id`, migration 0077) and by the key otherwise, so a Jira issue moved to another project — which Jira answers under its new key — meets the task created under its old key, on this door and the webhook's (`409 ticket_has_task` here, nothing started there); the residual is a task created before migration 0077, which recorded no id and is still judged by its key), and `GET /api/projects/:id/tasks` carries `can_start_task` for the caller (and, since S-23.9a, `can_cancel_task` and `can_return_to_stage`, the same `can()` over `task.cancel` and `task.return_to_stage`, once per page; since S-23.23 `can_pause_task` and `can_resume_task` over `task.pause` and `task.resume`) — and, since **S-23.9a**, each item is the task record plus the board card's glance, read over the page's ids: `stages` (the task's entered `task_stages` rows, `{stage, attempt, state, entered_at}`, oldest first), `open_questions` and `pending_approvals` (the inbox's predicates, per task) and `loop_limits` (the task's frozen iteration limits over the defaults, `null` when the stored limits do not parse), all four required — `GET /api/tasks/:id` (with stages, artifacts, checks; **WP-181**: every task record — here and on the task page — publishes `ticket_claim` (`{status: confirmed|shadow, claimed_at, released_at}` off `tasks.ticket_claim`, `null` for a task that never claimed) and `qa_stage` (`tasks.qa_stage`), both required; since **S-26.1** (migration 0104) every task record also publishes `owner` (`{user_id, name}` or `null`), `owner_source` (`tracker` | `platform` | `null`), `unlinked_assignee` (`{display_name}` — untrusted provider text, redacted and bounded at the write — non-null exactly when the ticket is held elsewhere) and `owner_writes_back` (**S-26.3**, about the **current** owner: `true` exactly when the project's task-management binding sets `lifecycle.assign_owner` — the reading the pipeline applies — and the task's owner has a `person` identity for the ticket's provider, so a platform assignment will also assign the ticket in the tracker; `false` for a shadow task and a platform-issued ticket, whose write-back would write nothing), optional on the wire only for the SPA's older fixtures, and `GET /api/projects/:id/tasks?owner=me|none` filters by the caller's own tasks or the unowned ones; `GET /api/tasks/:id` carries `can_take`, `can_assign` and `can_unassign`, the domain's `ownerCapabilities` — the owner route's own matrix — over the caller and that record, and since **S-26.3** `take_writes_back`, whether *Take it* by this caller would also assign the ticket in the tracker (the write-back duty's own predicate, `ownerWriteBackReachesTracker`, over the caller's `person` identity for the ticket's provider — so it can be true on a task held only by an unlinked assignee, where `owner_writes_back`, which is about the current owner, is false), all four dropped by the export with every other caller fact; since **WP-131** a task record carries `unmeasured_runs`, the runs its `cost_actual_usd` excludes because nobody measured them, `budget_cap_usd`, the cap in force, `paused_reason` and `paused_budget_scope`; the response carries `can_raise_budget` and, since WP-122, `can_export` for the caller — and since **S-23.23** `can_pause`, `can_resume`, `can_cancel`, `can_return`, `can_rework` and `can_decide_approval`, each the command route's own permission (`task.pause`, `task.resume`, `task.cancel`, `task.return_to_stage`, `task.rework`, and the decide route's `task.approve_plan`) over the caller's effective role in the task's project, one table in `routes/tasks.ts` (`TASK_CALLER_FACT_ACTIONS`); the export carries none of them), `POST /api/tasks/:id/budget` (**WP-131**: raise this task's own cap, `budget.write` in the task's project, `Idempotency-Key` required, `cap_usd` within `numeric(12,6)` and at most six decimals (400 otherwise), `409 not_paused_by_task_cap` unless the task's **own** cap paused it, `409 budget_not_raised` for a figure not above the cap in force; nothing lowers a cap), `POST /api/tasks/:id/owner` (**S-26.1**, TD-031's 2026-11-06 amendment item 3: `{user_id: uuid | null}`, `task.owner.take` (member) at the guard, `Idempotency-Key` required, one `human_actions` row `task.owner` (`{user_id, changed, owner_user_id}`) per accepted request; the matrix is the domain's `ownerChangePermitted` over the caller's effective role, the task's owner and whether its ticket is **held elsewhere** (its stored tracker assignee is a person the platform cannot map to a `member`-or-above user): a member takes an **unassigned** task (no owner, not held elsewhere) or gives back their own, a maintainer or above sets any `member`-or-above of the project or nobody, on any task — otherwise `403 owner_change_not_permitted`; a target below `member` is `422 owner_not_project_member`, a done or cancelled task `409 task_finished`; refusals record nothing; the command itself writes no tracker and does not touch `ticket_assignee`, so the next tracker read keeps the platform's owner until the tracker changes; `task.owner.changed` on the task's stream — and since **S-26.3**, on a binding with `lifecycle.assign_owner`, that event enqueues the `ticket_owner_assign` duty, which assigns the ticket to the new owner's linked account after the response (never for a release; technical/02)), `GET /api/projects/:id/owner-candidates` (**S-26.1's follow-up**, the M26 UX spec § 2's *Assign…* picker, its caller S-26.8b's: `{items: [{user_id, name, writes_back}]}`, exactly the users the owner command accepts as a new owner of a task of that project — `member`-or-above by the higher of the organisation role and a membership, and not disabled — asked through the command's own predicate `userMayOwnInProjectSql`, so the picker and the command never disagree; sorted by `name`, then `user_id`; `task.owner.assign` (maintainer) in the project, the permission that names another person, so a member is `403`; `404` for no such project; since **S-26.3** each item's `writes_back` says whether assigning that person would also assign the ticket in the tracker — the write-back duty's own predicate (`ownerWriteBackReachesTracker`) over the task an optional `?task_id=` names (the picker passes the task it opens from; a task that is not the project's is `404`, a shadow or platform-issued one reads `false`) or, with none, over the project's task-management binding's provider; a read — no audit row, no provider call; `name` is a person's own text), `POST /api/tasks/:id/{pause,resume,cancel,retry-stage,return-to-stage,take-over,hand-back,rework}` (**WP-152:** `return-to-stage` (`{stage, reason, attach_gate_feedback?}`) and `rework` (`{stage, instructions, attach_gate_feedback?}`) take an optional boolean: out of an escalation at a **gate** whose attempt recorded a failure — a spent `ci_fix` loop's log excerpts — the failure goes to the target stage beside the person's text unless it is `false`, and `true` where there is none is `409 no_gate_feedback` with nothing recorded; the reason's 8 000-character bound is unchanged; `GET /api/tasks/:id` publishes `gate_feedback` — `{stage, attempt, chars, original_chars}` of that failure, or `null` — so the return dialog offers the box only where it applies, and never the text; **backlog 1078:** `GET /api/tasks/:id` also publishes `gate_wait` — the current stage's open CI wait, or `null` (another stage, a closed attempt, or a last read that found no pipeline): `{pipeline_id, pipeline_url, status, held_job, held_job_url, draft, checked_at, waiting_since, timeout_minutes}` — `pipeline_url` and `held_job_url` are `http(s)` URLs or `null`, `status` the git port's pipeline vocabulary (`pending`, `running` or `manual` in practice), `held_job` the held manual job's redacted name (at most 100 characters, `null` unless the pipeline's own status is `manual`), `waiting_since` the attempt's entry and `timeout_minutes` the CI timeout bounding the wait (`null` on a binding a webhook reaches); provider text, rendered as untrusted text; the server always sends the key, which the schema keeps optional until the web app's fixtures name it (backlog 1099), and the export carries it too; beside it `last_gate_wait`, the same shape for a **parked** wait — the task `needs_human` at `ci_gate` and the newest `ci_gate` attempt closed `failed`/`undecided` with a recorded read (its timeout, its checks, a provider that did not answer, or a Retry on the unchanged held pipeline), `null` otherwise and always `null` while `gate_wait` is set — and `stop.ci_ending` (`ci_timed_out`: the poll-only wait reached its CI timeout; `ci_held_unchanged`: a Retry's first read found the previous attempt's held pipeline unchanged; `null` for every other stop, read off `task_stages.ci_ending`), a field beside `stop.cause` (`no_answer` for both) so a reader that switches over `cause` keeps compiling; a task that entered `merged_gate` is refused `409 task_merged` for any target before the merge, hand-back included, and `resume`, `retry-stage` and a hand-back into the retrospective or the librarian take it out of `needs_human` into `retro` (technical/02's M9 amendment) — `resume` of one parked at `merged_gate` itself enters the retrospective, and `retry-stage` there stays `409 illegal_transition`; **take-over's stop of a live run is accepted, then applied or refused** — WP-85, TD-028 decision 9: the pause and the stop are recorded in one transaction, the run is found in the database and its id recorded on `task.taken_over`, and the process holding the run applies the stop; the response's `workspace_export: "requested"` is that tense), `GET /api/tasks/:id/export` (JSON — **the task's stored events are published by this export, capped**: there is no `GET /api/tasks/:id/events`, struck from this list at WP-130 (PROGRESS backlog 380, option (a)) because no route served it and no screen asked for it, so a screen that needs a paged event read is the trigger for one; **served since WP-112**, PROGRESS backlog 310, and the task page's *Download JSON* since WP-122, offered when `GET /api/tasks/:id` answers `can_export`: `task.export`, member, scoped to the task's project; one document built from the existing read projections — everything `GET /api/tasks/:id` publishes, each run record with its `settings_hash`, the task's `human_actions` rows as `GET /api/tasks/:id/audit` projects them (newest first) and the task's events (its own stream and every event correlated to it, oldest first, published as stored with the payload pattern-redacted at the read — the platform's **patterns** only, not the project's binding credentials (WP-107's exact-value layer is applied to prompt files, not here): today no unredacted provider text reaches a task's events (the inbound events built from raw deliveries sit on the project stream, uncorrelated), so a future writer that correlates one to a task is the trigger); events and audit rows are each capped at 1 000 with `truncated`; `human_actions` is `null` for a caller without `org.audit.read`, so the export does not publish what the audit read's maintainer gate withholds — each command's `params` (its idempotency key and body digest); a member **does** learn who did what and why from the exported events (their `actor` and reasons, e.g. `task.paused.reason`), which no route published before WP-112; transcripts, artifact bodies and settings snapshots stay on their own reads), `POST /api/tasks/:id/questions/:qid/answer`, `POST /api/tasks/:id/approvals/:aid/decide` (**S-25.1, TD-035**: `{decision, reason?, subject_artifact_id?}` — approving a **plan** requires `subject_artifact_id`, the plan the person was shown: absent or different is `409 approval_subject_mismatch`, a subject no longer the task's latest plan `409 approval_subject_superseded`, a plan approval with no subject `409 approval_subject_unrecorded`; a reject and a budget approval need none. `GET /api/tasks/:id` and `GET /api/org/inbox` publish each approval's `subject` — plan `{artifact_id, artifact_version, stage, attempt, basis: recorded|derived}` or budget `{estimate_usd, threshold_usd, estimate_basis, estimate_samples}` — and `reasons`, TD-035's closed vocabulary; `null` on either is *not recorded*), `POST /api/tasks/:id/feedback`, `POST /api/tasks/:id/ask` (ask-the-task), `GET /api/artifacts/:id` (one artifact's body, gated at `artifact.read`; **added at WP-52**, and until then `GET /api/tasks/:id` published every artifact with a literal `null` `url` and no route served a body) |
| Runs | `GET /api/runs/:id` (since **WP-119** its `cost` is `null` for a run nothing measured — a stop whose interrupted turn sent no result, a crash — never `0`; since **WP-131** a `model_usage` entry whose model nobody priced carries `usd: null` too, on this read DTO only (`runModelUsageRecordSchema`); since **WP-112** with `settings_hash` — the `sha256` of the configuration the run was planned with; `null` for a run created before WP-91; since PROGRESS backlog **453** with `start_failure` — `runs.exit_detail` for a run that never started, the diagnosis and the launcher's redacted, bounded, **untrusted** words, `null` for a run that started; since backlog **467** with `saved_work` — `runs.saved_work`, what an unsuccessful Developer run's workspace saved (`{branch, commit_sha, pushed}`), `null` when no export was attempted; since backlog **454** `provider_mode` is the mode the run was planned with rather than the column default; since backlog **496** with `latest_progress` — the run's newest `progress` transcript row, `{seq, at, summary, percent_complete}`, the summary **untrusted**, `null` for a run that reported none — on this read, on the task page's runs and on the Agents screen; since **WP-167**, on this read only (`runReadResponseSchema`), with `retry_defaults` — `{model, effort}`, the stage's **configured** model and effort, resolved at the read by `configuredStageAgent`, the one function the planner and the retry's listing check also call, which is what an unchanged *Retry run* runs; `null` for an ask run, which has no stage. The configuration can change between the read and the submit, and the job resolves it again, so the field is the screen's best statement rather than a promise), `GET /api/runs/:id/messages?after=<seq>&limit=`, `GET /api/runs/:id/prompt` (**WP-121**: `prompts_withheld` is the reading's withheld record frozen on the run — why the project's prompt files are missing from it — and `null` when nothing was withheld or the run predates migration 0073), `GET /api/runs/:id/context-pack`, `GET /api/runs/:id/settings` (**WP-112**, PROGRESS backlog 309: the snapshot WP-91 froze onto the run, as stored — redacted at the write, the over-256 KiB marker served as the marker — gated at `transcript.read` because it carries text an operator typed; a run created before WP-91 is refused `409 settings_not_recorded`, never served `{}`), `POST /api/runs/:id/{steer,cancel}` (**steer is accepted, then applied or refused** — WP-85, TD-028 decision 9: it answers `202` with the `run_commands` id and never claims the model heard it; the process holding the run applies it and stamps the row, and a command still pending when the run ends is refused `run_ended`; limited to one per five seconds per user **across every process**, read off the user's recorded steers under a per-user advisory lock since WP-101. **Cancel stops the session when a process holds it** — WP-101, TD-028 decision 11: with a live lease it pauses the task, records a `cancel` row for the holder and answers `202` with `command_id`, and the holder interrupts the session and ends the run `cancelled` with the cost the session measured, charged once and not late; if that holder dies first the lease sweep ends the run `lease_expired` and closes the row `run_ended`. With no live lease (absent or expired) it ends the record in place and answers `200` with `command_id: null`. A steer still pending behind a stop is not delivered and is closed `run_ended` by the run's ending), `GET /api/runs/:id/commands` (**WP-85**: the run's steers, take-over stops and — since WP-101 — cancels, newest first, each `pending`, `applied` or `refused` with its reason — what the run screen reads; `transcript.read`), `POST /api/runs/:id/retry` (model/effort override; since **WP-159** a `model` with no open `price_list` window that is neither the run's own nor the stage's configured model is refused `409 model_not_listed` and nothing is recorded, unless the body's `allow_unlisted_model` is `true` — a custom or not-yet-priced id a person chose on purpose; the field stays a bounded string, never an enum), `GET /api/runs/:id/transcript.jsonl` and `GET /api/runs/:id/export.tar` (**WP-44**, the take-over's two downloads — **served, not copied** (Q93): the transcript is `run_messages` rendered one entry per line through the `/messages` projection, as an attachment, gated at `transcript.read`; the tarball is the launcher's file on the shared export volume read through the SPA's realpath guard, gated at `task.take_over`, kept fourteen days) |
| Agents | `GET /api/org/agents` (running runs; **S-23.15**: each item's `seat` — `{kind: server\|worker, worker_id, worker_name}` off the run's **claimed** offer (`run_offers.claimant_kind`, the machine `run_offers.worker_id`, else `runs.worker_id`, named from `workers`), `null` while the offer is open (the queue) or for a run with no offer row, never guessed — and `activity` — `{kind: tool\|thinking\|text\|waiting_permission\|progress\|other, tool_name, at}` from the run's **newest** transcript entry (a `tool_use` block, a `PreToolUse` hook that allowed the call → `tool`; one that asked → `waiting_permission`; a thinking block, assistant text, a progress line; anything else `other`), `null` before the first entry; `tool_name` is an identifier of at most 64 `[A-Za-z0-9_:.-]` or the literal `other`, and **no text, tool input or argument of any entry is published** — the query reads four JSON paths, never `payload`; one query for the listed runs: a `lateral` probe per run, `order by seq desc limit 1` on the primary key from the run's `created_at` (less a day of clock skew) on, so older partitions are pruned and no transcript is sorted (`apps/server/src/queries/live-view-queries.ts`; `latest_progress` is read the same way)) |
| Pipeline graph | **S-23.15** (TD-033 decision 8 (a)): `GET /api/tasks/:id/pipeline` (`task.read`, scoped to the task's own project) — the task's **frozen** pipeline: `template_snapshot` (the shipped template of that name for a row written before snapshots), its frozen dial, `qa_stage` and `iteration_limits` — and `GET /api/projects/:id/pipeline[?template=<slug>]` (`project.read`) — `{items: [graph]}`, each template as a task started now would freeze it (the dial and the binding's `qa` slot for the templates intake routes onto, neither for discovery, review-only, the linter and the history bootstrap); without `template` every **enabled** one: feature, bug, chore and discovery always, spike, epic split, review-only, the ticket linter and the history bootstrap only while their `features.*` switch is on, a project's own template always. A graph is `{template, nodes: [{id, kind, role, enabled, advisory, model, effort, produces}], edges: [{from, to, kind: next\|approve\|return\|pass\|fail\|on, on_event, loop, loop_limit}]}`: every stage is a node; the edges are the interpreter's own answers from each enabled stage (`interpret` asked *approved*, *changes requested*, *passed*, *failed*, *this event arrived*), so a disabled stage is walked over, a return with no bounded loop or a dial's scoping stop draws no edge, and `loop` is set exactly on a backwards edge, with `loop_limit` its frozen (task) or configured (project) ceiling — per edge, because one stage may leave backwards by two loops (`ready_for_merge`: `human_rounds` and `rebase_rechecks`); `model`/`effort` (agent stages only) are the latest run's for a stage the task ran, else the configured value, and `null` for a stage that has not run when the project's stored settings do not parse; `produces` (S-23.5) is the artifact type the stage's template declares, `null` for a stage that writes none — the flow canvas's stage dialog names it and opens the task's newest artifact of that type. Refusals: `404 template_not_found`, `409 pipeline_not_compilable` (a template, frozen dial or frozen limits this release cannot compile), `409 project_config_refused` (the project's stored settings do not parse) (`apps/server/src/routes/pipeline-graph.ts`) |
| Models | `GET /api/org/models` (**WP-159**: `{models: [{model_id}]}` — the distinct `price_list` model ids whose window is open now, ordered by id, no prices; `run.read`, viewer, as the agents list; the options *Retry run* offers and the list `POST /api/runs/:id/retry` checks a `model` against, one query for both) |
| Inbox | `GET /api/org/inbox` (questions + approvals pending for the caller) |
| Your accounts | **S-26.6** (TD-031's 2026-11-06 amendment item 9; the screen is S-26.8a's): `POST /api/me/identity-links` (a one-time code, `agentic-link-` + ten Crockford base32 characters, 50 bits, valid 30 min, answered **once** with `Cache-Control: no-store` — only its SHA-256 is stored; issuing voids the caller's previous code; five per hour, then `429 link_code_rate_limited` with `Retry-After`), `GET /api/me/identity-links` (the newest code's `status` — `live`, `expired`, `voided` with `void_reason`, `consumed` — never the code, and its **matches**: each a provider account whose verified comment carried the code, `{id, provider, external_id, display_name, integration_id, integration_name, matched_at, confirmed_at}`, a proposal and never a link; `display_name` untrusted), `POST /api/me/identity-links/read` (*I wrote it on …*: `{project_id, ticket_key}` or `{project_id, merge_request_iid}` of a **task of that project**; the thread is read through `IntegrationActionExecutor` and its comments go through the webhook's rules, except that a re-read records and counts **no miss** — only a verified delivery does, so re-reading copied codes cannot get an author ignored; `403 identity_link_read_not_permitted` below an effective `member`, `404 link_thread_not_found`, `409 link_thread_no_binding`, `503 link_thread_unavailable`; answers `{comments, carried_code, matched, state}`), `POST /api/me/identity-links/matches/:match_id/confirm` (`Idempotency-Key` required — the only self-service writer of `user_identities`, `kind: person`, never over an existing row; it re-checks: `404 link_match_not_found` for a match not of the caller's code, `409 link_code_voided` (`details[0].message` the `void_reason`, `second_author` = someone else used the code), `409 link_code_expired`, `409 link_code_used`, `409 identity_linked_elsewhere`, `409 identity_is_machine`, `409 identity_is_binding_account`; one `human_actions` row `identity.link {provider, external_id, via: link_code, match_id}`; a performed link then makes the person the owner of every live task nobody owns whose tracker assignee is that account — S-26.1's `adoptOwnersOnLink`, `task.owner.changed` with `via: link`, no provider call — answered as `adopted_task_ids` — empty on a retry, and when adoption fails partway (logged; the link stands) the tasks adopted before the failure), `GET /api/me/identities` (the caller's own `person` rows), `DELETE /api/me/identities/:provider/:external_id` (the caller's unlink; `404 identity_not_found` for an account not theirs; one `human_actions` row `identity.unlink`). All `identity.link` (viewer — any active user) |
| Knowledge | `GET /api/projects/:id/kb/tree`, `GET /api/projects/:id/kb/doc?path=`, `PUT /api/projects/:id/kb/doc` (creates commit/MR), `GET /api/projects/:id/kb/search?q=`, `GET /api/projects/:id/kb/proposals`, `POST /api/projects/:id/kb/proposals/:pid/{approve,reject,edit}` (**WP-109**: four lost races on the project stream in a row answer the retryable **`409 project_stream_contended`**, never a 500; **WP-124**: a proposal in `apply_failed` — published with its `apply_failure_reason` — is decidable again, and an approval asks for another apply; **WP-125**: an approved proposal the apply pass deferred behind an open knowledge merge request is published with its `apply_deferred_reason`, platform text naming that merge request), `GET /api/projects/:id/kb/health`, `POST /api/projects/:id/kb/bootstrap` |
| Shadow | `POST /api/projects/:id/shadow-batches` (ticket keys), `GET /api/projects/:id/shadow-batches`, `GET /api/shadow-batches/:batch_id` — **amended at WP-34**, and the three differences from the sketch above are each a decision. **`shadow-batches`, not `shadow/runs`**: a *run* is a specific thing in this platform (`runs`, `GET /api/runs/:id`, the `run:<id>` SSE topic), and a shadow batch creates N **tasks**, each of which then has several runs — naming the command after runs would make the word mean two things on one API. **No `budget` in the body**: the cap is `features.shadow_mode.budget_usd` in the project's configuration document, which is where every other per-feature cap lives; taking one per request would give the number two homes and let a caller raise it. **The batch is read by its own id, not per project**: `shadow_reports` is a row per *task*, so *"the project's reports"* is a list with no grouping, and product/19 §13's aggregate is *"per shadow batch"*. The list endpoint additionally publishes `can_start`/`blocked_reason`, so the screen states why a batch cannot be started instead of offering a button that answers 409 |
| Webhooks | `POST /webhooks/:provider/:integrationId` (signature verified; 2xx once recorded; `inbox`). **Unauthenticated by design** — the credential is the signature over the body (TD-024), so TD-022's CSRF rule neither applies nor fires (it refuses only a mutating request *carrying a session cookie*). The body reaches the handler **unparsed**, through a content-type parser scoped to this route, because every scheme signs the bytes. Answers: `202 {accepted: true, delivery_id}` performed or already performed; `202 {accepted: false, delivery_id: null}` authentic but unkeyable (a wiki or release hook — a 4xx would have the vendor disable the webhook, standing rule 20); `401` signature; `400` a body that is not a JSON object; `404` an unknown integration id or a provider that does not match it |
| Events | `GET /events?topics=org,project:<id>,task:<id>,run:<id>` (SSE), `POST /events/subscriptions` (add/remove topics for the connection id) |
| Ops | `GET /healthz`, `GET /readyz`, `GET /metrics` (Prometheus; optional basic auth), `GET /api/version` (its `commit` is also the SPA's build check since WP-154: re-read on every `invalid_response` and SSE reconnect, technical/09 § "An upgraded server under an open tab") |

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
> **`claimants` says who runs agent runs, and `degraded` is still ready (WP-277, TD-031 decision 13;
> WP-86's `agent_runs` until then).** Every role that holds a job client reports `claimants`: `server`
> when this process composes the server claimant **or another process of the instance holds a fresh
> `server_claimants` row** (WP-281, backlog 722 — the `app` process beside a busy `runner` is not
> "no claimant"), `workers: <n>` when remote workers are connected (an authenticated protocol call in
> the last 60 s, WP-281), else `none`. `none` alone is **not** degraded — a `workers_only` core is a valid
> state; the check is `degraded` — with `details: {"claimants": "unclaimed"}` and
> `oldest_unclaimed_offer: {run_id, offered_at, waited_seconds}` — only when no claimant is here or
> connected and an open offer has waited five minutes, read from `run_offers` rather than from the
> process; `unknown` when the read failed. A `degraded` report answers **200**, a `down` one 503. The
> matching metrics are `run_offers_open{project}` and `run_offer_wait_seconds{project}`;
> `jobs_queued{queue}` (ready, unclaimed jobs per declared queue, `0` included) is no longer an agent
> backlog since the job ends at the offer (WP-276).
>
> **`schema` appears only on an all-additive future (WP-272, TD-032 decision 2).** When the database
> carries migrations this build does not ship and every one was recorded `additive`, the process
> starts (the guard logs `schema_ahead_additive`) and every role reports `schema: degraded` with
> `details: {"schema": "ahead_additive"}` beside `migrations: ok` — 200, like `claimants`. One
> unknown `contract` or unclassified migration is `migrations: down` instead, and a process starting
> on it refuses to start. Both readers take the verdict from `judgeSchema` in
> `packages/infrastructure/src/db/migrator.ts`.

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
> `run_not_live` and `task_conflict` for the refusals that are not edges — and, since PROGRESS
> backlog 483, `stage_not_in_template` and `stage_not_reached` for a return or a rework aimed at a
> stage the task's template does not run, or one the task has not been through at or before its
> own; both are accepted from `needs_human` too, technical/02 — and, since WP-152, `task_merged`
> for a return, a rework or a hand-back that would send a merged task to a stage before its merge,
> and `no_gate_feedback` for `attach_gate_feedback: true` where there is nothing to attach), and each accepted command
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
> **Amended 2026-10-06 (PROGRESS backlog 494, the product owner's first local test: *"retry během
> běžícího pokusu se tiše přeskočí"*) — `POST /api/tasks/:id/retry-stage` stops the stage's run in
> flight.** The route used to say the moved attempt counter *supersedes* a run still in flight; it
> did not. The stage executor's re-validation skips a **job** whose attempt has passed, but the old
> run was already past it: it ran on, its recording transaction completed the stage on the task's
> new attempt (it never asked which attempt it was recording), and the new attempt's job — queued
> behind it, because `stage.execute` is `stately` per task — found the task at the next stage and
> did nothing. The person was answered `200` and no second run started. Three things are now true.
> **The retry stops the live run of that stage** in its own transaction, through the run cancel's
> two branches above without the cancel's pause: a process holds the run's lease → a `cancel` row is
> recorded for it (its id derived from the `Idempotency-Key`, as the run cancel's is) and that process
> interrupts the session and ends the run `cancelled` with what it measured; nobody holds it → the
> record is ended in place. An ask beside the stage is never stopped. **A run whose attempt the task
> has left completes nothing**: the executor asks `isCurrentStageAttempt` before writing a verdict,
> records the run and its spend exactly as for a run that ended into a stopped task, and the lease
> sweep ends such a run without escalating the task that is on the new attempt. **The new attempt's
> wake-up is not lost to the queue**: it waits behind the old job and runs once that job ends, and a
> wake-up that fires for an attempt the task has left forwards itself to the current one, so a second
> retry whose enqueue was coalesced onto the first's still runs. The answer says what was done —
> `retryStageResponseSchema` adds `attempt` (the attempt entered, `null` at `ready_for_merge`, which
> the head check re-enters) and `stopped_run` (`{run_id, command_id}`, `command_id` `null` when the
> record was ended here; `null` when no run of the stage was live), recorded in the audit row so a
> replay answers the same — and the task screen's *Retry stage* shows it. `POST /api/runs/:id/retry`
> is unchanged: it still refuses a run that has not ended (`run_not_live`), which is the honest
> answer to "retry this run" while it runs.
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

**What each topic carries, and from where** (S-23.14). `run:<id>` carries `transcript` frames, read back from `run_messages` by `apps/server/src/sse/transcript-bridge.ts` (WP-15h). `org`, `project:<id>` and `task:<id>` carry `domain_event` frames — one per **`task.*` and `run.*`** event (`LIVE_DOMAIN_EVENT_TYPES`, derived from the catalogue), to `org`, to the event's `project:<project_id>` and to its `task:<task_id>` — read back from `events` by `apps/server/src/sse/domain-event-bridge.ts` in **every process that serves the API**, so an event a `ROLE=worker` process appended reaches a stream a `ROLE=api` process holds. The appender publishes a second hint beside TD-005's collapsed wake-up, `events.appended.live` with `{from, to}` — the positions of the transaction's live events, because the global position is not in commit order and a watermark alone would skip a late committer; the read is `(min(watermark, from − 1), to]`, so a dropped hint is caught up by the next one, and each position is published once. The frame's `id:` is `<topic>:<events.position>` on all three topics. Its `data` is a **projection**, never the event (`liveDomainEventSchema` in `@platform/contracts`, strict): `id`, `type`, `stream_type`, `stream_id`, `occurred_at`, and, when the payload names them, `project_id`, `task_id`, `run_id`, `stage`, `question_id`, `approval_id`, `worker_id`, a run's `status`, a stage's mapped `verdict` and a claim's `claimant_kind` — no question text, reason, brief, answer, steer message or provider status (BD-022, least exposure); the client refetches through the read API, which authorises every field it returns. A process reads nothing while it holds no `org`/`project:`/`task:` stream, filters the read to the watched projects and tasks when no `org` stream is open, and publishes only to topics with a subscriber. Who may subscribe is unchanged (`apps/server/src/sse/topic-access.ts`: `org.read`, `project.read`, `task.read`, all `viewer`).

**Responses are compressed and the stream is not** (TD-002, WP-15j round 2). `@fastify/compress` is registered globally, so every route's JSON, `/metrics` and `/openapi.json` arrive `br` or `gzip` for a client that accepts one. **`/events` is never coded** — a compressed SSE response buffers in the compressor, and the frame the hub wrote is then a frame the browser has not received. Three things see to that and only one is ours: `@fastify/sse` commits the response by writing to `reply.raw`, so no `onSend` hook sees an SSE payload at all; the compressor's default type table excludes `text/event-stream`; and the route carries `compress: false`, which is this constraint stated in our own code and which, measured by mutation, decides nothing today. What is asserted is therefore the **outcome**, over a socket, including on an instance configured to compress every content type (`apps/server/src/web/compression.test.ts`). Two more decisions there: `/api/auth/*` is excluded as well (its bodies are the only ones on this origin carrying a bearer credential), and request **de**compression is off, so no endpoint — least of all the signature-verifying `/webhooks/*` — inflates a body a caller sent.

## Auth and RBAC
- Session cookie (`__Host-session`), CSRF via SameSite + Origin check + `X-Requested-With` (a refusal is `403 cross_site_request`, WP-73d); API keys via `Authorization: Bearer` for scripts (scoped to org actions).
- Roles: org `admin | maintainer | member | viewer`; project membership with the same levels; capability map in `packages/domain/permissions` (e.g. `task.answer_question: member`, `task.approve_plan: maintainer`, `run.steer: member`, `kb.proposal.decide: maintainer`, `project.settings.write: admin`, `budget.write: maintainer`, `transcript.read: member`).
- External identities (Jira, GitLab, Slack) are mapped to users in `user_identities` — by an admin (`POST /api/org/identities`, WP-31) or, since **S-26.6**, by the person themself: a one-time code written as a comment from their own account, whose **provider-authenticated** author they then confirm (`/api/me/identity-links`, the *Your accounts* row above). Never by email and never from a typed id (BD-006/Q10, TD-031's 2026-11-06 amendment item 9); unmapped identities cannot trigger actions.
- **`GET /api/setup-state` is public** (WP-291): `{ "first_sign_in_pending": boolean }`, read by the sign-in page before a session exists so it names `APP_BOOTSTRAP_ADMIN_EMAIL` only while nobody has signed in. **Accepted disclosure:** it tells an anonymous caller one bit — whether the instance has ever been signed in to — and nothing else (no account, count or time; the schema is strict). The fact is durable: `users.first_signed_in_at` (migration 0093), which the served Better Auth instance's `session.create.after` hook stamps (`… where id = $1 and first_signed_in_at is null`; a failure is logged and never fails the sign-in); the bootstrap's own Better Auth instance has no hook. Sessions could not answer it — they are deleted at sign-out and expiry — and the audit must not: a synthetic `human_actions` row leaked into every task's action list (WP-291's first version). The read is `exists (… users where first_signed_in_at is not null) or exists (select 1 from human_actions)`: 0093 has no backfill (an `update` is not additive, TD-032 §1), and an audit row is evidence the instance is in use (not proof of a sign-in: `user_id` may be null, and a WP-88 chat-button decision records a person who may never have signed in, so the hint can only hide early), so an instance that predates the column reads `false` if it has any; one whose people only ever signed in shows the hint until the next sign-in. No limiter of its own (the server has none for public reads): a `false` is cached per process, so a used instance answers it without touching the database.

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

## Amendment (2026-11-04, TD-031) — the worker surface

A second authenticated surface, `/api/worker/v1/*`, for remote workers: device flow (`device`,
`device/token`, unauthenticated and rate-limited), `handshake`, `claims` (held ≤ 25 s), `runs/:id/
{heartbeat (held ≤ 20 s), transcript, tools/:name, approvals, session, ssh-sign, release, finish,
late-cost, cancel}`, `pause`, `manual-pause`, `claim-scope` (`GET`/`PUT`), `offers`, `offers/:id/claim`, `release` (digests + protocol range; the updater verifies attestations itself), `compose.yml` (first install only), `update-report`. Device-flow rate limits key on `APP_TRUSTED_CLIENT_IP_HEADER` only from a peer the widened `APP_TRUST_PROXY` (an address/CIDR list) trusts. Auth: a per-machine worker credential (`wkr_…`,
stored SHA-256) or a per-run token; header `X-Worker-Protocol`; `426 upgrade_required` outside `[N-1,
N]`; `409 lease_lost` on a stale epoch; `Cache-Control: no-store`. No request is held longer than 25 s, so
the surface works through a CDN proxy (research/17 § 8). For people: `PUT /api/workers/:id/claim-policy` (S-26.4: what the machine takes, by its own user only — below, *Protocol 4*), `GET/DELETE /api/workers[/:id]`
(own; all for `org.admin`; **S-23.15**: each listed worker's `running` — `[{run_id, task_id, project_id}]`, the live runs it holds through `runs.worker_id` or its claimed offer's `run_offers.worker_id`, the same columns the agents list's `seat` reads), `POST /api/workers/device/approve` (session, CSRF), `GET/PUT
/api/projects/:id/execution` (`project.settings.write`), `GET /api/org/updates` (admin). Full contract:
TD-031 decision 9.

**The device flow and the people's routes are served since WP-280.** `POST /api/worker/v1/device` and
`device/token` (`apps/server/src/routes/worker-device.ts`) are unauthenticated and `Cache-Control:
no-store`; the poll answers RFC 8628's `400 { "error": … }` or, once, `200 { worker_id, credential }`,
and an unknown `device_code` is `expired_token`. `device` answers `429 device_code_limit` (with
`Retry-After: 60`) past 20 pending codes for the client address or 200 in the instance; the client
address is `apps/server/src/client-address.ts`'s — `APP_TRUSTED_CLIENT_IP_HEADER` only from a socket
peer `APP_TRUST_PROXY` trusts (`false | true | <addresses/CIDRs>`, a bare integer refused), else
`request.ip`. The people's half is `apps/server/src/routes/workers.ts`, with **one route the amendment
above did not list**: `POST /api/workers/device/lookup` (`{user_code}`), the approval page's read of
what the requesting machine sent (address, user agent, age, `needs_confirmation` past five minutes)
before anybody decides — a read sent as a POST so the code never sits in a URL an access log records,
and `404 device_code_not_found` for anything not pending, so it is no oracle.
`POST /api/workers/device/approve` takes `{decision: "approve", user_code, name, confirm_stale}` or
`{decision: "deny", user_code}` and refuses `409 device_code_needs_confirmation` /
`device_code_expired` / `device_code_already_decided` (another person's decision, the other decision
or another name); **a retry of the caller's own recorded decision** (same decision, same name) answers
`200 {decision, decided_at, performed: false}` with the original instant and writes nothing, even
after the code expired; `DELETE /api/workers/:id` answers
`{worker_id, performed, revoked_at, expired_runs}`. RBAC: `worker.register` (viewer — any active user)
for the device pair, the own list and the own revoke; `org.workers.manage` (admin) for every worker,
and somebody else's worker is `404` to anyone else. Each decision and each performed revocation writes
one `human_actions` row (`worker.device.approve|deny`, `worker.revoke`). The DTOs are
`packages/contracts/src/workers.ts`.

**The protocol's first half is served since WP-281** (`apps/server/src/routes/worker/protocol.ts`, the
commands `packages/application/src/pipeline/remote-runs.ts`, composed for every process that serves the
API by `apps/server/src/worker-protocol.ts`): `handshake` and `claims` (worker credential), and
`runs/:id/{heartbeat, release, spawn, finish, late-cost}` (run token). What is decided there:

- **`X-Worker-Protocol` is checked first, on every `/api/worker/v1/` verb — the device flow's two
  included** (backlog 712: TD-031 §9 asks it on every request, and a worker whose protocol this core
  does not serve learns it before it registers a credential it cannot use). An absent, malformed or
  unaccepted header is `426 upgrade_required` with `accepted`, `compose_url` and `digests` — `digests`
  is `null` while the core cannot name its images — before authentication and before the body is read.
  Every answer is `Cache-Control: no-store`.
- **Authentication is `Authorization: Bearer`**, in `preValidation`: the `wkr_` credential on
  `handshake`/`claims`, the run token on a run verb — a token authenticates only its own run, while its
  worker is not revoked and its user may act, until fifteen minutes after the run's terminal write.
  Anything else is `401 unauthenticated`, which a worker treats as `lease_lost`. The fence's owner is
  `worker:<id>` from the authenticated subject; a body names an epoch and nothing else of the claim.
  Every authenticated call stamps `workers.last_seen_at` (the database's clock) and the protocol it
  spoke — TD-031 §8's *online*, `/readyz`'s `workers: <n>` and the `workers_connected` gauge.
- **`claims`** is held up to 25 s, woken by `pg_notify('run_offers')` and a 5 s poll (a
  `workers_from` passing is announced by nothing); `204` with nothing claimable, at once for a
  `paused` worker. The one claim checks TD-031 §8's eligibility **in its statement** — a **stage**
  or an **ask** offer (WP-283, backlog 741: `finish` of a run that serves an ask settles through the
  ask's own ending, `AskExecutor.settle`, composed on the worker routes — an ask's offer names the asker
  as its assignee, so the asker's online worker has its head start), not excluded, the offer's images
  held, the worker not revoked, its user may act (backlog 714), not paused, an effective project role
  (the higher of the organisation role and a membership, backlog 886) at `member`+, `workers_from` reached or the assignee's head start, and the project's run credential
  `minted` — or `static`/`deploy_key` behind the git integration's `remote_run_credential: allow`
  (WP-282, default `deny`). In the same transaction the stage executor's budget questions are asked
  again (TD-031 §2, S-22.14 `claim-admission.ts`, both claimants): a task cap or an organisation or
  project budget spent since the offer rolls the claim back, withdraws the offer (`budget_at_claim`),
  pauses the task `budget` and answers the worker `204`. The claim writes
  `run_offers.worker_id`, `runs.worker_id`, the run token's SHA-256 and its epoch, and the offer's
  `image_digests`; the git credential is minted **after** it commits. A run that cannot be packaged
  settles `not_started` under the worker's claim — **a mint failure included, never a release**
  (TD-031's 2026-11-05 amendment, backlog 740): retryable exactly when the mint error is
  (`rate_limited`, `unavailable`, or the binding changing between claim and mint), so Q59(a)'s bound
  spaces the attempts 30 s apart and escalates the task after three; no worker is excluded. The server
  claimant judges a mint error the same way (`classifyProvisionFailure`). `200` is the run package (`runPackageSchema`): the stored
  spec with no secret value and `secretEnvNames` empty, the minted credential, the skills, the images
  by digest, `limits.leaseTtlMs` 600 000. `503 digests_unresolved`, naming the image, while the core
  cannot name its images — since WP-284 it resolves its own `sha-<7>` digests (below) and
  `APP_WORKER_IMAGE_DIGESTS` is the override.
- **`heartbeat`** renews the 10-minute lease in one statement fenced on the epoch, the worker and the
  worker still able to act (backlog 714), stamps the acks of delivered commands (`applied`, or one of
  the four existing refusals — only for a command pending for this run), and answers the run's pending
  `run_commands` (steer, cancel, take-over, delivered until acked). With nothing pending it is held up
  to 20 s, woken by the worker's command topic. Since WP-282 it also answers the run's **decided
  approvals** (`approvals`), each delivered once, and is held only while neither is pending — a
  decision wakes the same topic.
- **`release`** is admitted while the run is `starting` with no spawn marker and undoes the claim only
  (TD-031's 2026-11-04 amendment §4): offer `claimed → open` at the same epoch, lease and
  `runs.worker_id` cleared, run `starting → created`, `run.offer.released`, the worker added to
  `excluded_worker_ids` for `usage_limited`/`provision_failed`, the credential minted for the released
  claim revoked (mints recorded by the release only, never a later claimant's), nothing charged; `run_offers.worker_id` keeps the last claimant until the next claim, so a repeat answers
  `204` again. `409 run_started` after the marker, `409 lease_lost` for another claim or an ended run.
- **`spawn`** (TD-031 decision 9's table gains it) writes the CLI spawn marker, `started_at`, `starting →
  running` and `run.started` in one transaction fenced like the heartbeat; the worker sends no `spawn`
  frame before its `200 {started_at}`; a repeat answers the first instant.
- **`finish`** is `settleRun` with the four-field request — `{epoch, stop_reason, outcome}`, the outcome
  `{kind: "ran", …RunOutcome}` or `{kind: "not_started", failure, detail, detail_truncated, transient,
  spawn_requested}`, `stop_reason` the closed `RunStoppedReason` vocabulary; `200 {outcome: settled |
  already_settled, ending}`, idempotent on `(run_id, epoch)`; `409 lease_lost`; `410 run_gone` for a
  run whose task was deleted. The minted credential is revoked after it.
- **`late-cost`** is `cost/late.ts` for a run another writer ended under this claim; `409 run_live`
  while the run is live.

**The run-scoped calls besides the claim are served since WP-282** (`apps/server/src/routes/worker/
run-calls.ts`, registered by `protocol.ts` with its run-token authentication; the commands
`packages/application/src/pipeline/remote-run-calls.ts`, composed by `apps/server/src/worker-run-calls.ts`;
their stores migration 0098). Every body names an epoch; the run must be held under it by the
authenticated worker, else `409 lease_lost` (`410 run_gone` for a run that no longer exists):

- **`transcript`** — a batch of at most 256 KiB (`413` past it) for a run held under the epoch, live or
  ended within the token's window. Each entry is validated, **re-redacted** by the run's redactor
  rebuilt from stored state — the project's binding redactors (every sealed secret: API tokens, a static
  run token, a deploy key), this process's model credential, the platform's pattern rules with every
  recorded minted-credential shape, and this process's run-scoped registry — and stored **once per
  `(run_id, seq)`** whatever `created_at` a repeat names. An undecodable entry, one naming another run
  or `seq`, or one dated outside seven days back / ten minutes ahead is stored at its `seq` as a
  `system` entry with subtype `ingest_refused` (paths and messages, redacted, never the entry) and
  listed in `refused_seqs`; a `seq` past 2³¹−1 is `400 seq_out_of_range`. A run holds at most
  100 000 entries (`MAX_TRANSCRIPT_ENTRIES_PER_RUN`, S-22.14): a batch that would pass it is `409
  transcript_full` and stores nothing, and the worker stops the run (it settles `cancelled` through
  `finish`). The `run:<id>` stream is announced as for a server run. `200 {stored, refused_seqs}`.
- **`tools/:name`** — a live run only. The production `PlatformToolPort` (the server runner's own
  composition) with a context rebuilt from the run's stored plan: project, task, mode, `promptHolds`,
  the run's redactor. A tool the run's role was not given (`RunSpec.platformTools`) is `403
  tool_not_granted`, never performed (BD-021); an unknown name is `400`. The input is re-parsed by the
  tool's strict schema — an invalid one is answered `is_error: true` with its paths, as the in-process
  MCP server answers. A **mutating** tool (`MUTATING_PLATFORM_TOOLS`) is claimed on `(run_id,
  sha256(tool_use_id))` before it performs and completed with its redacted answer: a repeat answers the
  stored answer and performs nothing, `409 tool_call_in_flight` while the first performs, `409
  tool_use_id_reused` for another tool or input; an unanswered claim older than five minutes is taken
  over (the executor's own idempotency key stands under it). `200 {result, is_error}`.
- **`approvals`** — a live run only; one approval per `(run_id, tool_use_id)`, the same id for a repeat.
  The process that opened it asks the `ToolApprovalPort` after the commit (this build's:
  `unattendedToolApprovals`, BD-025's deny) with the request's text redacted, writes the decision once
  and wakes the heartbeat. `200 {approval_id}`.
- **`session`** — the SDK session mirror (TD-007), lines from `from_line`, each redacted, stored once per
  position (at most 4 MiB a batch and 200 000 lines a run, `409 session_mirror_full` past it). `204`.
- **`ssh-sign`** — a run **live at the presented epoch** (a sign after the terminal write is `409
  lease_lost`, so a worker exports before `finish`); WP-146's oracle unchanged (the run's own key, an
  RFC 4252 §7 user-authentication for `git`, bounded data — a request it refuses is `signature: null`
  and counts nothing), and every signature counted against `MAX_DEPLOY_KEY_SIGNATURES` (128) in
  `run_offers.ssh_signatures`, **in the statement that checks the offer's state, epoch and worker** —
  one cap per run whichever replica or caller (runlet relay, helpers' relayed socket) asks. A run given
  no deploy key (`runs.credential_source`) is answered `null`, and so is every signature once the
  project's git integration no longer says `remote_run_credential: allow` — the opt-in is re-read per
  signature, not only at the claim (S-22.14, backlog 753). `200 {signature}`.

**`release` and `compose.yml` are served since WP-284** (TD-032 decision 3): `GET release` **public
since WP-294** — no credential (one presented is ignored and records no contact), the `X-Worker-Protocol`
check kept (`426` without it), because the wizard of a worker with no credential yet checks a typed
address with it and its range and digests already reach an anonymous caller through the `426` (TD-031's
first-run amendment §6; no protocol bump: no shape changed) — and `GET compose.yml` **public** — no
credential, and the one path the `X-Worker-Protocol` check skips (TD-031's 2026-11-05 amendment, backlog
760). The core resolves its four images' digests **itself**: `sha-<first 7 of APP_COMMIT>` of
`platform`, `platform-launcher`, `platform-runtime` and `platform-egress` in `APP_IMAGE_REPOSITORY`
(default `ghcr.io/gtfo-ai`) with the anonymous OCI `HEAD` — a `401` Bearer challenge, an anonymous token
from its `https` realm, the `HEAD` again, `Docker-Content-Digest` read (research/17 § 6;
`apps/server/src/workers/digests.ts`) — once per process, a failure retried after a minute;
`APP_WORKER_IMAGE_DIGESTS` replaces the whole resolution. `GET release` answers `{protocol, digests}` and
no compose file. `GET compose.yml` answers `application/yaml`: the template **baked into the image** at
`/opt/platform/compose.worker.yml` (a checkout's own `compose.worker.yml` where there is no `/opt/platform`)
with every `${PLATFORM_*_IMAGE:-…}` default pinned to `<repository>/<image>@<digest>` and `APP_CORE_URL`
defaulted to this core — for a person's first install only; no updater applies a file the core served.
Its SHA-256 is `handshake`'s `compose_bundle_digest` (backlog 743). Both answer `503 digests_unresolved`
naming the image; `compose.yml` answers `503 compose_template_unavailable` for a template that cannot be
read or pinned. A first install is `mkdir agentic-worker && cd agentic-worker && curl -fsSo compose.yaml
https://<core>/api/worker/v1/compose.yml` and `docker compose up -d`, both shown on the Workers screen from
the page's origin, then `http://127.0.0.1:7357` on that machine (WP-294). The template's `APP_CORE_URL` is
`${APP_CORE_URL:-}` since WP-294 and the render fills its default, so a served file skips the wizard's
platform step. **`GET install.sh` and `GET install.ps1`** (S-22.20) are the same kind of
public download, outside the protocol check: `text/plain`, the scripts in `apps/server/src/workers/install/`
with `APP_BASE_URL` filled in (`503 install_script_unavailable` when it cannot be quoted safely); each
downloads `compose.yml`, starts the bundle with its updater and never moves a worker's images on a re-run
(the operator guide's *One-command install*). **Residual, stated:** an anonymous caller learns the registry namespace and
the canonical base URL (the digests and the protocol range already reach it through the `426`). The
bundle **pulls** the run, egress and git-helper images itself (three one-shot services the launcher waits
for), so a clean machine can run; a worker reports as held only what its launcher resolves locally.

**The worker's half is `ROLE=remote-worker` since WP-283** (`apps/server/src/remote-worker/`; `main.ts`
dispatches on the role before `loadServerConfig`, which the worker never reads). It refuses
`DATABASE_URL` and `APP_SECRET_KEY` (and their `_FILE` variants) by name; logs in with the device flow
and keeps the credential `0600` in `APP_WORKER_STATE_DIR`; handshakes; holds `claims` while a slot of
`APP_WORKER_CONCURRENCY` is free; and runs each package on the server's own runner
(`createWorkspaceClaudeRunner` over `createClaudeRunner`) through its own launcher, `relayed` — with an
HTTP transcript sink (batched, in `seq` order), an HTTP `PlatformToolPort` (a fresh `tool_use_id` per
call, kept across that call's retries; `report_progress` answered by the runner's own progress door and
uploaded as a transcript row, backlog 752), approvals opened over HTTP and decided on the heartbeat,
`ssh.sign` frames and a per-run **helper agent socket** (`helper-<run>/agent.sock` on the `ctl` volume,
the runlet's agent codec, `<uid>:0` `0660`, backlog 705/708) forwarded to `ssh-sign`. `spawn` is asked
before the CLI; the workspace is released — every export — **before** `finish`; a `409 lease_lost`, a
`401` or a `410` stops the session and exports nothing; so does **self-termination**, `TTL − ½·renew`
(585 s) on the monotonic clock without a renewal. Every call is retried with jitter until then. The
Claude token is put in the run's spec for the CLI's environment only (`secretEnvNames`, so the runner
redacts it by exact value) and every outbound body passes an exact-value redactor of it, the run token
and the run credential — values **and object keys** (the emitting site's duty the shared walk assigns
it); the logs are redacted the same way. A take-over of a remote run exports the
branch and **no tarball** — the core records it so (`tarball: false` on the `run_commands` row) and the
worker asks its launcher for none (TD-031 §14, backlog 688). Its local listener — `GET /healthz`,
`GET /readyz` (`core_handshake` and `launcher`, ready only with both — backlog 980), `POST /internal/drain`, `GET /internal/state` — is on the worker's
compose network only. `/internal/state`'s `idle`, which an update's drain waits for, is false while a
run is in flight **or a Claude sign-in session or its token check runs** (so an update never interrupts
step 2; bounded by the sign-in's own caps). `GET /api/runs/:run_id` gains `seat` (the agents list's `{kind, worker_id,
worker_name}`) so the run page can say who executed a run (WP-283 (5)).

**Protocol 2 — the worker's local page (WP-292, TD-031's 2026-11-04 worker-UI amendment).** Two verbs,
both `426` below protocol 2 (before the credential is read), and two keys a version-1 worker is never
sent, because every schema is strict: the handshake's `worker.manually_paused_at` and the package's
`display` block (`{projectKey, ticketKey, title}`, the title from the redacted ticket snapshot).
`POST pause {until, reason: usage_limited, estimated?}` (worker credential, **served since WP-285**, TD-031
decision 11) stores a usage limit's pause — `workers.paused_until`, `paused_reason` and
`paused_until_estimated` (migration 0100: `true` when the limit named no reset and `until` is the worker's
`APP_WORKER_USAGE_PAUSE_DEFAULT`, which the screens show as *until about*) — and answers `204`; the claim
refuses the worker until then, and nothing clears the pause but its own end. It never touches
`manually_paused_at`: a person's hold and a limit's timer are two columns. A worker posts it **before** the
`finish` of the run its limit ended (so the re-planned offer is not offered back to it), and a worker that
learned of its pause after a claim and before its spawn call hands that run back with `release
usage_limited` instead of starting it. `GET /api/workers` publishes `paused_until_estimated` per worker
and the organisation's `timezone` beside the list, and `GET /api/runs/:id`'s `seat` gains `usage_pause`
(`{until, estimated, timezone}`, absent or `null` unless the seat's worker is paused by a limit now), so
the Workers screen and the run page both say *Paused — usage limit until HH:MM*.

`POST manual-pause {paused, via}` (worker credential) is a state assertion over `workers.manually_paused_at`
(migration 0099) — one `human_actions` row `worker.pause`/`worker.resume` per change, `params: {worker_id,
via}` with `via` one of `worker_ui`, `worker_ui_drain`, `worker_internal_drain`, `worker_start` (TD-031's
2026-11-05 amendment), the worker's user, none for a repeat (`performed: false`); while it is set `claims`
answers `204` at once and the claim's eligibility and the online-assignee rule leave the worker out.
`POST runs/:id/cancel {reason?}` (run token, `Idempotency-Key` **required**) is `POST
/api/runs/:run_id/cancel`'s command as the worker's user under the same `run.cancel` permission
(`403 forbidden` below it, nothing recorded, the run continues), the same idempotency record and the same
`human_actions` row plus `via: worker_ui` and `worker_id`; the worker holds the lease, so it answers `202`
with the `command_id` its own heartbeat delivers, and the task is paused (Q126). The page itself is
served by the worker, not the core: `worker.html` and `/api/local/{state, pause, drain, runs/:id/cancel}`
on container port 7357, published `127.0.0.1:${APP_WORKER_UI_PORT:-7357}` only, behind a `Host`
allow-list (`421`), and on every `POST` an exact `Origin` (absent included), `Content-Type:
application/json` and — when sent — `Sec-Fetch-Site: same-origin` (`403`), no CORS header and no cookie
(`apps/server/src/remote-worker/local-ui.ts`); a bearer token from the URL fragment (`401`) only under
`APP_WORKER_UI_AUTH=token` — the default `none` reads no `Authorization` (TD-031's 2026-11-05 no-bearer
amendment); `APP_WORKER_UI=disabled` opens no port. The page polls `state` every 2 s.

**The first-run wizard's local verbs (WP-294, TD-031's first-run amendment §8).** `state` gains
`setup` — the sources of the core URL and the Claude token (`environment` or `file`), the platforms found
on the machine, `claude_rejected`, the sign-in's `{phase, url, failure}`, the open device code
`{user_code, approve_url, expires_at}` (`approve_url` only on the core's own origin), `unreachable`
`{failure, retry_at}`, `idle` and `auth` — and `connection` gains `needs_platform`, `needs_claude` and
`core_unreachable`; `core_url` is `null` until a platform is chosen. `POST core/check {url}` answers only
parsed fields `{url, host, version, protocol_fit}` or `422` with the class as its code
(`address_refused`, `no_answer`, `not_a_platform`, `certificate`, `needs_other_version`); `POST core
{url}` checks and stores `core-url`, `{url: null}` is *Change platform* (idle only, `409 not_idle`; deletes
the credential and, under `none`, `claude-token`); `POST claude/sign-in {action: start|cancel}`, `POST
claude/code {code}` (`409 not_waiting_for_code`), `POST claude/token {token}` (whitespace inside it
removed first; `400 invalid_token`, never echoed; a paste **ends** a browser sign-in in progress, and
only a paste while that sign-in's own token check runs is `409 token_check_running`) and `POST claude/sign-out` (idle only); `POST connect-again` (only when revoked) and `POST
retry` (not when connected). Each answers the state; a value from the environment answers `409
set_in_environment`; no answer carries the token, the code or the credential.

**Protocol 3 — what a worker picks up (WP-293, TD-031's 2026-11-05 claim-scope amendment, Q127 (a)).**
`WORKER_PROTOCOL_VERSION = 3`, accepted `[2, 3]` at WP-293 (so a version-1 worker was `426` at the protocol check; protocol 4 below).
Four verbs, all worker credential and all `426` below protocol 3 before the credential is read, and one
key a version-2 worker is never sent: the handshake's `worker.claim_project_ids`.
`GET claim-scope` answers `{claim_project_ids, projects}` — the stored scope (`null` every project, `[]`
*pick only*, otherwise those projects) and the projects where the worker's user's **effective** role is
`member` or above now (`running-role.ts`, the claim's own predicate), by key, at most 500.
`PUT claim-scope {claim_project_ids}` is a state assertion over `workers.claim_project_ids` (migration
0101), stored distinct and sorted: an id that is not such a project is `422 project_not_eligible` naming
it, nothing written; one `human_actions` row `worker.claim_scope` `{worker_id, project_ids, via:
worker_ui}` per change, the worker's user, none for a repeat as a set (`performed: false`). The scope is a
conjunct of an **automatic** claim and of the online-assignee rule (an assignee whose worker is pick-only,
or whose scope leaves the project out, gets no head start), and it only narrows: no value admits an offer
the eligibility refuses. `GET offers` lists at most 50 open offers, oldest first, that this worker could
claim **now** — the claim's own eligibility text with the scope ignored, against the digests the worker
last reported — each `{run_id, kind, project_key, ticket_key, title, stage, role, offered_at, automatic}`
(`automatic`: the scope takes it by itself; the names from the redacted ticket snapshot, `null` when they
cannot be read; an ask never carries its question's text). `POST offers/:id/claim {image_digests}` —
*take this one* — is the one claim with its run named, not held: `200` with the package exactly as
`claims` answers it, or `409 offer_not_claimable` for every reason it claimed nothing (taken, withdrawn,
before `workers_from`, inside another user's head start, excluded, paused), which names none. A package claimed for a worker whose request closed before the answer — a held `claims` it called off, or a pick its page gave up on — is released (`shutdown`, nobody excluded) rather than sent nowhere (BACKLOG 960). It ignores
the scope and **nothing else** — a pick never jumps a hybrid, server-preferred project's `server_from`
window (Q127 (a)) — and writes one `human_actions` row `worker.take_offer` `{worker_id, run_id, via:
worker_ui}` in the claim's transaction. The page proxies them as `GET`/`POST /api/local/claim-scope`,
`GET /api/local/offers` (polled every 10 s while the page is visible) and `POST
/api/local/offers/:id/take` under the same `Host`, bearer and `Origin` rules; a take needs a free slot
on the worker (`409 no_free_slot` there, before the core is asked). `GET /api/workers` publishes each
worker's `claim_projects` (`null`, `[]`, or `[{id, key}]`), which the Workers screen shows read only.

**Protocol 4 — what a machine takes, and a pick that assigns (S-26.4, TD-031's 2026-11-06 amendment
items 6–7, BD-032's 2026-11-06 amendment).** `WORKER_PROTOCOL_VERSION = 4`, accepted `[3, 4]` (a
version-2 worker is now `426` at the protocol check). No new verb: a worker's **claim policy**
(`workers.claim_policy`, migration 0108) — `everything`, `mine_and_unassigned` (the default a new worker is
written with), `mine` or `pick_only` — is the second axis of what its **automatic** claims take,
orthogonal to the claim scope, which stays the project axis. A `null` policy (every worker before 0108)
reads `pick_only` over the legacy scope `[]` and `everything` otherwise, and the legacy `[]` narrows **no**
project once read through the policy. The claim's own statement asks `workerPolicyTakesSql` beside the
scope and the eligibility, read live from the offer's task: `mine` is a stage offer whose task the worker's
user owns, or an ask they asked (an ask's "mine" is its asker, never the task's owner); `mine_and_unassigned`
adds a stage task with no owner that is **not held elsewhere** (`taskHeldElsewhereSql`, the one fragment
the owner command, the pick and the waiting read share — a task a linked member released is unassigned).
No policy admits what the eligibility refuses, and a reassignment applies to an open offer at once. The
**online assignee** is the task's owner only when the owner's worker policy is not `pick_only` and its
scope takes the project; the head start is fixed at offer time, so a reassignment leaves the open offer's
window with the previous owner, whose `mine` machine still cannot claim it. At protocol 4 the handshake's
`worker` carries `claim_policy`; `GET claim-scope` adds `claim_policy` and `policy_skipped_offers` (open
offers its eligibility and scope admit now and its policy leaves for others — no blocker: a `mine` machine
with nothing of its own is idle by choice); `PUT claim-scope {claim_project_ids, claim_policy?}` writes the
policy beside the scope (absent leaves it), refuses `[]` with `422 claim_scope_empty` (*pick only* is the
policy) and records one `human_actions` row per change — `worker.claim_policy` `{worker_id, claim_policy,
project_ids, via}` when the policy moved, `worker.claim_scope` otherwise. A **version-3** `PUT` with `[]` is
stored as `pick_only` over every project, any other version-3 write leaves the policy as it was, and a
version-3 worker whose policy reads `pick_only` is answered `[]` — its own spelling. `GET offers` is now
**narrowed by the project list** (the pick still ignores it), `automatic` is the scope's and the policy's
answer, and at protocol 4 each entry adds `owner` (`{user_id, name}` of the task's owner, `null` for nobody)
and `mine`, beside the list's `as_of` and `policy_skipped_offers`. **A pick assigns**: `POST
offers/:id/claim {image_digests, as_of?}` of a stage offer whose task is unassigned makes the worker's user
its owner **in the claim's transaction** (`task.owner.changed`, `source: platform`, `via: pick`; a second
`human_actions` row `task.owner` `{user_id, via: pick, worker_id, run_id, changed, owner_user_id}` beside
`worker.take_offer`); a task held elsewhere is claimed without assigning; an ask assigns nothing; and a
stage task another person owns is never taken, a maintainer's included — `409 task_taken_by_another`
when its owner changed after the body's `as_of`, else `409 task_owned_by_another`, each naming the owner
(`details`: `owner.user_id`, `owner.name`), answered only to a worker the eligibility admits now. A
version-3 worker is answered `offer_not_claimable` for both. The session's `PUT
/api/workers/:id/claim-policy {claim_policy, claim_project_ids}` is the same state assertion from the
Workers screen (`via: workers_screen`), **by the worker's own user only**: an administrator is `403
claim_policy_owner_only` (they read it), anybody else's worker `404`; `[]` is `422 claim_scope_empty`, a
project the user may not run in `422 project_not_eligible`; it answers `{worker_id, claim_policy,
claim_project_ids, performed}`. `GET /api/workers` adds `claim_policy` (as it reads) and
`policy_skipped_offers` (`null` while the core cannot name its images); the local page's state adds the two
as its core last said them, and its `POST /api/local/claim-scope` takes `claim_policy`. **S-26.7's page
speaks the policy**: every save names `claim_policy` and sends `null`, never `[]`, for every project, and
it reads `GET /api/local/claim-scope?vocabulary=policy`, which answers the stored projects as they are —
a save that names its policy is answered the same way. For an **older cached page** (a tab still open on
the page an earlier image served) the worker keeps mapping protocol 3's vocabulary as the core maps a
version-3 worker (`remote-worker/page-scope.ts`): a save of `[]` with no policy is sent as `pick_only`
over every project, a list saved while the policy reads `pick_only` leaves it for `mine_and_unassigned`,
and a `pick_only` worker reads back as `[]` without the query. `GET offers?fields=held_elsewhere` (S-26.7) adds each entry's `held_elsewhere` — its task's tracker
assignee is a person the platform cannot match to a member (S-26.1's *held elsewhere*), so a pick claims
it **without** assigning. It is an **opt-in** rather than a protocol bump because the field is an
answer's: the worker parses `GET offers` strictly, so a worker built before the field is never sent it
(it never asks), and a worker that asks an older core gets no field, which the page reads as unknown and
promises no assignment. The worker asks for it, and its page shows *Take this one* with no *Assigns …
to you.* line for such a task. Its `POST /api/local/offers/:id/take`
takes `as_of`, and a `409 task_taken_by_another` / `task_owned_by_another` carries the owner the core
named as the local envelope's `error.owner` `{user_id, name}` (the name through the worker's redactor),
so the page says *Vojtěch took DEMO-1 a moment ago* without parsing a message. The project's execution
read reports a `pick_only` policy as `picked_only` under `scope_excludes`.

**Why a run waits** (S-26.5, TD-031's 2026-11-06 amendment item 8). The task record (`GET /api/tasks/:id`'s
`task` and every item of `GET /api/projects/:id/tasks`) and every `GET /api/org/agents` item carry
`waiting` — `{reason, user, last_seen_at, assignee_name, blockers}` for the run's **open** offer (the task's: its
current stage's), `null` when nothing is offered (no live run, or it was claimed). It is optional in the
schema only because the SPA's fixtures predate it (BACKLOG 1445); this build always sends it. `reason` is a
**key**, never a sentence (the web app words `waiting.<reason>`): `null` exactly when some claimant's
predicates admit the offer now — the server claimant (a fresh `server_claimants` row, and the claim's
`serverEligibleSql`) or a **connected** machine (`last_seen_at` within 60 s) whose automatic claim's
eligibility, project list and policy admit it, the claim's own fragments over the digests the row holds
and the core's (`queries/offer-waiting.ts`, held to the claim by a PostgreSQL parity test). Otherwise,
about the person the offer is *mine* of — the task's owner, or an ask's asker — each of their machines
(not revoked) gets a reason: one whose user may not run here or whose project list leaves the project
out is `owner_no_worker`; otherwise the Workers screen's own blockers (`coreClaimBlockersOf`, the function
`claim_blockers` is) decide — `revoked`, `owner_disabled`, `no_eligible_project` → `owner_no_worker`,
`pick_only` → `owner_pick_only`, then the first in the vocabulary's order: `offline` →
`owner_worker_offline`, `paused` → `owner_worker_paused`, and `images_outdated`, `images_missing`,
`protocol_outdated`, `draining`, `usage_limited` or `platform_images_unresolved` →
`owner_worker_cannot_take`, as is a machine with no blocker that the claim still refused (an exclusion,
a head start, the mode or the run credential). The person's reason is the one nearest to taking the run
(`owner_worker_cannot_take`, `owner_worker_paused`, `owner_worker_offline`, `owner_pick_only`,
`owner_no_worker`; no machine at all is `owner_no_worker`). With nobody's name on it,
`assignee_not_linked` for a task **held elsewhere** (`taskHeldElsewhereSql`; `assignee_name` is the
tracker's redacted display name) and `no_taker` for any other — a task a linked member released
included. `user` (`{user_id, name}`) is set for the five `owner_*` reasons only, `last_seen_at` (the
offline machines' newest contact) for `owner_worker_offline` only, `assignee_name` for
`assignee_not_linked` only, and `blockers` — keys of the claim-blocker vocabulary, in its order, never a
local-only one — for `owner_worker_cannot_take` only (`[]` otherwise, and `[]` there when the refusal is
the offer's or the project's). The task read for `get_task_context` skips the statement. One statement per page. The
execution read adds `others_take_unassigned`: whether the server claimant runs and the project's mode lets
it claim, or **another person's** machine (not the reader's) not revoked, able to act and run here, its
project list taking the project and its policy `everything` or `mine_and_unassigned`, with the mode and the
run credential letting workers in — connected or not, a setting's answer; it names no machine. The same
slice puts `gate_wait` (the task read's own projection) on each **board item**, and `GET /api/org/inbox`
gains `ci_held` — `[{task_id, project_id, ticket, gate_wait}]`, the `active` tasks whose open CI wait is
held at a manual job, oldest wait first (BACKLOG 1300); `gate_wait` is `null` unless the task is `active`,
so a paused task is served no wait (BACKLOG 1301; `last_gate_wait` keeps its `needs_human` rule).

**Why a worker takes nothing** (S-22.19, TD-031's 2026-11-05 blocker-vocabulary amendment): one
vocabulary, `WORKER_CLAIM_BLOCKERS` (`packages/contracts/src/worker-claim-blockers.ts`), most fundamental
first, worded once (`WORKER_CLAIM_BLOCKER_WORDS`, `apps/web/src/ui/humanize.ts`). `GET /api/workers`
adds per worker `claim_blockers` — the claim's predicates minus the per-offer ones: `revoked`,
`owner_disabled` (its user is disabled or banned), `offline` (no call in 60 s), `protocol_outdated`,
`platform_images_unresolved` (this core cannot name its own digests, so every claim is `503
digests_unresolved`), `paused`/`draining` (the hold, told apart by its newest `worker.pause` row's
`via`), `usage_limited`, `images_missing` (none reported), `images_outdated` (not the core's current run
and egress digests), `no_eligible_project` (no project its user may run in, whose mode is not
`server_only` and whose run credential may reach a worker, inside its scope — *pick only* counts every
project), `pick_only` (its claim policy reads `pick_only`, so it claims nothing by itself; S-26.4) — `can_claim` (an **automatic** claim would be
admitted) when the list is empty, and `last_claimed_at` (`run_offers.claimed_at`); the two are held to
the claim statement by `remote-claim.integration.test.ts`'s parity cases. The project's `workers` list
holds at most 500. `GET /api/projects/:id/execution`
adds `workers` — each registered worker the reader may see (every one for an administrator, their own
otherwise) with `takes` `automatically`/`picked_only`/`no`, its own `blockers` and the project's
`project_reason` (`server_only`, `credential_refused`, `role`, `scope_excludes`) — and `waiting`: the
open offers, and how many no worker may take now (`credential_refused`, `server_only`, `server_first`).
The local page's `GET /api/local/state` carries the worker's half as `claim_blockers` (`not_set_up`,
`offline`, `protocol_outdated`, `claude_rejected`, the holds, `launcher_unreachable`, `images_missing`,
`images_outdated`), and its `POST /api/local/retry` on a **connected** worker whose launcher did not
answer (or holds no image) asks the launcher again and wakes the claim loop (`409 connected` when there
is nothing to ask again). No protocol change. An open offer written before WP-278 (neither `*_from`,
no `expires_at`) is routed from its project's effective setting by the recovery pass's
`run_offer_reroute` row, once (backlog 887).

The opt-in itself is the GitLab configuration key `remote_run_credential: allow | deny` (default `deny`),
written through `PATCH /api/integrations/:id` (`integration.write`, admin), whose `human_actions` row
carries the value; the Integrations screen shows the residual beside the switch. With `allow`, a static
token travels in the package and a deploy key never does (the package carries the SSH route and the public
key; the worker signs through `ssh-sign`).

**The contract is code since WP-273** (WP-280 and WP-281 serve the verbs above, WP-282 the run-scoped calls, WP-284 `release` and `compose.yml`, WP-285 `pause`, WP-287 `update-report` — one `human_actions` row `worker.update` under the worker's user, the newest shown as the Workers screen's `last_update`):
`packages/contracts/src/worker.ts` holds `WORKER_PROTOCOL_VERSION` (4 since S-26.4), `ACCEPTED_WORKER_PROTOCOLS`
(`[N-1, N]`, today `[3, 4]`; `pnpm protocol:check` holds a bump to TD-032 decision 7), the header name, the
paths, the bounds, and a strict zod schema for every request and response body of TD-031 §9. Two
spellings, each stated there: the **HTTP DTOs are snake_case**, the house rule; the **run package**
(`runPackageSchema`, the `200` of `claims`, published as `schemas/worker-run-package.schema.json`) is
**camelCase**, the deviation TD-031 §4 states — its vocabulary is the `RunSpec` and the launcher's
`WorkspaceSpec`, which moved to `packages/contracts/src/run-spec.ts` for it, and a snake_case copy would
be a second schema for one structure. The `426` and `409 lease_lost` bodies are this page's error
envelope (`{ error: { code, message } }`), the `426` with TD-031's `accepted`, `compose_url` and
`digests` beside it; the device-token poll alone answers RFC 8628's `{ error: "<code>" }`, as TD-031
§10c asks. The package refuses a secret it must not carry: a named secret variable, a model credential's
name, the run credential or the run token in either environment, an `sk-ant-`/`wkr_` value, and a deploy
key (the core signs, TD-031 §5) — with the launcher's own credential rules, which moved beside it as
`runCredentialIssues` so both apply one copy.
