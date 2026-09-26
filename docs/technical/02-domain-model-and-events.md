# 02 — Domain model and events

> Round 2 design. Derived from product/04, /05, /07, /09, /18 and BD-003, BD-005–008, BD-010, BD-017, BD-018, BD-023–030. Technology-neutral; storage in 03, runtime in 04.

## Architectural style

- **Clean architecture** with four rings: `domain` (aggregates, value objects, domain events, state machines — no I/O), `application` (use cases, event handlers, policies, sagas — depends on domain and on ports), `infrastructure` (adapters: Postgres, workflow engine, SDK runner, integration providers, search), `interfaces` (HTTP API, SSE/WebSocket, webhooks, CLI).
- **Everything is an event.** Every state change is recorded as an immutable domain event in an append-only log (BD-003) and dispatched to handlers. Handlers are registered with a **priority** (lower runs first) and are **idempotent** (keyed by the event's `position`, its physical order in the log — see `handler_executions` in technical/03; `events.id` is the stable public identity used in APIs and `cause_event_id`, not the dispatch key). A handler may emit further events (chaining) and may *not* mutate state outside its own aggregate except through commands.
- **Commands vs events.** Interfaces and handlers issue commands (`StartRun`, `AnswerQuestion`); aggregates validate and emit events (`run.started`, `question.answered`). Events are past tense, commands imperative.
- **Transactional outbox.** Aggregate state and its events are written in one transaction; a dispatcher publishes from the outbox (at-least-once), so consumers must be idempotent (TD in 03/04). The queue holds **one row per event for the whole deployment**, so completing a dispatch discharges every handler in it: a process may only sweep if it registers a handler for every type the catalogue below marks as consumed (TD-005's WP-15a amendment).
- **A dispatch is bounded** (added at WP-49; this document previously described a retry with no end). A handler that fails leaves its event queued with a doubling backoff, and the events behind it in its stream wait — which is the intended trade only while the failure is transient. After `APP_DISPATCH_MAX_ATTEMPTS` attempts (**10**, about twenty minutes at the shipped backoff) the event is **dead-lettered**: `event_dispatch.dead_lettered_at` is set in the same transaction that recorded the last failure, the sweep and the ordering guard both skip the row from then on, and the stream moves on. Two things follow from `events` being append-only: nothing is lost — the event is still in the log and still replayable by `events/replay.ts` — and the dead letter is a decision about the *work item*, exactly as completing one is (rule 73's argument). What a human sees is Q59's answer reused: the task the event belongs to (its stream, or its `correlation_id`) is parked in `needs_human` with a brief naming the event position and the handler, **in the same transaction**, so there is no second escalation to deduplicate and no window in which the event is dead and nobody has been told. An event that names no task escalates nothing and is an operator's to read: `event_dispatch_dead_lettered` is the metric, beside `event_dispatch_pending`.
- **A handler's transaction holds database work and nothing else** (added at WP-15d, and this document was silent about it before). A handler runs inside two transactions — the dispatcher's, which owns the event's queue row for the whole dispatch, and its own — so anything it does is done holding two pooled connections and one of the deployment's `APP_DISPATCH_MAX_CONCURRENCY` dispatch slots, which ships as **1**. A call to another system therefore does not belong there, whichever priority band the handler is in: it holds both connections for the length of somebody else's round trip, and it makes the audit write that records it nest inside the caller's transaction rather than follow it. Measured at the shipped defaults with one provider read held open: an event with nothing to do with that provider **was not dispatched at all** until the call returned. The handler *decides*; a job enqueued from `HandlerContext.afterCommit` *calls* (TD-004, TD-005) — see technical/06 § "Outbound: actions" for the outbound half and the rules the job is then held to.

## Aggregates and entities

| Aggregate | Key entities / value objects | Notes |
|---|---|---|
| **Organisation** | settings (timezone, provider mode, default models, retention), budgets | Exactly one per instance (BD-009). |
| **User** | email, role (admin/maintainer/member/viewer), external identities (jira account id, gitlab user id, slack user id) | Mapping by email (BD-006, Q10). |
| **Project** | repository ref, `agentic_dir`, `knowledge_dir`, bindings (per integration type), pipeline config (effective), autonomy level + overrides, readiness level + criteria, WIP limits, budgets, feature flags (product/18), status mapping | Effective config is materialised with source per key (defaults < org < project < repo). |
| **Integration** | type, provider, config (non-secret), secret refs, health, webhook secret ref | Org-level; project **Binding** holds project-specific config. |
| **Task** | ticket ref (provider, key, url), template, mode (`normal | shadow`), state, current stage, stage history, iteration counters (per loop), cost totals, estimate, workpad ref, MR ref, branch, requested_by, risk classes, dependencies | 1:1 with a ticket for `normal`; shadow tasks reference the ticket but never act outward. |
| **Run** | task, stage, role, attempt, model, effort, permission policy, tools/MCP/skills loaded, prompt version, settings snapshot hash + copy, context pack (list of KB docs with reason and tokens), session id, status, exit reason, usage (input/output/cache write/cache read, per model), cost (actual or estimated + flag), turns, timings, transcript ref | The audit unit (BD-003). |
| **Artifact** | task, type, version, markdown, structured JSON (validated against the artifact schema), produced_by run | Types: RefinedSpec, RootCauseAnalysis, ImplementationPlan, ImplementationNotes, ReviewVerdict, AcceptanceVerdict, RetroReport, ShadowReport, ReadinessReport, DiscoveryDraft. |
| **Question** | task, stage, run, text, options, blocking flag, status, answer, answered_by, channel, deadline, reminders sent | Posted to ticket/Slack/UI; first answer wins. |
| **Approval** | task, kind (`plan | budget | knowledge | rework`), status, decided_by, reason, deadline | Only mapped maintainers decide. |
| **Workspace** | task, runner, path, status (`provisioning | ready | in_use | paused | exported | destroyed`), base commit, retention deadline | One per task; export for take-over. |
| **Budget** | scope (org/project/task/run), window, amount, spent, thresholds notified | Spent is a projection over the cost ledger. |
| **CostEntry** (ledger) | run, model, tokens by kind, cost, is_estimate, price table version, attribution (project/epic/task/stage) | Append-only. |
| **KnowledgeProposal** | project, source (task/run/feedback/bootstrap/human), significance score, diff (paths + patch), provenance, status (`queued | applied | rejected | discarded`), decided_by | BD-018 thresholds. |
| **Feedback** | author (mapped user), scope, text, rating, source channel, linked proposal | BD-022: unverified authors are recorded, never acted on. |
| **Event** | id (time-ordered), aggregate type/id, sequence within aggregate, type, payload, actor (system/user/integration), cause (event id), correlation (task id), created_at | The log. |
| **ScheduledJob** (maintenance) | project, schedule, chore type, budget, last run | product/18. **Amended at WP-36: not an aggregate and not a table.** Four of the five fields are already stored in the project's own configuration document (`features.maintenance.{schedule, chores, budget_usd}`, which is where product/18's wizard column puts them) and the fifth — *last run* — is derivable from a row the platform already writes: a scheduled chore's task carries the platform-issued key `chore!<type>-<period>` under `unique (project_id, ticket_key, mode)`, so *"has this period's chore been created?"* is a `tasks` lookup and a cron that fires twice creates one task. A `scheduled_jobs` table would be a second copy of a schedule a repository owns and could rewrite. The precedent is TD-004's own *"index rebuilds, maintenance schedules"* family: `registerPartitionMaintenance` and `registerPriceListMaintenance` both run on a cron with no state of their own. |

## State machines

### Task
```
queued ─► active(stage=…) ─► … ─► ready_for_merge ─► merged ─► retro ─► retro ─► done
   │           │  ▲                     │                                      ▲
   │           │  └───────────────────────── (a template with no merge) ───────┘
   │           │  ▲                     │
   │           │  └── returned(stage) ◄─┘ (human comments / rework)
   │           ├─► waiting_answers ─► active
   │           ├─► waiting_approval ─► active | needs_human
   │           ├─► paused(budget|manual|taken_over) ─► active
   │           └─► needs_human ─► active | cancelled
   └─► cancelled
```
Guards: WIP limits on `queued → active`; iteration limits on any `returned`; budget on every `active` entry; readiness/autonomy policies on approvals.

*Which* limit a `returned` spends is decided by the transition and not only by the stage it leaves (WP-26). `ready_for_merge` has two outgoing returns — a human's comment, which is BD-008's `human_rounds`, and the default branch moving, which re-enters the rebase gate — and attributing the second to the first escalated a task with *"human_rounds iteration limit of 3 reached: main moved to …"* after three merges to `main` under a waiting merge request. The edges that need their own loop are enumerated in `RETURN_LOOPS_BY_EDGE` (`packages/domain/src/pipeline/interpreter.ts`); everything else is attributed by the stage, and an edge in neither table cannot return at all.

> **`retro → retro` was added at WP-18b**, when the librarian stage went back into the shipped
> templates (technical/12's example has always carried it). The retrospective phase now has **two**
> stages — the facilitator's report and the Librarian's curation of the proposals it produced — and
> both run with the task in `retro`. The alternative would have been moving the task back to
> `active`, which `retro` deliberately has no edge to: a merged task never goes back to work.
>
> **`active → done` was added at WP-21**, and it closes a gap rather than widening a guarantee. The
> diagram above has only one edge into `done` (`retro → done`), so a template that finishes without
> a merge could not finish at all: the interpreter asked for `complete`, the machine refused, and
> the task was escalated to `needs_human` with a blocker brief blaming the template. Two shipped
> shapes need it — the **discovery** template of product/06 § "Step 2" (one read-only agent stage
> that drafts a knowledge base; no ticket, no branch, no merge request) and product/04's **spike**
> template, which "ends at a human with no MR" and has therefore never been runnable. It takes
> nothing away from BD-007: *which* stage a task ends at is the interpreter's decision from the
> template, and every ticket template still runs `ready_for_merge → merged → retro → done`, so no
> ticket can reach `done` without a human merge.
>
> **A third shape uses the same edge since WP-24**: the **review_only** template of product/04
> § "Operating modes that reuse stages" — `intake → code_review → done`, the Reviewer alone on a
> human's merge request. It opens no merge request of its own (product/18 level 0), so it ends the
> same way discovery does; and both of the Reviewer's verdicts point at `done`, because product/18
> requires the summary to *never block merge* and the interpreter reads a missing `return_to` as
> "escalate". `packages/domain/src/pipeline/templates.ts` carries that argument.
>
> **A fourth uses it since WP-25**: the **ticket_lint** template of product/18's readiness linter —
> `intake → ticket_lint → done`, the Product Manager alone on a ticket nobody handed to the agent.
> Its stage is declared `advisory` (`agentStageSchema`), which is the one thing the other three did
> not need: a `RefinedSpec` normally *decides* the transition, and the artifact a lint produces for
> an unready ticket is exactly the one that would park the task on blocking questions (`decision:
> ask`) or escalate it (`reject`). An advisory stage always advances, and the platform reads the
> artifact afterwards to write the comment.

### Run
`created → starting → running → (completed | failed | cancelled | budget_exceeded | timed_out | stalled)`. `running` emits `run.output` stream events (not stored in the domain log; stored in the transcript store, see 03) and heartbeats; `stalled` after no output for `stall_timeout` (default 5 min, research/01).

### Question
`open → answered | expired → (escalated)`; reminders at configurable offsets; `expired` after 1 working day by default (Q8).

> **As built at WP-56.** `deadline_at` is written in the transaction that stores the question, from `pipeline.limits.question_timeout` on the organisation's working calendar (`APP_WORKING_DAYS`/`APP_WORKING_HOURS`/`APP_HOLIDAYS` in `TZ`); the timer is one `deadline.sweep` job armed after commit by the `pipeline.deadlines` handler — the catalogue's *timer (15)* below — on `task.question.asked`, and it re-validates on fire. **Reminders are not built**: `questionReminderTimes` computes them and nothing sends one.

### Approval
`pending → approved | rejected | expired`.

> **As built at WP-56 (BD-006's Q95 amendment).** A plan or budget approval expires on the question's calendar and limit — same key, same default, no dial cell — through the same `deadline.sweep` timer armed on `task.approval.requested`; `expired` is recorded as `task.approval.decided` with `decision: 'expired'`, and the saga escalates the task to `needs_human`. A taken-over task (product/19 §19) rides the same timer: 5 working days after `task.taken_over` with no hand-back, resume, stage entry, completion or cancellation since, the task escalates.

### KnowledgeProposal
`scored → (discarded | queued | auto_applied) → (applied | rejected)`.

> **Read at WP-18b, which built the machine.** There is no state between "a human said yes" and "a
> commit carries it", and that is deliberate rather than an omission: **`queued` with `decided_at`
> set is the approved state**, `auto_applied` is the same fact decided by BD-018's policy instead of
> by a person, and both become `applied` when a commit carries them (`applied_commit_sha`). A sixth
> status would have meant a migration, a new label in three enums and a state the UI would have to
> learn, for a fact two existing columns already carry. `discarded` is written rather than skipped —
> technical/07's "below `discard_below` → dropped (audit only)" is an audit only if the drop is
> visible.

## Event catalogue

Naming: `<aggregate>.<past-tense>`; payload always includes `task_id` when task-scoped and `project_id`. `actor` lives in the **event envelope**, not in each payload (implemented that way in WP-01, matching `events.actor` in technical/03); the `actor` column in the catalogue below therefore describes the envelope value for that event, not a payload field. Priorities: 0–99 platform core, 100–199 integrations, 200–299 notifications/UI, 300+ custom project handlers.

> **`run.created` (added at WP-02).** The catalogue originally started the Run's history at `run.started`, leaving the `created→starting` transition silent and the run's existence unreplayable — which contradicts this document's own rule that every state change is recorded as an immutable domain event. Question `expired→escalated` and question reminders remain deliberately event-free: the former is recorded by `task.escalated`, the latter changes no aggregate state worth replaying.

**The "Core consumers" column is normative, not illustrative** (TD-005's WP-15a amendment). An entry
naming any consumer declares the event **consumed**: a process that sweeps the outbox must register a
handler for it, or it destroys a work item belonging to another process in the deployment. An entry of
**`—` declares the event unconsumed** — nothing is expected to handle it, and a sweeper needs no handler
for it. `packages/application/src/events/consumption.ts` is that column as code, its keys held to
`DOMAIN_EVENT_TYPES` so a new event type cannot be added without answering the question. **It differs
from this column on 18 rows today** (22 before WP-41, which closed `task.review.observed`, `task.lint.posted`,
`task.rebase.checked` and `task.conflict.warned`; 23 before WP-29, which closed `run.steered`; 25 before WP-32,
which closed `budget.threshold.reached` and `budget.exhausted`; 28 before WP-19, which closed
`run.finished`, `run.failed` and `artifact.created`) — the column states the finished product's consumers and the declaration states
this build's, so each divergent entry names the work package that closes it, or — for `mr.updated`, whose payload carries
no author — the backlog entry that says why nothing will (TD-005's amendment records the trade).

> **The Slack consumer at priority 210 exists, since WP-32.** The six task rows below that name it —
> `task.created`, `task.stage.returned`, `task.question.asked`, `task.escalated`, `task.cancelled`
> and `task.completed` — and the two budget rows are served by one handler, `notify.chat`
> (`packages/application/src/notify/handlers.ts`), which **decides** and enqueues; the
> `pipeline.outbound` duty makes the call, because a provider call inside a handler's transaction
> holds a pooled connection and the dispatch slot for the length of an HTTP round trip (WP-15d).
> Two consumers this column names are still absent and are named here rather than left to be
> inferred: the **buttons** on `task.approval.requested` (the inbound half needs a Socket Mode
> connection nothing starts, so a button would be dead) and the whole **UI band** at 220 (WP-20's
> realtime projection). An **organisation**-scoped budget cannot be notified at all — a chat binding
> belongs to a project and that payload carries no `project_id` — which `decideNotification` says at
> the line.

> **The human-time projector at priority 230 exists, since WP-29** (`human-time/projector.ts`,
> product/19 §16). It is a **second** consumer of four types this column already marks consumed —
> `mr.review.comment`, `mr.merged`, `task.question.answered` and `task.approval.decided` — plus
> `run.steered`, which had none, and whose row below now names it.
>
> **Two of the three review anchors have no event in this catalogue, and that is the projector's
> stated residual.** product/19 §16 starts the review window at *"the first human MR activity
> (comment, approval, review start)"*, and there is **no `mr.approved`** type and no
> review-requested type — so a reviewer who approves a merge request without writing a comment
> contributes **zero minutes**. Under-counting is the honest direction: the alternative is to guess
> minutes for an event the platform never saw. `mr.updated` is **not** read either, and
> deliberately — it carries no author at all, so it could attribute a minute to nobody, and it
> fires for the platform's own pushes.

| Event | Producer | Payload (key fields) | Core consumers (priority) |
|---|---|---|---|
| `ticket.matched` | task-management adapter | ticket ref, rule, priority, type, epic, links | Intake (10) |
| `ticket.created` | task-management adapter | ticket ref, issue type | Ticket readiness linter (10, WP-25) |
| `ticket.comment.added` | adapter | ticket, comment id, author identity, text | Question answering (20), Feedback intake (30) |
| `ticket.status.changed` | adapter | ticket, from, to, actor | Task sync (20) |
| `task.created` | Intake | task, template, mode, estimate | Workpad (110), Slack notify (210), UI (220) |
| `task.queued` / `task.dequeued` | Scheduler | task, reason (wip) | UI |
| `task.stage.entered` | Pipeline | task, stage, attempt | Stage executor (10), status mapping (110), workpad (120) |
| `task.stage.completed` | Stage executor | task, stage, artifact ids, verdict | Pipeline transition (10), custom stages (300+) |
| `task.stage.returned` | Pipeline | task, from, to, reason, feedback ref, iteration | Stage executor (10), workpad (120), Slack (210) |
| `task.question.asked` | Stage executor | question | Ticket comment (110), Slack (210), UI inbox (220), timer (15) |
| `task.question.answered` | Question | question, answer, author, channel | Pipeline resume (10), other channels update (110) |
| `task.question.expired` | Timer | question | Escalation (10) |
| `task.approval.requested` / `.decided` | Pipeline / Approval (`.decided` with `expired` from the timer, WP-56) | approval | Slack buttons (210), pipeline (10), timer (15, `.requested` — WP-56) |
| `task.escalated` | Pipeline | task, reason, blocker brief | Ticket (110), Slack (210) |
| `task.paused` / `task.resumed` | Budget/Human | task, reason | UI, workpad |
| `task.taken_over` / `task.handed_back` | Human | task, branch, session, stage | Workspace export (10), ticket (110), timer (15, `.taken_over` — WP-56) |
| `task.cancelled` / `task.completed` | Pipeline | task, outcome, totals | Ticket transition (110), Slack (210), stats (230) |
| `task.review.observed` | Review-only (WP-24) | task, mr, head sha reviewed and now, threads posted/resolved/accepted/dismissed/unresolved | stats (230) |
| `task.lint.posted` | Ticket readiness linter (WP-25) | task, ticket, score, missing elements, questions posted, the ticket's `updated_at` | stats (230) |
| `task.rebase.checked` | Rebase gate (WP-26) | task, mr, conflicts, attempt, outcome (`clean`/`resolved`/`conflicted`/`exhausted`) | stats (230) |
| `task.conflict.warned` | Rebase gate (WP-26) | task, mr, the other task and its ticket key, overlapping paths, how many, whether the comparison was cut | stats (230) |
| `run.created` | Runner | run, task, stage, role, mode, attempt, run key | UI (220) |
| `run.started` | Runner | run, model, effort, prompt version, context pack | UI (220) |
| `run.finished` / `run.failed` | Runner | run, status, usage, cost, exit reason | Cost ledger (10), stage executor (20), UI |
| `run.steered` | Human | run, message, author | Runner (10), human time (230, WP-29) |
| `artifact.created` | Stage executor | artifact | Workpad (120), UI |
| `workspace.provisioned` / `.destroyed` / `.exported` | Workspace manager | workspace | UI |
| `mr.opened` / `mr.updated` / `mr.merged` / `mr.closed` | git adapter | mr ref, actor, draft, head sha, diff stats | Pipeline (10), review-only (10 on `opened`, 120 on `merged`/`closed`, WP-24), stats (230) |
| `mr.review.comment` | git adapter | mr, thread id, author identity, text, resolved | Batching/debounce (10), feedback intake (30), human time (230, WP-29) |
| `ci.pipeline.finished` | git adapter | mr, head sha, status, failed jobs, log refs, coverage | CI gate (10), flaky detector (15) |
| `default_branch.moved` | git adapter | project, new head | Rebase gate (10), KB index (40) |
| `budget.threshold.reached` / `budget.exhausted` / `budget.reset` | Budget projection | scope, window, pct | Scheduler (10), Slack (210, WP-32 — `reset` excepted: a window rolling over is not news) |
| `feedback.received` | Feedback | feedback | Feedback intake agent (30) |
| `knowledge.proposal.created` / `.applied` / `.rejected` | Librarian / Human | proposal | Index rebuild (40), UI |
| `knowledge.index.rebuilt` | Indexer | project, commit | — |
| `readiness.evaluated` | Discovery / CI gate | project, level, criteria | Policy suggestions (20), UI |
| `config.changed` | Settings / repo sync | scope, diff (secrets redacted), actor | Audit (0), effective config rebuild (10) |
| `integration.action.performed` / `.failed` | adapters | integration, action, payload (redacted), result | Audit (0), health (20) |
| `shadow.report.created` | Shadow report duty (WP-34) | task, artifact ref | Batch completion (40), UI |

**Amendment (WP-26): the conflict warning is a consumer of `task.stage.entered`, not of `default_branch.moved`.** This table listed *"conflict warning (20)"* against the default branch moving, which is one of the two moments product/04 S6b names and not the other: a warning is also owed *before Ready*, when two open merge requests touch the same files and nothing has moved. Both moments are the same stage entry — `ready_for_merge`'s `on` list sends a moved default branch back to `rebase_gate`, so the gate is entered in both cases — so `pipeline.conflict.warning` listens to `task.stage.entered` and filters on the gate (priority 120, the integrations band, because it tells the outside world about a transition the core band has decided). The row above now names the consumer this build actually registers for that event. The KB indexer (WP-18a) is the other one.

Custom project stages (product/04) register handlers on `task.stage.completed` for a predecessor and emit `task.stage.entered` for themselves; the platform validates the template graph at load.

## Sagas (long-running application processes)

- **PipelineSaga** (one per task): owns the task state machine, listens to stage/gate/question/approval/MR/CI events, applies templates and policies, starts runs, enforces iteration limits and budgets. Implemented as a durable workflow (TD in 04/01).
- **QuestionSaga**: reminders, expiry, escalation.
- **ReviewCommentBatcher**: debounces `mr.review.comment` for 2 minutes per MR then emits one `task.stage.returned`.
- **BudgetProjector**: folds cost entries into budget spent; emits threshold events.
- **KnowledgeSaga**: retro → proposals → Librarian → apply policy → index rebuild.
- **ShadowSaga**: like PipelineSaga, plus a comparison step. Nothing is replaced: outbound actions go through the same `IntegrationActionExecutor` as a normal task, and its shadow guard refuses every *mutating* one — the task's `mode` is a required, zod-parsed field on a mutating request, and a shadow task's write is recorded `would_have` without reaching the provider (technical/06 § "Outbound: actions"). Reads are performed normally, because a shadow task needs its context.
- **MaintenanceScheduler**: creates chore tasks on schedule within budget. **Built at WP-36** as a daily cron (`maintenance.schedule`, `exclusive`) rather than as an event-driven saga — there is no event to react to — walking the projects and creating one ordinary `chore` task per due chore type per period (`packages/application/src/maintenance/scheduler.ts`). Three of product/18:31's five chore types are **refused by name** on this build (`flaky`, `docs`, `lint`) and the reason per type is `MAINTENANCE_CHORES` in the domain ring; the *"within budget"* half is `features.maintenance.budget_usd`, enforced at every chore run's admission by the stage executor against `cost_entries` **and against the chore runs the ledger has not recorded yet**, in the mechanism WP-34 built for shadow mode (the ledger writes from a handler that commits after the run's own transaction, so a cap read from its rows alone admits one run per dispatcher lag — measured, and stated at `packages/application/src/cost/pending.ts`).

## Invariants (enforced in domain)

- A task has at most one active run at a time.
- Iteration counters never exceed their limits without an `task.escalated` event.
- No run starts when any applicable budget is exhausted; running runs are never killed by org/project budgets (BD-010).
- Shadow tasks never produce `integration.action.performed` for mutating actions — **with one declared exception since WP-76** (Q98 (a), TD-028 decision 7 as superseded): a `read`-scoped git credential mint, which a shadow run needs to fetch a private repository, and a git credential revoke of any scope (revoking only removes access). The carve-out is declared on the request, carries no idempotency key, and is checked in every mode: declared on any other action, or on a mint of any other scope, it is refused.
- Only events from verified identities can trigger `question.answered`, `approval.decided`, `task.stage.returned` by human, `feedback.received` (BD-022).
- Artifacts are versioned; a stage re-run creates a new version, never overwrites.
