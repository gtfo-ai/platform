/**
 * Which catalogue events this build consumes — and the gate that stops a partial consumer sweeping
 * the outbox (TD-005's WP-15a amendment, technical/02 § "Event catalogue").
 *
 * ## The defect this closes, because the shape is not obvious
 *
 * `EventBus.dispatch` treats "no handler matched this type" as a **completed** dispatch: it calls
 * `dispatchQueue.complete(position)`, which deletes the row, and writes the `$dispatch` marker that
 * makes a later re-dispatch a deliberate no-op. That is the right behaviour at the dispatch site and
 * the amendment keeps it — leaving the event queued would make `hasEarlierPending` block every later
 * event of the same stream, so one never-handled type would permanently halt each aggregate that
 * emits it.
 *
 * What is wrong is a process **sweeping with a partial handler set**. `event_dispatch` holds one row
 * per event for the whole deployment, so completing a dispatch discharges *every* handler in it, and
 * only `ROLE=all|worker` sweep while other roles take their work through pg-boss. An empty
 * `handlersFor(type)` is therefore a statement about **this process**, never about the event: a
 * sweeper holding nine of ten handlers destroys the tenth's work item exactly as an empty one does.
 * Round 2 answered that per-type question with a whole-registry predicate (`registry.size === 0`),
 * which is standing rule 56 — ask what the false branch actually enumerates.
 *
 * So the arbiter is here, at **composition**: {@link sweepReadiness} refuses to let a process sweep
 * unless it can handle everything this build says is consumed, and it names what is missing.
 *
 * ## Why the values are what they are, and where they disagree with technical/02
 *
 * technical/02's "Core consumers" column is the normative source and the amendment makes it so, with
 * `—` meaning *declared unconsumed*. Read literally, that column marks **49 of 50** types consumed,
 * because it describes the consumers the finished product has — Slack notifications, the UI band, the
 * cost ledger, the audit projection. Measured, a composed `apps/server` registers handlers for
 * **38** of them, the count of `handled` rows below. That figure is deliberately not broken down
 * per work package any more: it was, and it went stale four work packages later while reading as a
 * measurement (standing rule 86). `consumption.test.ts` is the census — it composes the same
 * handlers `apps/server/src/pipeline.ts` does and asserts this table equals what they register, in
 * **both** directions — so the number is produced rather than quoted. A table transcribed from
 * technical/02's column would stop the outbox worker in every build that exists today, including
 * the one whose e2e walks a ticket to `task.completed`.
 *
 * The table below is therefore **what this build consumes**, and every `unconsumed` entry names an
 * address: the work package that will flip it, or — when nothing will, because the *event* cannot
 * answer the question — the backlog entry that says so. `mr.updated` is the second kind.
 *
 * The properties the amendment is protecting are unchanged: a sweeper
 * must be complete for everything declared consumed, removing a handler fails a named test, and a new
 * event type cannot be added without answering the question (the keys are held to
 * `DOMAIN_EVENT_TYPES`). What it does not do is pretend the product's future consumers exist.
 *
 * **`run.finished` / `run.failed` were the entry to look at first, and WP-19 closed them.** From
 * WP-15a until that work package they were declared `unconsumed` while technical/02 gave them a cost
 * ledger at priority 10, so every `run.finished` the sweep completed was a cost entry nobody would
 * ever write. The ledger now registers for both (`cost/ledger.ts`) and `artifact.created` joins them
 * for the task estimate. The events swept in between are recovered by `events/replay.ts`, which reads
 * a range of the append-only log into a newly registered handler — the backfill the backlog required
 * before this table could be flipped.
 */
import type { DomainEventType } from '@platform/contracts';
import type { HandlerRegistry } from './handler.js';

/**
 * `handled` — something in this build registers a handler, and a sweeper must have it.
 * `unconsumed` — nothing does, deliberately; a sweeper needs no handler for it.
 */
export type EventConsumption = 'handled' | 'unconsumed';

/**
 * The catalogue as code. Keys are held to `DOMAIN_EVENT_TYPES` by `consumption.test.ts`, so adding
 * an event type without deciding this is a build failure rather than a silent `undefined`.
 *
 * Each `unconsumed` entry carries the work package that will flip it, because "nothing handles this"
 * and "nothing handles this *yet*" need different answers when someone reads the row (rule 18's
 * shape: the absent case must not be the quiet one).
 */
export const EVENT_CONSUMPTION: Readonly<Record<DomainEventType, EventConsumption>> = {
  /**
   * ── The pipeline (WP-15), registered by `createPipelineRuntime` ──────────────
   *
   * **A `handled` entry is not a count.** Six of the types below gained a *second* consumer at
   * WP-32 — the notification band at TD-005 priority 210 (`notify/handlers.ts`): `task.created`,
   * `task.stage.returned`, `task.question.asked`, `task.escalated`, `task.completed` and
   * `task.cancelled`, which is exactly technical/02's Slack column. Four more gained one at WP-29 —
   * the human-time projector at priority 230 (`human-time/projector.ts`): `mr.review.comment`,
   * `mr.merged`, `task.question.answered` and `task.approval.decided`. The table answers "must a
   * sweeper be able to handle this type", so a second handler does not move an entry; the two
   * budget entries below **did** move, and so did `run.steered`, because they had none.
   *
   * **A fifth gained one at WP-41** — the statistics projector at priority 240
   * (`stats/projector.ts`), which reads `mr.merged` for the instant a delivery happened. Its own
   * four types are at the bottom of this table and they *did* move, because they had no consumer
   * at all.
   */
  'ticket.matched': 'handled',
  'task.created': 'handled',
  'task.queued': 'handled',
  'task.dequeued': 'unconsumed', // WP-15's scheduler emits it; nothing listens. WP-20 shipped without a projection of it; the statistics screen's queue-wait metric names it absent for that reason.
  'task.stage.entered': 'handled',
  'task.stage.completed': 'handled',
  'task.stage.returned': 'handled',
  'task.question.asked': 'handled',
  'task.question.answered': 'handled',
  'task.question.expired': 'handled',
  'task.approval.requested': 'handled',
  'task.approval.decided': 'handled',
  'task.escalated': 'handled',
  'task.paused': 'handled',
  'task.resumed': 'handled',
  'task.completed': 'handled',
  'task.cancelled': 'handled',
  'ci.pipeline.finished': 'handled',
  'default_branch.moved': 'handled',
  'mr.merged': 'handled',
  'mr.closed': 'handled',
  'mr.review.comment': 'handled',

  // ── Review-only mode (WP-24), registered by `reviewOnlyHandlers` ─────────────
  /**
   * A human merge request opens, and the platform decides whether the project asked for a review.
   *
   * This line used to read `'unconsumed', // The pipeline learns its MR from ImplementationNotes
   * (WP-15); stats is WP-41.` Both halves are still true of the *pipeline's own* merge requests —
   * `pipeline.review.only` skips any merge request a task already owns — and neither is a reason
   * for the event to have no consumer any more (standing rule 83).
   */
  'mr.opened': 'handled',

  // ── Take-over and hand-back (WP-27), read by the workpad and the status mapping ──
  /**
   * A human is holding this task, or has given it back.
   *
   * Consumed by the two **integrations**-band handlers rather than by the saga: neither event needs
   * the pipeline to decide anything (the commands that emit them have already moved the task), and
   * what they change is what a person reading the ticket sees — the workpad gains the branch and
   * the resume command, and the board moves with the task's state. `run.steered` is **handled since
   * WP-29** and used to be named here as the exception: the steer's effect is on the session, and
   * its *minutes* are the human-time projector's (standing rule 83 — the sentence nearest the
   * change is the one nobody re-reads).
   */
  'task.taken_over': 'handled',
  'task.handed_back': 'handled',

  // ── The ticket readiness linter (WP-25), registered by `ticketLintHandlers` ──
  /**
   * A ticket was created in a project the binding reads — the linter's door (product/18).
   *
   * `handled` from the day the event exists: it is added by the work package that consumes it, so
   * there is no window in which a sweeper completes a dispatch for a handler somebody is about to
   * write. The handler decides in two indexed reads and enqueues; a project without the feature
   * costs one `pipeline.outbound` job that settles with a reason.
   */
  'ticket.created': 'handled',

  // ── The cost ledger (WP-19), registered by `costHandlers` ────────────────────
  'run.finished': 'handled',
  'run.failed': 'handled',
  /** The estimate at refinement reads the `RefinedSpec`'s size (product/09). */
  'artifact.created': 'handled',

  // ── Human time accounting (WP-29), registered by `humanTimeHandlers` at priority 230 ──
  /**
   * A human steered a run — product/19 §16's *"steer = 5 min flat per steer"*.
   *
   * The **only** type this work package moved. Its four siblings — `mr.review.comment`,
   * `mr.merged`, `task.question.answered` and `task.approval.decided` — were already `handled` by
   * the pipeline, and a second consumer does not move an entry that answers *"must a sweeper be
   * able to handle this type"*. This one had no consumer at all: WP-27 gave it a producer
   * (`steerRunCommand`) and technical/02:163 names only the runner, which reads a steer
   * **in-process** through `LiveRuns` rather than off the bus.
   */
  'run.steered': 'handled',

  // ── Ask-the-task (WP-31), registered by `askHandlers` in the core band at 60 ──
  /**
   * A human wrote in the ticket thread — the door every ticket-side conversation arrives through.
   *
   * This line read `'unconsumed', // WP-31 ask-the-task; feedback intake has no owner.` from WP-15c
   * until this work package, and **half of it is still true**: `classifyTicketComment` turns a
   * comment carrying `@agentic ask` into exactly one ask and everything else into a named refusal,
   * while *feedback* intake (`@agentic remember:`, product/07:42) still has no owner and is in the
   * ledger's discovered work rather than here (standing rule 83 — the sentence nearest the fix is
   * the one nobody re-reads, so it is corrected rather than deleted).
   *
   * On a build where `user_identities` holds no row, every one of these is refused
   * `unverified_identity` (BD-022, Q10) — which is why WP-31 also gave that table its first writer,
   * `POST /api/org/identities`.
   */
  'ticket.comment.added': 'handled',

  // ── Declared unconsumed in this build, with the work package that changes it ──
  // Review-only mode does **not** read it — it has no ticket at all (WP-24) — so the owner this
  // line used to name was wrong as well as pending. Task sync is technical/02's consumer and no
  // work package owns it; PROGRESS's discovered work says so.
  'ticket.status.changed': 'unconsumed', // Task sync (technical/02); no owner.

  'run.created': 'unconsumed', // UI band, WP-20's realtime projection.
  'run.started': 'unconsumed', // UI band, WP-20.
  'workspace.provisioned': 'unconsumed', // UI band, WP-20.
  'workspace.destroyed': 'unconsumed', // WP-20.
  'workspace.exported': 'unconsumed', // WP-20.
  /**
   * **WP-41 looked too, and left it unconsumed — so this line no longer names a work package that
   * will flip it** (standing rule 83: the sentence nearest the change is the one nobody re-reads).
   *
   * Both of WP-29's reasons are properties of the payload rather than of the work package that
   * meets it. It carries **no author** (`mrPayload` has none), so nothing it records can be
   * attributed to anybody; and it fires for the platform's **own** pushes, so counting it as
   * activity would record the Developer stage pushing a commit as a human touching the merge
   * request. A statistic folded from it would be a number about the platform's own behaviour
   * labelled as a number about people.
   *
   * What would change that is an **author on the payload**, which is a normaliser change with a
   * fixture and a contract-suite case (standing rule 23) and is the same shape PROGRESS backlog
   * **90** prices for `mr.approved`. It is recorded there rather than owned here: an entry naming
   * a work package that is not going to flip it is worse than one naming none (rule 18).
   */
  'mr.updated': 'unconsumed', // No author on the payload; PROGRESS backlog 90's shape.
  // ── The notification band (WP-32), registered by `notifyHandlers` at TD-005 priority 210 ──
  /**
   * A budget window crossed a threshold, or is spent — product/18:33's *"budget 100 %"*.
   *
   * These two lines used to read `'unconsumed', // Slack (210), WP-10` and WP-10 was **DONE**: a
   * finished work package cannot own unbuilt work, and the ledger's entry is the shape that error
   * takes in a table (standing rule 18 — the absent case must not be the quiet one). WP-32 built the
   * band, so they are `handled`, and by the **same** handler as the six task events below it.
   *
   * What stops a new run is still a **read** of `budget_windows` at stage admission
   * (`cost/guard.ts` says why) and not this handler: telling somebody is not the same as stopping
   * something, and a notification that failed must never be what lets a run start.
   *
   * The **organisation**-scoped budget is the one case this cannot notify: a chat binding belongs
   * to a project and an org budget's payload carries no `project_id`, so `decideNotification`
   * returns `null` for it with the reason written at the line. Filed as discovered work.
   */
  'budget.threshold.reached': 'handled',
  'budget.exhausted': 'handled',
  // Still unconsumed, and deliberately outside the notify band: a window rolling over is not news
  // (product/18:33's classes are the ones a human acts on), and nothing emits it in this build
  // either (`cost/window.ts`). The UI band is WP-20's.
  'budget.reset': 'unconsumed',
  'feedback.received': 'unconsumed', // Feedback intake agent; no work package owns it (WP-24 is review-only mode).
  // Emitted since WP-18b, and unconsumed **by decision** rather than by omission. technical/02's
  // column names "Index rebuild (40), UI" for all three; the index rebuild is the one that has to be
  // argued. It does not belong on `applied`: the platform commits a knowledge page to an
  // `agentic/knowledge/*` branch with a merge request and never to the default branch (Q66), and the
  // indexer reads the **default branch** (BD-025) — so rebuilding on `applied` would re-read a tree
  // that has not changed. The rebuild happens when a human merges that MR, on `mr.merged`, which is
  // consumed. The UI half is a read model nothing builds yet.
  'knowledge.proposal.created': 'unconsumed', // Librarian, WP-18b.
  'knowledge.proposal.applied': 'unconsumed', // WP-18b; see above — `mr.merged` triggers the index.
  'knowledge.proposal.rejected': 'unconsumed', // WP-18b.
  'knowledge.index.rebuilt': 'unconsumed', // `—` in technical/02: unconsumed by design, not by omission.
  'readiness.evaluated': 'unconsumed', // Policy suggestions, WP-21.
  'config.changed': 'unconsumed', // Audit projection and effective-config rebuild, WP-21.
  // technical/03 attributes an audit and a health projection to "WP-19", and WP-19's plan row does
  // not carry them: it is the cost ledger, the rollups, the budgets, the price job, the estimates
  // and the backfill. They have no work package, which is why no number is named here.
  'integration.action.performed': 'unconsumed', // Audit and health projections; unowned.
  'integration.action.failed': 'unconsumed', // As above.
  // ── The statistics projection (WP-41), registered by `statsHandlers` at TD-005 priority 240 ──
  /**
   * The four types this work package moved, and the one thing they have in common: **their only
   * record was the event**.
   *
   * `task.review.observed` is product/18:59's *"findings accepted vs dismissed"*, `task.lint.posted`
   * product/18:60's baseline, `task.rebase.checked` product/16's *"conflicts auto-resolved vs
   * escalated"* and `task.conflict.warned` its *"concurrent-task overlaps"*. Each carries the
   * numbers a consumer needs without a second provider read, and each wrote no row anywhere — so
   * until this work package they accrued history whose meaning nobody could re-derive.
   *
   * They are folded into `stats_event_daily` by one projector (`stats/projector.ts`), which also
   * writes the delivery row from `mr.merged`. **A second consumer does not move an entry** —
   * `mr.merged` was already `handled` by the pipeline and stays where it was, and the same is true
   * of the human-time projector's four (see the note at the top of this table).
   *
   * **Half of product/18:60 is still absent and stays that way**: *"tickets improved after lint
   * (edited within 48 h)"* needs a *this ticket changed* signal no normaliser produces (PROGRESS
   * backlog **59**), so the statistics screen names that metric absent with its entry rather than
   * publishing the half it can count as if it were the whole.
   */
  'task.review.observed': 'handled',
  'task.lint.posted': 'handled',
  'task.rebase.checked': 'handled',
  'task.conflict.warned': 'handled',
  // WP-40: the **spike's human stage subscribes to it**. `EPIC_SPLIT_TEMPLATE`'s `human_review`
  // names it in its `on` list, so `pipeline.epic.split.decided` steps the task out of the wait and
  // the interpreter decides where it goes — which is the same shape `default_branch.moved` has for
  // `ready_for_merge`, and the reason this one is `handled` rather than a statistics baseline.
  'task.breakdown.decided': 'handled',
  // WP-34's first consumer: `shadow.batch.completion` (`shadow/report.ts`) marks a batch finished
  // once every task of it has a report. Small on purpose — product/19 §13's aggregate is a
  // projection over the batch's rows, not a number a handler accumulates.
  'shadow.report.created': 'handled',
};

/** Every type this build says something must handle, in this table's declaration order. */
export const HANDLED_EVENT_TYPES: readonly DomainEventType[] = Object.entries(EVENT_CONSUMPTION)
  .filter(([, consumption]) => consumption === 'handled')
  .map(([type]) => type as DomainEventType);

export interface SweepReadiness {
  /** True when this registry can handle everything the build declares consumed. */
  readonly ready: boolean;
  /** The declared-consumed types with no handler registered *for that type*. */
  readonly missing: readonly DomainEventType[];
}

/**
 * May this process sweep the outbox?
 *
 * **One predicate, two gates** (standing rule 41): the composition root uses it to decide whether to
 * start the outbox worker *and* as `/readyz`'s `dispatch` check. Two readings of one condition drift
 * apart, and the pair has to agree or an operator is told a process is ready to do work it has
 * refused to start.
 *
 * **A catch-all handler does not count, and that is round 2's defect one level up.** `handler.ts`
 * blesses `eventTypes: 'all'` for audit and projections, and `handlersFor(type)` merges those into
 * every type's list — so one such handler answered "ready" for all 21 declared types, with no
 * pipeline behind it. WP-19's audit projection is the trigger: it would have turned the gate green
 * the day it registered. A per-type question has to be answered per type (standing rule 56), so a
 * type counts only when something registered **for that type by name**. The cost is stated: a future
 * consumer that genuinely handles a type only through a catch-all has to name it instead, which is
 * the direction that fails loudly rather than quietly.
 */
export const sweepReadiness = (registry: HandlerRegistry): SweepReadiness => {
  const missing = HANDLED_EVENT_TYPES.filter((type) =>
    registry.handlersFor(type).every((handler) => handler.eventTypes === 'all'),
  );
  return { ready: missing.length === 0, missing };
};
