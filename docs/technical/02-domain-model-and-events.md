# 02 — Domain model and events

> Round 2 design. Derived from product/04, /05, /07, /09, /18 and BD-003, BD-005–008, BD-010, BD-017, BD-018, BD-023–030. Technology-neutral; storage in 03, runtime in 04.

## Architectural style

- **Clean architecture** with four rings: `domain` (aggregates, value objects, domain events, state machines — no I/O), `application` (use cases, event handlers, policies, sagas — depends on domain and on ports), `infrastructure` (adapters: Postgres, workflow engine, SDK runner, integration providers, search), `interfaces` (HTTP API, SSE/WebSocket, webhooks, CLI).
- **Everything is an event.** Every state change is recorded as an immutable domain event in an append-only log (BD-003) and dispatched to handlers. Handlers are registered with a **priority** (lower runs first) and are **idempotent** (keyed by the event's `position`, its physical order in the log — see `handler_executions` in technical/03; `events.id` is the stable public identity used in APIs and `cause_event_id`, not the dispatch key). A handler may emit further events (chaining) and may *not* mutate state outside its own aggregate except through commands.
- **Commands vs events.** Interfaces and handlers issue commands (`StartRun`, `AnswerQuestion`); aggregates validate and emit events (`run.started`, `question.answered`). Events are past tense, commands imperative.
- **Transactional outbox.** Aggregate state and its events are written in one transaction; a dispatcher publishes from the outbox (at-least-once), so consumers must be idempotent (TD in 03/04). The queue holds **one row per event for the whole deployment**, so completing a dispatch discharges every handler in it: a process may only sweep if it registers a handler for every type the catalogue below marks as consumed (TD-005's WP-15a amendment).
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
| **ScheduledJob** (maintenance) | project, schedule, chore type, budget, last run | product/18. |

## State machines

### Task
```
queued ─► active(stage=…) ─► … ─► ready_for_merge ─► merged ─► retro ─► done
   │           │  ▲                     │
   │           │  └── returned(stage) ◄─┘ (human comments / rework)
   │           ├─► waiting_answers ─► active
   │           ├─► waiting_approval ─► active | needs_human
   │           ├─► paused(budget|manual|taken_over) ─► active
   │           └─► needs_human ─► active | cancelled
   └─► cancelled
```
Guards: WIP limits on `queued → active`; iteration limits on any `returned`; budget on every `active` entry; readiness/autonomy policies on approvals.

### Run
`created → starting → running → (completed | failed | cancelled | budget_exceeded | timed_out | stalled)`. `running` emits `run.output` stream events (not stored in the domain log; stored in the transcript store, see 03) and heartbeats; `stalled` after no output for `stall_timeout` (default 5 min, research/01).

### Question
`open → answered | expired → (escalated)`; reminders at configurable offsets; `expired` after 1 working day by default (Q8).

### Approval
`pending → approved | rejected | expired`.

### KnowledgeProposal
`scored → (discarded | queued | auto_applied) → (applied | rejected)`.

## Event catalogue

Naming: `<aggregate>.<past-tense>`; payload always includes `task_id` when task-scoped and `project_id`. `actor` lives in the **event envelope**, not in each payload (implemented that way in WP-01, matching `events.actor` in technical/03); the `actor` column in the catalogue below therefore describes the envelope value for that event, not a payload field. Priorities: 0–99 platform core, 100–199 integrations, 200–299 notifications/UI, 300+ custom project handlers.

> **`run.created` (added at WP-02).** The catalogue originally started the Run's history at `run.started`, leaving the `created→starting` transition silent and the run's existence unreplayable — which contradicts this document's own rule that every state change is recorded as an immutable domain event. Question `expired→escalated` and question reminders remain deliberately event-free: the former is recorded by `task.escalated`, the latter changes no aggregate state worth replaying.

**The "Core consumers" column is normative, not illustrative** (TD-005's WP-15a amendment). An entry
naming any consumer declares the event **consumed**: a process that sweeps the outbox must register a
handler for it, or it destroys a work item belonging to another process in the deployment. An entry of
**`—` declares the event unconsumed** — nothing is expected to handle it, and a sweeper needs no handler
for it. `packages/application/src/events/consumption.ts` is that column as code, its keys held to
`DOMAIN_EVENT_TYPES` so a new event type cannot be added without answering the question. **It differs
from this column on 25 rows today** (28 before WP-19, which closed `run.finished`, `run.failed` and
`artifact.created`) — the column states the finished product's consumers and the declaration states
this build's, so each divergent entry names the work package that closes it (TD-005's amendment
records the trade).

| Event | Producer | Payload (key fields) | Core consumers (priority) |
|---|---|---|---|
| `ticket.matched` | task-management adapter | ticket ref, rule, priority, type, epic, links | Intake (10) |
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
| `task.approval.requested` / `.decided` | Pipeline / Approval | approval | Slack buttons (210), pipeline (10) |
| `task.escalated` | Pipeline | task, reason, blocker brief | Ticket (110), Slack (210) |
| `task.paused` / `task.resumed` | Budget/Human | task, reason | UI, workpad |
| `task.taken_over` / `task.handed_back` | Human | task, branch, session, stage | Workspace export (10), ticket (110) |
| `task.cancelled` / `task.completed` | Pipeline | task, outcome, totals | Ticket transition (110), Slack (210), stats (230) |
| `run.created` | Runner | run, task, stage, role, mode, attempt, run key | UI (220) |
| `run.started` | Runner | run, model, effort, prompt version, context pack | UI (220) |
| `run.finished` / `run.failed` | Runner | run, status, usage, cost, exit reason | Cost ledger (10), stage executor (20), UI |
| `run.steered` | Human | run, message, author | Runner (10) |
| `artifact.created` | Stage executor | artifact | Workpad (120), UI |
| `workspace.provisioned` / `.destroyed` / `.exported` | Workspace manager | workspace | UI |
| `mr.opened` / `mr.updated` / `mr.merged` / `mr.closed` | git adapter | mr ref, actor, draft, head sha, diff stats | Pipeline (10), stats (230) |
| `mr.review.comment` | git adapter | mr, thread id, author identity, text, resolved | Batching/debounce (10), feedback intake (30) |
| `ci.pipeline.finished` | git adapter | mr, head sha, status, failed jobs, log refs, coverage | CI gate (10), flaky detector (15) |
| `default_branch.moved` | git adapter | project, new head | Rebase gate (10), conflict warning (20) |
| `budget.threshold.reached` / `budget.exhausted` / `budget.reset` | Budget projection | scope, window, pct | Scheduler (10), Slack (210) |
| `feedback.received` | Feedback | feedback | Feedback intake agent (30) |
| `knowledge.proposal.created` / `.applied` / `.rejected` | Librarian / Human | proposal | Index rebuild (40), UI |
| `knowledge.index.rebuilt` | Indexer | project, commit | — |
| `readiness.evaluated` | Discovery / CI gate | project, level, criteria | Policy suggestions (20), UI |
| `config.changed` | Settings / repo sync | scope, diff (secrets redacted), actor | Audit (0), effective config rebuild (10) |
| `integration.action.performed` / `.failed` | adapters | integration, action, payload (redacted), result | Audit (0), health (20) |
| `shadow.report.created` | Shadow runner | task, comparison | UI |

Custom project stages (product/04) register handlers on `task.stage.completed` for a predecessor and emit `task.stage.entered` for themselves; the platform validates the template graph at load.

## Sagas (long-running application processes)

- **PipelineSaga** (one per task): owns the task state machine, listens to stage/gate/question/approval/MR/CI events, applies templates and policies, starts runs, enforces iteration limits and budgets. Implemented as a durable workflow (TD in 04/01).
- **QuestionSaga**: reminders, expiry, escalation.
- **ReviewCommentBatcher**: debounces `mr.review.comment` for 2 minutes per MR then emits one `task.stage.returned`.
- **BudgetProjector**: folds cost entries into budget spent; emits threshold events.
- **KnowledgeSaga**: retro → proposals → Librarian → apply policy → index rebuild.
- **ShadowSaga**: like PipelineSaga, plus a comparison step. Nothing is replaced: outbound actions go through the same `IntegrationActionExecutor` as a normal task, and its shadow guard refuses every *mutating* one — the task's `mode` is a required, zod-parsed field on a mutating request, and a shadow task's write is recorded `would_have` without reaching the provider (technical/06 § "Outbound: actions"). Reads are performed normally, because a shadow task needs its context.
- **MaintenanceScheduler**: creates chore tasks on schedule within budget.

## Invariants (enforced in domain)

- A task has at most one active run at a time.
- Iteration counters never exceed their limits without an `task.escalated` event.
- No run starts when any applicable budget is exhausted; running runs are never killed by org/project budgets (BD-010).
- Shadow tasks never produce `integration.action.performed` for mutating actions.
- Only events from verified identities can trigger `question.answered`, `approval.decided`, `task.stage.returned` by human, `feedback.received` (BD-022).
- Artifacts are versioned; a stage re-run creates a new version, never overwrites.
