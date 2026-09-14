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
 * cost ledger, the audit projection. Measured, a composed `apps/server` registers handlers for **28**
 * of them — 22 from the pipeline, 3 from the cost ledger (WP-19), the 2 budget events the
 * notification band added (WP-32; its other six types were already handled by the saga) and
 * `ticket.comment.added`, whose first consumer is ask-the-task (WP-31). A table
 * transcribed from the
 * column would therefore stop the outbox
 * worker in every build that exists today, including the one whose e2e walks a ticket to
 * `task.completed` — the acceptance criterion this work package is for.
 *
 * The table below is therefore **what this build consumes**, and every `unconsumed` entry names the
 * work package that flips it. The properties the amendment is protecting are unchanged: a sweeper
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
   * `task.cancelled`, which is exactly technical/02's Slack column. The table answers "must a
   * sweeper be able to handle this type", so a second handler does not move an entry; the two
   * budget entries below **did** move, because they had none.
   */
  'ticket.matched': 'handled',
  'task.created': 'handled',
  'task.queued': 'handled',
  'task.dequeued': 'unconsumed', // WP-15's scheduler emits it; nothing listens. UI band is WP-20's.
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
   * the resume command, and the board moves with the task's state. `run.steered` stays unconsumed
   * below: the steer's effect is on the session, and its *minutes* are WP-29's.
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
  // WP-27 gave it a producer (`steerRunCommand`); the consumer is WP-29's, which turns a steer
  // into product/19 §15's five human minutes. Nothing else reads it.
  'run.steered': 'unconsumed', // WP-29 human time accounting.
  'workspace.provisioned': 'unconsumed', // UI band, WP-20.
  'workspace.destroyed': 'unconsumed', // WP-20.
  'workspace.exported': 'unconsumed', // WP-20.
  'mr.updated': 'unconsumed', // WP-41 statistics.
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
  'task.review.observed': 'unconsumed', // WP-41 statistics: product/18's accepted-vs-dismissed.
  // WP-41 statistics: product/18:60's "tickets improved after lint". The *other* half of that
  // metric — "edited within 48 h" — needs a "this ticket changed" signal no normaliser produces
  // today; `taskLintPostedEvent`'s docblock carries the measurement and the baseline it records.
  'task.lint.posted': 'unconsumed',
  // WP-41 statistics: product/16's "conflicts auto-resolved vs escalated" and "concurrent-task
  // overlaps". Both are appended by WP-26 — `task.rebase.checked` once per settlement of the rebase
  // gate, `task.conflict.warned` once per warned pair — and both carry the numbers a consumer needs
  // without a second provider read, which is why neither has a projection of its own here.
  'task.rebase.checked': 'unconsumed',
  'task.conflict.warned': 'unconsumed',
  'shadow.report.created': 'unconsumed', // WP-34 shadow mode.
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
