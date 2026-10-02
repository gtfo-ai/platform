# 02 — Domain model and events

> Round 2 design. Derived from product/04, /05, /07, /09, /18 and BD-003, BD-005–008, BD-010, BD-017, BD-018, BD-023–030. Technology-neutral; storage in 03, runtime in 04.

## Architectural style

- **Clean architecture** with four rings: `domain` (aggregates, value objects, domain events, state machines — no I/O), `application` (use cases, event handlers, policies, sagas — depends on domain and on ports), `infrastructure` (adapters: Postgres, workflow engine, SDK runner, integration providers, search), `interfaces` (HTTP API, SSE/WebSocket, webhooks, CLI).
- **Everything is an event.** Every state change is recorded as an immutable domain event in an append-only log (BD-003) and dispatched to handlers. Handlers are registered with a **priority** (lower runs first) and are **idempotent** (keyed by the event's `position`, its physical order in the log — see `handler_executions` in technical/03; `events.id` is the stable public identity used in APIs and `cause_event_id`, not the dispatch key). A handler may emit further events (chaining) and may *not* mutate state outside its own aggregate except through commands.
- **Commands vs events.** Interfaces and handlers issue commands (`StartRun`, `AnswerQuestion`); aggregates validate and emit events (`run.started`, `question.answered`). Events are past tense, commands imperative.
- **Transactional outbox.** Aggregate state and its events are written in one transaction; a dispatcher publishes from the outbox (at-least-once), so consumers must be idempotent (TD in 03/04). The queue holds **one row per event for the whole deployment**, so completing a dispatch discharges every handler in it: a process may only sweep if it registers a handler for every type the catalogue below marks as consumed (TD-005's WP-15a amendment).
- **A dispatch is bounded** (added at WP-49; this document previously described a retry with no end). A handler that fails leaves its event queued with a doubling backoff, and the events behind it in its stream wait — which is the intended trade only while the failure is transient. After `APP_DISPATCH_MAX_ATTEMPTS` attempts (**10**, about twenty minutes at the shipped backoff) the event is **dead-lettered**: `event_dispatch.dead_lettered_at` is set in the same transaction that recorded the last failure, the sweep and the ordering guard both skip the row from then on, and the stream moves on. Two things follow from `events` being append-only: nothing is lost — the event is still in the log and still replayable by `events/replay.ts` — and the dead letter is a decision about the *work item*, exactly as completing one is (rule 73's argument). What a human sees is Q59's answer reused: the task the event belongs to (its stream, or its `correlation_id`) is parked in `needs_human` with a brief naming the event position and the handler, **in the same transaction**, so there is no second escalation to deduplicate and no window in which the event is dead and nobody has been told. An event that names no task escalates nothing and is an operator's to read: `event_dispatch_dead_lettered` is the metric, beside `event_dispatch_pending`. **Since WP-95** an administrator reads the rows themselves (`GET /api/org/dead-letters`, Settings → Dead letters) and re-queues one (`POST /api/org/dead-letters/:position/requeue`): the queue row goes back to `pending` under its own row lock (a locking read decides which of two concurrent re-queues proceeds), nothing is appended, and the handlers that already succeeded for the event are skipped by `handler_executions`, so a re-dispatch runs the failed handler and those after it once each. It is a command on the queue row, not a replay — `events/replay.ts` serves a range of the log to a handler set and never touches `event_dispatch`.
- **A handler's transaction holds database work and nothing else** (added at WP-15d, and this document was silent about it before). A handler runs inside two transactions — the dispatcher's, which owns the event's queue row for the whole dispatch, and its own — so anything it does is done holding two pooled connections and one of the deployment's `APP_DISPATCH_MAX_CONCURRENCY` dispatch slots, which ships as **1**. A call to another system therefore does not belong there, whichever priority band the handler is in: it holds both connections for the length of somebody else's round trip, and it makes the audit write that records it nest inside the caller's transaction rather than follow it. Measured at the shipped defaults with one provider read held open: an event with nothing to do with that provider **was not dispatched at all** until the call returned. The handler *decides*; a job enqueued from `HandlerContext.afterCommit` *calls* (TD-004, TD-005) — see technical/06 § "Outbound: actions" for the outbound half and the rules the job is then held to.

## Aggregates and entities

| Aggregate | Key entities / value objects | Notes |
|---|---|---|
| **Organisation** | settings (timezone, provider mode, default models, retention), budgets | Exactly one per instance (BD-009). |
| **User** | email, role (admin/maintainer/member/viewer), external identities (jira account id, gitlab user id, slack user id) | Mapping by email (BD-006, Q10). |
| **Project** | repository ref, `agentic_dir`, `knowledge_dir`, bindings (per integration type), pipeline config (effective), autonomy level + overrides, readiness level + criteria, WIP limits, budgets, feature flags (product/18), status mapping | Effective config is materialised with source per key (defaults < org < project < repo). |
| **Integration** | type, provider, config (non-secret), secret refs, health, webhook secret ref | Org-level; project **Binding** holds project-specific config. |
| **Task** | ticket ref (provider, key, url), template (+ the dial's pipeline policies frozen at start, WP-62), mode (`normal | shadow`), state, current stage, stage history, iteration counters (per loop), cost totals, estimate, workpad ref, MR ref, branch, requested_by, risk classes, dependencies | 1:1 with a ticket for `normal`; shadow tasks reference the ticket but never act outward. |
| **Run** | task, stage, role, attempt, model, effort, permission policy, tools/MCP/skills loaded, prompt version, settings snapshot hash + copy (written at run creation since WP-91 — the effective configuration the run was planned with, redacted, `sha256` over its canonical JSON; technical/12 § Effective configuration), context pack (list of KB docs with reason and tokens), session id, status, exit reason, usage (input/output/cache write/cache read, per model), cost (actual or estimated + flag), turns, timings, transcript ref | The audit unit (BD-003). |
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
   │           ├─► paused(budget|manual|taken_over) ─► active | ready_for_merge | merged
   │           └─► needs_human ─► active | cancelled
   └─► cancelled
```
Guards: WIP limits on `queued → active`; iteration limits on any `returned`; budget on every `active` entry; readiness/autonomy policies on approvals.

*Which* limit a `returned` spends is decided by the transition and not only by the stage it leaves (WP-26). `ready_for_merge` has two outgoing returns — a human's comment, which is BD-008's `human_rounds`, and the default branch moving, which re-enters the rebase gate — and attributing the second to the first escalated a task with *"human_rounds iteration limit of 3 reached: main moved to …"* after three merges to `main` under a waiting merge request. The edges that need their own loop are enumerated in `RETURN_LOOPS_BY_EDGE` (`packages/domain/src/pipeline/interpreter.ts`); everything else is attributed by the stage, and an edge in neither table cannot return at all.

> **`paused → ready_for_merge` and `paused → merged` were added at WP-73** (PROGRESS backlog 244,
> Q104). `ready_for_merge` has always had an edge **into** `paused` — the header's **Pause**, and
> product/04:84's `@agentic hold` is the same act — and nothing led back, so a task paused while it
> waited for a merge could only be cancelled. *A task paused while waiting for a merge resumes
> waiting for it* — **if its branch head is still the one the gates judged; since WP-79 a moved or
> unreadable head re-enters `ci_gate` instead** (the paragraph below): the resume leads back into
> `ready_for_merge` or the gate, and either entry emits `task.resumed` like every other way out of
> a pause, so an ending deferred to the resume (the dependency policy's `block`) is performed. **A merge made on the provider ends the pause** (Q104, answer (a)): a
> human merging is BD-007's decision, made in the one place the platform cannot refuse it, so
> `mr.merged` for a task paused **at `ready_for_merge`** records `task.resumed` and the merge and
> the retrospective runs as for any merge. A task paused at any **other** stage whose merge
> request is merged is escalated to `needs_human` with a brief rather than dropped, and so, since
> WP-73b (PROGRESS backlog 264), is a task still `active`, `returned`, `waiting_answers` or
> `waiting_approval` — a merge before Ready is not the decision Ready waits for; a task already in
> `needs_human` stays there with a log line naming the merge. **Both edges
> exist only for a task paused _at_ `ready_for_merge`** (WP-73 review round 1): the table cannot say
> "from this stage", so the Task aggregate refuses them from a pause anywhere else, and a
> **hand-back cannot reach them** — handed back from a pause at `ci_gate` to `ready_for_merge` or
> `merged_gate` is refused (it would skip CI and rebase, or record a merge that never happened),
> and the hand-back command refuses `merged_gate` from a pause at Ready too, because only the
> provider's `mr.merged` may say a merge happened. `paused →
> returned` is still not an edge: `return-to-stage` from a pause is the same question for every
> paused stage, and nobody has asked for it.
>
> **A human's way into Ready is judged by the head, not by the edge** (WP-79, PROGRESS backlog
> 267). A take-over at Ready is a pause at Ready, so a human who takes over, pushes, and hands back
> to `ready_for_merge` — or simply resumes — used to put commits at Ready that neither `ci_gate` nor
> `rebase_gate` had read; and a hand-back into `ready_for_merge` from an `active` task (`active →
> ready_for_merge` is an edge) skipped both gates outright; and `retry-stage` at a task paused at
> Ready (and, on a template that ran something at Ready, `retry-run`) entered it the same way
> (WP-79 review round 1). Since WP-79 **no human command moves a task into Ready itself**: every
> command's stage entry is one function (`humanEnter` in `packages/application/src/pipeline/commands.ts`),
> the command-side apply refuses a Ready entry that bypassed it, and a `return-to-stage` or
> `rework` aimed at Ready is refused by this table (`returned → ready_for_merge` and `paused →
> returned` are not edges). The only ways into Ready are then the pipeline's — a passing rebase-gate
> settlement, or a fall-through from an agent or system stage on a template whose gates are
> disabled, which records no head — and the `ready_head_check` duty. **The rebase gate lets a task
> into Ready only for the head CI passed** (WP-79 review round 2, PROGRESS backlog 275): the CI
> gate's settlement records the head it passed (`tasks.ci_head_sha`, technical/03), and a passing
> rebase gate on a template that runs `ci_gate` compares its own head with it — equal, Ready, and
> that head is `ready_head_sha`; different or absent (a push between the two gates, the review
> stages run in between; or a human's hand-back at `code_review` or `rebase_gate` after a push) —
> **re-enter `ci_gate` as a forward move**. It is not a return and spends none of BD-008's failure
> loops, but it is **bounded** by the existing `rebase_rechecks` (default 10), which it shares with
> the default-branch re-check because both are *the branch moved under a gate that had passed*: a
> branch pushed after every CI pass is escalated to `needs_human` when the bound is spent, rather
> than looping CI ↔ rebase. One round re-runs the review stages too (the template's fall-through),
> which is the cost of judging the new commits.
> The task records the head its gates judged on the way into Ready
> (`tasks.ready_head_sha`, technical/03); the command validates the move against the aggregate,
> appends only what it always appended (`task.handed_back` for a hand-back, nothing for a resume
> or a retry), and enqueues the `ready_head_check` duty, which reads the merge request's live head **outside
> every transaction** (WP-15d) and then decides: the recorded head → **re-enter `rebase_gate`**
> (WP-105, PROGRESS backlogs 274 and 337, ruled option (c)), with `task.resumed` when the task was
> paused — one mergeability read, WP-26's conflict warning on the gate's entry, WP-102's
> confirmation in its settlement, and no loop — because the head does not vouch for the target
> branch (a `default_branch.moved` that arrived while the task was paused was dropped: the re-check
> below is taken only for a task whose state is `ready_for_merge`) nor for a plan a returned round
> changed without pushing; on a template that does not run `rebase_gate`, `ready_for_merge`
> directly, with the head recorded again (backlog 338's gap); anything else — a different head, no
> recorded head, or a head the platform could not read (fail closed on a mutation: *unreadable* is
> not *unmoved*) — **re-enters `ci_gate`**, the first enabled of `ci_gate` and `rebase_gate`, from
> which the template's own fall-through runs review and the rebase gate again before Ready. That
> entry is a **forward move and spends no loop**: the interpreter would call it a return, because
> `ci_gate` sits earlier than `ready_for_merge`, but a human's push is not a failure of any loop
> BD-008 bounds, so the duty applies an `enter` decision rather than interpreting a signal, and no
> counter moves. A task whose template enables neither gate enters Ready, because its front door
> judges no head either. The duty re-validates on fire: it acts only while the task is still in the
> state and at the stage the command saw, and drops the wake-up (with a log line) otherwise.
>
> **The CI gate runs BD-024's tamper check, and it is part of the gate's read** (WP-81, PROGRESS
> backlog 95, BD-024 §2) — not a stage of its own and not a reviewer's opinion; the Code review's
> confirmation of a *declared* change is read by the rebase gate's settlement (WP-102, below). When the pipeline
> for the live head is terminal (or the project has no pipeline for it), the gate computes, from
> three inputs: the **changed paths of existing files** in the merge request at that head — every
> file the provider lists as **modified or deleted**, and the **old** name of a rename, through the
> one coalesced diff read WP-59 made (`diff-coalescer.ts`). An **added** file is not flagged
> (BD-024 §2: *"modifications or deletions of existing tests and of CI/lint configuration"*; §3
> requires a bug fix to add a test — the orchestrator's WP-81 ruling), and a missing status reads as
> modified (fail closed). The workspace's path guard holds a write to the same policy since WP-99
> (technical/04's WP-99 amendment; until then it refused a new file too); the project's **effective protected paths**
> (`policies.protected_paths`, tests and CI/lint configuration by default); and the latest
> Implementation Plan's declared **`protected_path_changes`**, of which a path is excused only when
> the Code review also **confirmed** it (`ReviewVerdict.protected_path_changes_confirmed`). The
> remainder — changed ∩ protected, minus declared-and-confirmed — decides it:
>
> - **non-empty** → the gate **fails** and the task **returns to the Developer**, the return reason
>   naming the paths and whether each was undeclared or declared but not confirmed. It spends the
>   **`ci_fix`** loop (the stage's own, `RETURN_LOOPS.ci_gate`) exactly as a red pipeline does, and it
>   is a failing CI settlement: `tasks.ci_head_sha` is written `null`. The gate's row is closed
>   `returned` with the outcome word **`protected_paths_changed`**, which is the Checks panel's
>   *tamper check* item;
> - **empty** → the tamper check passes and the pipeline's own verdict decides the gate, and the
>   row is closed with the outcome word **`protected_paths_clean`** — on a pass and on a red
>   pipeline's return alike (WP-105, PROGRESS backlog 280). Until WP-105 such a row was closed
>   `pass` or `returned`, the words a CI settlement before WP-81 — which made no check — wrote too,
>   so the Checks panel reads those two as *not recorded* rather than *clean*; a red pipeline whose
>   check found only declared, unjudged paths closes its return `protected_paths_awaiting_review`.
>   The delivery statistics count a return by `state = 'returned'`, not by this word;
> - **a declared path the Code review has not judged yet** — the shipped templates run `ci_gate`
>   *before* `code_review`, so on the first pass no Review Verdict of the current change exists — is
>   excused **provisionally**: the gate passes with the outcome word
>   **`protected_paths_awaiting_review`**, records its head as `tasks.ci_head_sha` like any pass,
>   and records the excused paths (redacted) as **`tasks.ci_excused_paths`** (migration 0065; every
>   other CI settlement writes it empty). "Judged" is ordinal: the latest Review Verdict is newer
>   than the latest Implementation Notes (the Developer's report after its push). **The check's
>   second half lives in the rebase gate's settlement** (WP-102, Q109 answered (b)): a passing
>   rebase gate whose head agrees with `ci_head_sha` (`rebaseAgainstCi`, WP-79) compares the
>   recorded paths with the latest Review Verdict **in its own transaction, with no provider call**
>   — a path is confirmed when the latest plan still declares it and a review of the change
>   confirmed it. **Confirmed** → the task enters Ready and the rebase gate's row is closed
>   **`protected_paths_confirmed`**; **not confirmed** → the task **returns to implementation** with
>   the tamper reason, spending **`ci_fix`** — the return `ci_gate` would have made (its `fail_to`
>   and loop, through the interpreter), from the rebase gate, whose row is closed `returned` with
>   **`protected_paths_changed`**. A head that moved after the CI read still re-enters `ci_gate`
>   through WP-79's path, unchanged, and that settlement rewrites both columns. Until WP-102 the
>   provisional pass recorded no `ci_head_sha`, so the rebase settlement re-entered `ci_gate` and the
>   template's fall-through ran `code_review` and `business_review` a second time (measured on the
>   fake-Claude e2e: two runs of each; one since). **Residual:** a pipeline that disables
>   `rebase_gate` falls through `business_review` into Ready and nothing compares the recorded
>   paths — latent (nothing on this build disables it: the per-stage `enabled` is read by nothing), older than
>   WP-102, stated rather than closed (PROGRESS backlog 338);
> - **cannot be decided** — the provider lists **no** changed file (a merge request's diff is
>   computed asynchronously, so `[]` is *not yet*, never *nothing*), or lists as many files as the
>   read's bound so the rest are unseen — is never read as *no tamper* (fail closed on a mutation):
>   an empty list keeps the gate `pending` until `MAX_GATE_CHECKS` and then escalates `undecided`;
>   a list at the bound escalates `unsupported` at once.
>
> **What a failed CI gate hands back** (BD-024 §5, Q55's remaining half): the failing job's names
> **and** the first failing job's log, read through `getJobLog`, redacted by the git binding's
> redactor (TD-012's two steps plus every minted-credential shape, WP-80) **before** it is cut, and
> bounded to its head and its tail. It is part of the return reason, which reaches the next
> Implementation run inside the `return_feedback` data block (technical/04); a cut the gate applied
> is announced as `truncated="true"` in that block's marker — carried by
> `task_stages.return_reason_original_chars` (technical/03) — and never as a line in the body. A log
> the platform could not read is stated as unreadable in the reason, never replaced by an empty
> excerpt.
>
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
`open → answered | expired → (escalated)`; one reminder before the deadline (BD-006; amended at WP-84 — the offsets are not configurable, below); `expired` after 1 working day by default (Q8).

> **As built at WP-56.** `deadline_at` is written in the transaction that stores the question, from `pipeline.limits.question_timeout` on the organisation's working calendar (`APP_WORKING_DAYS`/`APP_WORKING_HOURS`/`APP_HOLIDAYS` in `TZ`); the timer is one `deadline.sweep` job armed after commit by the `pipeline.deadlines` handler — the catalogue's *timer (15)* below — on `task.question.asked`, and it re-validates on fire.

> **As built at WP-84 (PROGRESS backlog 165) — BD-006's *"with a reminder before escalation"*.** A reminder is **one more `deadline.sweep` kind** (`question_reminder`), armed by the same *timer (15)* handler beside the expiry, due **halfway through the working time between `asked_at` and `deadline_at`** on the same calendar (`reminderTimeOf`), so a project that lengthens its `question_timeout` moves its reminder with it. **One** reminder per question; *configurable offsets* are not built, and nothing reads a setting for them. On fire the job re-validates (an answered or expired question, a finished task, or a reminder already sent do nothing), enqueues a `notify` duty of class **`reminder`** — posted as text naming the task page, never with buttons — and then counts it through `QuestionRepository.recordReminder`, a narrow `reminders_sent + 1` guarded by `status = 'open'`; the enqueue comes before the count so a crash between them repeats the reminder's enqueue rather than losing it, and the notification's unique key (a cause id derived from the question) keeps that to one row and one post. Since WP-84's review round 1 a `question` row and a question's `reminder` row carry `notifications.question_id`, and the notify duty posts nothing for a question answered or expired since — on a retry and on the recovery pass's re-post alike — and since review round 2 the digest applies the same check to what it carries, and such a row is closed `delivered_as = 'withheld'` (technical/03) rather than left undelivered. `reminders_sent` counts reminders **raised**: a project with no chat binding is told nothing, as for every notification. A reminder timer whose arming was lost **is recovered since WP-108** (PROGRESS backlog 291): the fourth row of `recovery/deadline.ts`'s table finds an open question or pending approval with `reminders_sent = 0` whose reminder instant (`reminderTimeOf`, the live timer's) passed more than the pass's grace ago and whose deadline has **not** passed, and reminds it once through the timer's own path. The same row reminds a row the backfill gave its first deadline — counted from the backfill, so its reminder instant is usually already past and it is reminded on the next pass — and a row open since before WP-84. A row past its deadline is not reminded; it is the expiry's.

### Approval
`pending → approved | rejected | expired`.

> **As built at WP-56 (BD-006's Q95 amendment).** A plan or budget approval expires on the question's calendar and limit — same key, same default, no dial cell — through the same `deadline.sweep` timer armed on `task.approval.requested`; `expired` is recorded as `task.approval.decided` with `decision: 'expired'`, and the saga escalates the task to `needs_human`. A taken-over task (product/19 §19) rides the same timer: 5 working days after `task.taken_over` with no hand-back, resume, stage entry, completion or cancellation since, the task escalates.

> **As built at WP-84 (PROGRESS backlog 165, Q95).** An approval gets the question's reminder: an `approval_reminder` kind on the same queue, halfway through the working time between `requested_at` and `deadline_at`, counted in `approvals.reminders_sent` (migration 0059) through `ApprovalRepository.recordReminder`, guarded by `status = 'pending'`. The reminder is text naming the task page; its row names the approval (`notifications.approval_id`, what a retry or a re-post re-checks — WP-84 review round 1) but carries no `message_ref`, so the settled-approval edit, which reads only rows with one, never mistakes it for the message whose buttons it removes. Like the question's, it appends no event and is not on `ApprovalRecord`.

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

> **`run.created` (added at WP-02).** The catalogue originally started the Run's history at `run.started`, leaving the `created→starting` transition silent and the run's existence unreplayable — which contradicts this document's own rule that every state change is recorded as an immutable domain event. Question `expired→escalated` and question reminders remain deliberately event-free: the former is recorded by `task.escalated`, the latter changes no aggregate state worth replaying. **Since WP-84 reminders are built, for questions and approvals both, and stay event-free**: the counter is on the row (`reminders_sent`), the timer is a `deadline.sweep` kind, and the notification it causes carries a name-derived cause id rather than an event's.

**The "Core consumers" column is normative, not illustrative** (TD-005's WP-15a amendment). An entry
naming any consumer declares the event **consumed**: a process that sweeps the outbox must register a
handler for it, or it destroys a work item belonging to another process in the deployment. An entry of
**`—` declares the event unconsumed** — nothing is expected to handle it, and a sweeper needs no handler
for it. `packages/application/src/events/consumption.ts` is that column as code, its keys held to
`DOMAIN_EVENT_TYPES` so a new event type cannot be added without answering the question. **It differs
from this column on 17 rows today** (18 before WP-60, which consumed `mr.updated`; 22 before WP-41, which closed `task.review.observed`, `task.lint.posted`,
`task.rebase.checked` and `task.conflict.warned`; 23 before WP-29, which closed `run.steered`; 25 before WP-32,
which closed `budget.threshold.reached` and `budget.exhausted`; 28 before WP-19, which closed
`run.finished`, `run.failed` and `artifact.created`) — the column states the finished product's consumers and the declaration states
this build's, so each divergent entry names the work package that closes it (TD-005's amendment records the
trade). `mr.updated` was the one entry that named a backlog entry instead — its payload carries no author, so no
*activity* consumer can read it — until WP-60 consumed it for the one thing it does carry, the head sha.

> **The Slack consumer at priority 210 exists, since WP-32.** The six task rows below that name it —
> `task.created`, `task.stage.returned`, `task.question.asked`, `task.escalated`, `task.cancelled`
> and `task.completed` — and the two budget rows are served by one handler, `notify.chat`
> (`packages/application/src/notify/handlers.ts`), which **decides** and enqueues; the
> `pipeline.outbound` duty makes the call, because a provider call inside a handler's transaction
> holds a pooled connection and the dispatch slot for the length of an HTTP round trip (WP-15d).
> One consumer this column names is still absent and is named here rather than left to be
> inferred: the whole **UI band** at 220 (WP-20's realtime projection). The **buttons** on
> `task.approval.requested` were the second until WP-43, which opened the Socket Mode connection the
> inbound half needed: the same `notify.chat` handler now serves that type too (class `approval`),
> posting Approve / Request changes when the binding can receive a click and text naming the task
> page when it cannot, and a click is decided by the Approval aggregate rather than appended. An **organisation**-scoped budget cannot be notified at all — a chat binding
> belongs to a project and that payload carries no `project_id` — which `decideNotification` says at
> the line.

> **The human-time projector at priority 230 exists, since WP-29** (`human-time/projector.ts`,
> product/19 §16). It is a **second** consumer of four types this column already marks consumed —
> `mr.review.comment`, `mr.merged`, `task.question.answered` and `task.approval.decided` — plus
> `run.steered`, which had none, and whose row below now names it — and, since WP-60, `mr.approved`,
> whose only consumer it is.
>
> **One of the three review anchors has no event in this catalogue, and that is the projector's
> stated residual.** product/19 §16 starts the review window at *"the first human MR activity
> (comment, approval, review start)"*. Until WP-60 there was **no `mr.approved`** type either, so a
> reviewer who approved a merge request without writing a comment contributed **zero minutes**;
> since WP-60 the approval is an event (PROGRESS backlog 90) and the projector folds it like a
> comment. There is still **no review-requested type**, and a *withdrawn* approval is not read.
> Under-counting is the honest direction: the alternative is to guess minutes for an event the
> platform never saw. `mr.updated` is **not** read by the projector, and deliberately — it carries no
> author at all, so it could attribute a minute to nobody, and it fires for the platform's own
> pushes; its consumer since WP-60 is the pipeline, for the head sha (row below).

| Event | Producer | Payload (key fields) | Core consumers (priority) |
|---|---|---|---|
| `ticket.matched` | task-management adapter | ticket ref, rule, priority, type, epic, links | Intake (10) |
| `ticket.created` | task-management adapter | ticket ref, issue type | Ticket readiness linter (10, WP-25), bug trace (120, WP-61 — the job decides whether the type is a bug) |
| `ticket.updated` | task-management adapter (WP-60; emitted **beside** `ticket.matched`/`ticket.status.changed`, never instead) | ticket ref, the provider's `updated_at`, the changed field names (bounded, `truncated`), actor | Snapshot freshness (10, `pipeline.ticket.signal` — Q61 (b)); bug re-trace (120, `pipeline.bug.retrace`, WP-90 — a ticket whose defect trace is not `linked` is traced again, PROGRESS backlog 192); re-lint on edit is **not** built (it waits on a measurement of update frequency); product/18:60's *"edited within 48 h"* is a statistics read over this event (WP-61, `lintEdits`), not a consumer |
| `ticket.comment.added` | adapter | ticket, comment id, author identity, text | Question answering (20), Feedback intake (30) |
| `ticket.status.changed` | adapter | ticket, from, to, actor | Task sync (20) |
| `task.created` | Intake | task, template, mode, estimate | Workpad (110), Slack notify (210), UI (220) |
| `task.queued` / `task.dequeued` | Scheduler | task, reason (wip) | UI |
| `task.stage.entered` | Pipeline | task, stage, attempt | Stage executor (10), status mapping (110), workpad (120) |
| `task.stage.completed` | Stage executor | task, stage, artifact ids, verdict | Pipeline transition (10), custom stages (300+) |
| `task.stage.returned` | Pipeline | task, from, to, reason, feedback ref, iteration | Stage executor (10), workpad (120), Slack (210) |
| `task.question.asked` | Stage executor | question | Ticket comment (110), Slack (210), UI inbox (220), timer (15 — the expiry and, since WP-84, the reminder) |
| `task.question.answered` | Question | question, answer, author, channel | Pipeline resume (10), other channels update (110) |
| `task.question.expired` | Timer | question | Escalation (10) |
| `task.approval.requested` / `.decided` | Pipeline / Approval (`.decided` with `expired` from the timer, WP-56) | approval | Slack buttons (210), pipeline (10), timer (15, `.requested` — WP-56; the reminder too since WP-84); `.decided` also edits the posted message to remove its buttons (210, `approval_settled` duty — WP-65) |
| `task.escalated` | Pipeline | task, reason, blocker brief | Ticket (110), Slack (210) |
| `task.paused` / `task.resumed` | Budget/Human | task, reason | UI, workpad; `.resumed` also performs a deferred dependency-gate ending (120, WP-67) — and a lost wake-up of that handler is recovered by the `deferred_dependency` row of the recovery pass (WP-84, backlog 240), keyed on the newest `task.resumed` |
| `task.taken_over` / `task.handed_back` | Human | task, branch, session, stage; `task.taken_over` also the interrupted run (nullable — none was live; absent on an event before WP-73) | Workspace export (10), ticket (110), timer (15, `.taken_over` — WP-56) |
| `task.cancelled` / `task.completed` | Pipeline | task, outcome, totals | Ticket transition (110), Slack (210), stats (230) |
| `task.review.observed` | Review-only (WP-24) | task, mr, head sha reviewed and now, threads posted/resolved/accepted/dismissed/unresolved | stats (230) |
| `task.lint.posted` | Ticket readiness linter (WP-25) | task, ticket, score, missing elements, questions posted, the ticket's `updated_at` | stats (230) |
| `task.rebase.checked` | Rebase gate (WP-26) | task, mr, conflicts, attempt, outcome (`clean`/`resolved`/`conflicted`/`exhausted`) | stats (230) |
| `task.conflict.warned` | Rebase gate (WP-26); since WP-59 appended on **both** tasks' streams when the gate finds an overlap (PROGRESS backlog 65) | task, mr, the other task and its ticket key, overlapping paths, how many, whether the comparison was cut | stats (230) |
| `task.mr.measured` | Merge measure duty (WP-61), on the **project** stream, after a merge request the platform made merged | task, mr, the provider's diff stats from `getMergeRequestDiffStats` — `null` when it answered none, never zeros, and never the merge event's own field (GitLab sends `null` there) | — (read at request time by the statistics query, first measurement per cause `mr.merged`, so a redelivered job counts once). Since WP-90 a lost project-stream sequence race is retried in the duty with the provider's answer held, never a second read (PROGRESS backlog 193) |
| `ticket.bug.traced` | Bug trace duty (WP-61), on the **project** stream, for a ticket whose issue type the project routes to the `bug` template — and since WP-90 again on a `ticket.updated` for a ticket whose trace is `no_link`/`unreadable` (PROGRESS backlog 192) | ticket, the `ticket.created` instant, outcome (`linked`/`no_link`/`unreadable`), how the merge request was found (`ticket_link` only — never a title scan, never adjacency), the merge request and the platform task owning it | Bug re-trace (120 on `ticket.updated`, reads it through `PipelineStore.bugTraces`); read at request time by the statistics query's defect escape — the ticket's latest trace, `linked` final — which joins it to the deliveries (Q87) |
| `run.created` | Runner | run, task, stage, role, mode, attempt, run key | UI (220) |
| `run.started` | Runner | run, model, effort, prompt version, context pack | UI (220) |
| `run.finished` / `run.failed` | Runner | run, status, usage, cost, exit reason — `cost` is **`null` when nothing measured the run**: a stop (a human's, a stall, the wall clock) whose interrupted turn sent no `result` inside the interrupt grace, and a crash with no `result`, is **unmeasured, not zero**, and a `run.failed` then carries no usage either. Nullish on both events since WP-119 (PROGRESS backlog 334), so a `run.finished` appended before it, whose `cost` is always an object, replays unchanged; the ledger writes no row for a `null` | Cost ledger (10), stage executor (20), UI |
| `run.steered` | Human | run, message, author | Runner (10), human time (230, WP-29) |
| `artifact.created` | Stage executor | artifact | Workpad (120), UI |
| `workspace.provisioned` / `.destroyed` / `.exported` | Workspace manager | workspace | UI |
| `mr.opened` / `mr.updated` / `mr.merged` / `mr.closed` | git adapter | mr ref, actor, draft, head sha, diff stats | Pipeline (10; on `updated`, since WP-60, the recorded head follows a push the platform did not make, **forward only** by the provider's `updated_at`, which `mr.updated` alone carries — PROGRESS backlog 182; what bounds the ordering residual is that the CI gate does not read the recorded head at all but asks the provider for the live one, on its poll and in `ci_settle`), review-only (10 on `opened`, 120 on `merged`/`closed`, WP-24), merge measure (120 on `merged`, WP-61), resolve on merge (120 on `merged`, a bug task only, WP-111 — enqueues the `resolve_on_merge` duty, which resolves the ticket's linked Sentry issues on a binding that sets `resolve_on_merge`), review-thread refresh (120 on `updated` carrying `blocking_threads_resolved`, WP-90 — GitLab's `changes.blocking_discussions_resolved`, sent only by a project that requires resolved threads; a count-only re-read, never the return decision, PROGRESS backlog 210), stats (230) |
| `mr.approved` | git adapter (WP-60; GitLab's `approval` action only) | mr ref, approver identity, the provider's instant (`null` before GitLab 18.10) | Human time (230, the review window's *"approval"* anchor — PROGRESS backlog 90) |
| `mr.review.comment` | git adapter | mr, thread id, author identity, text, resolved | Batching/debounce (10), feedback intake (30), review-thread refresh (120 on `resolved: true`, WP-90 — the count only), human time (230, WP-29) |
| `ci.pipeline.finished` | git adapter | mr, head sha, status, failed jobs, log refs, coverage | CI gate (10 decides, and since WP-60 review round 2 the `ci_settle` duty settles **only** a pipeline that ran on the merge request's live head, read from the provider outside the transaction), flaky detector (15) |
| `default_branch.moved` | git adapter | project, new head | Rebase gate (10), KB index (40) |
| `budget.threshold.reached` / `budget.exhausted` / `budget.reset` | Budget projection | scope, window, pct | Scheduler (10), Slack (210, WP-32 — `reset` excepted: a window rolling over is not news; an **organisation** window, which has no project, goes to the organisation's own chat account's channel since WP-65 — the flagged one, `notifications.organisation_default`, when there are several, and inside the organisation's quiet hours a threshold waits for the organisation's digest while an exhaustion does not, since WP-93) |
| `feedback.received` | Feedback | feedback | Feedback intake agent (30) |
| `knowledge.proposal.created` / `.applied` / `.rejected` | Librarian / Human | proposal | Index rebuild (40), UI |
| `knowledge.index.rebuilt` | Indexer | project, commit | — |
| `readiness.evaluated` | Discovery (the `onboarding.discovery` recorder) / the post-merge re-check (WP-64) — one per recorded `readiness_evaluations` row, in that row's transaction, since WP-73 (PROGRESS backlog 228; `source` is `discovery`, `rediscovery` — a maintainer's re-evaluate, WP-94 — or `recheck`) | project, level, criteria, source | Policy suggestions (20), UI — **neither built**, so it is declared `unconsumed` |
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
- **MaintenanceScheduler**: creates chore tasks on schedule within budget. **Built at WP-36** as a daily cron (`maintenance.schedule`, `exclusive`) rather than as an event-driven saga — there is no event to react to — walking the projects and creating one ordinary `chore` task per due chore type per period (`packages/application/src/maintenance/scheduler.ts`). **Since WP-94 (Q100 per its recommendation) the dial's level binds it:** a project whose autonomy level in force is Observe gets no chore (a named `info` line; the maintenance card says *paused at Observe*; **since WP-113, Q111 (c)**, one digest line on the pass the pause begins and one on the pass it ends — the pass compares its blocker with the one it recorded last, `projects.maintenance_last_blocker`, and says nothing on the days between), and at the other three positions a chore still carries no frozen dial. Three of product/18:31's five chore types are **refused by name** on this build (`flaky`, `docs`, `lint`) and the reason per type is `MAINTENANCE_CHORES` in the domain ring; the *"within budget"* half is `features.maintenance.budget_usd`, enforced at every chore run's admission by the stage executor against `cost_entries` **and against the chore runs the ledger has not recorded yet**, in the mechanism WP-34 built for shadow mode (the ledger writes from a handler that commits after the run's own transaction, so a cap read from its rows alone admits one run per dispatcher lag — measured, and stated at `packages/application/src/cost/pending.ts`).

## Invariants (enforced in domain)

- A task has at most one active run at a time.
- Iteration counters never exceed their limits without an `task.escalated` event.
- No run starts when any applicable budget is exhausted; running runs are never killed by org/project budgets (BD-010).
- Shadow tasks never produce `integration.action.performed` for mutating actions — **with one declared exception since WP-76** (Q98 (a), TD-028 decision 7 as superseded): a `read`-scoped git credential mint, which a shadow run needs to fetch a private repository, and a git credential revoke of any scope (revoking only removes access). The carve-out is declared on the request, carries no idempotency key, and is checked in every mode: declared on any other action, or on a mint of any other scope, it is refused.
- Only events from verified identities can trigger `question.answered`, `approval.decided`, `task.stage.returned` by human, `feedback.received` (BD-022).
- Artifacts are versioned; a stage re-run creates a new version, never overwrites.
