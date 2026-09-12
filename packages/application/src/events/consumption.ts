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
 * cost ledger, the audit projection. Measured, a composed `apps/server` registers handlers for **24**
 * of them — 21 from the pipeline and 3 from the cost ledger (WP-19). A table transcribed from the
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
  // ── The pipeline (WP-15), registered by `createPipelineRuntime` ──────────────
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

  // ── The cost ledger (WP-19), registered by `costHandlers` ────────────────────
  'run.finished': 'handled',
  'run.failed': 'handled',
  /** The estimate at refinement reads the `RefinedSpec`'s size (product/09). */
  'artifact.created': 'handled',

  // ── Declared unconsumed in this build, with the work package that changes it ──
  'ticket.comment.added': 'unconsumed', // WP-31 ask-the-task; feedback intake is WP-24's.
  'ticket.status.changed': 'unconsumed', // Task sync, WP-24 (review-only mode reads it first).
  'task.taken_over': 'unconsumed', // WP-27 take-over/hand-back owns both.
  'task.handed_back': 'unconsumed', // WP-27.
  'run.created': 'unconsumed', // UI band, WP-20's realtime projection.
  'run.started': 'unconsumed', // UI band, WP-20.
  'run.steered': 'unconsumed', // WP-27 steer.
  'workspace.provisioned': 'unconsumed', // UI band, WP-20.
  'workspace.destroyed': 'unconsumed', // WP-20.
  'workspace.exported': 'unconsumed', // WP-20.
  'mr.opened': 'unconsumed', // The pipeline learns its MR from `ImplementationNotes` (WP-15); stats is WP-41.
  'mr.updated': 'unconsumed', // WP-41 statistics.
  // WP-19 *emits* these three from the budgets projection; technical/02's consumers are a
  // notification (Slack, WP-10) and the UI band (WP-20). What stops a new run is a **read** of
  // `budget_windows` at stage admission (`cost/guard.ts` says why), not a handler here.
  'budget.threshold.reached': 'unconsumed', // Slack (210), WP-10; UI band, WP-20.
  'budget.exhausted': 'unconsumed', // Slack (210), WP-10; UI band, WP-20.
  'budget.reset': 'unconsumed', // WP-20. Nothing emits it in this build either (`cost/window.ts`).
  'feedback.received': 'unconsumed', // Feedback intake agent, WP-24.
  'knowledge.proposal.created': 'unconsumed', // Librarian, WP-18.
  'knowledge.proposal.applied': 'unconsumed', // WP-18.
  'knowledge.proposal.rejected': 'unconsumed', // WP-18.
  'knowledge.index.rebuilt': 'unconsumed', // `—` in technical/02: unconsumed by design, not by omission.
  'readiness.evaluated': 'unconsumed', // Policy suggestions, WP-21.
  'config.changed': 'unconsumed', // Audit projection and effective-config rebuild, WP-21.
  // technical/03 attributes an audit and a health projection to "WP-19", and WP-19's plan row does
  // not carry them: it is the cost ledger, the rollups, the budgets, the price job, the estimates
  // and the backfill. They have no work package, which is why no number is named here.
  'integration.action.performed': 'unconsumed', // Audit and health projections; unowned.
  'integration.action.failed': 'unconsumed', // As above.
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
