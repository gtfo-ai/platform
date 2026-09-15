/**
 * What the dispatcher tells the rest of the platform when an event spends its attempt bound
 * (WP-49, PROGRESS backlog 43).
 *
 * ## Why this is a port and not a branch in the bus
 *
 * `EventBus` knows about events, handlers and a queue row. It does not know what an event is
 * *about*, and the product's answer to a poisoned event — Q59's, reused — is about a **task**: park
 * it in `needs_human` with a brief, exactly as {@link escalateTaskAfterConflict} does for a write
 * that lost every race. A bus that imported the task aggregate to do that would make the dispatcher
 * depend on the pipeline, so the dispatcher publishes the fact and the composition root decides
 * what it means. `packages/application/src/pipeline/dead-letter.ts` is the one implementation this
 * build ships.
 *
 * ## It is called inside the dispatcher's transaction, and that is the whole design
 *
 * The sink receives the same {@link TransactionScope} that marked the queue row, so the dead letter
 * and its escalation commit together or not at all — TD-005's rule for a handler's effect and its
 * bookkeeping, applied to the dispatcher's own. Three consequences, all deliberate:
 *
 *  - **There is no second escalation, by construction.** The row is marked in the transaction that
 *    escalated, and every later sweep skips a marked row, so no mark of "already escalated" has to
 *    be maintained anywhere.
 *  - **A sink that throws rolls the dead letter back**, and the event is dispatched again on the
 *    next sweep, fails again, and offers the sink another go. That is the fail-closed direction
 *    (standing rule 20): the alternative — commit the dead letter and log the lost escalation —
 *    turns a task nobody was told about into the permanent state. The retry is bounded in rate by
 *    the sweep's poll interval, not in count, which is acceptable only because the failure a sink
 *    can actually raise is a concurrency conflict with another writer of the same task, and that
 *    clears as soon as the other writer commits.
 *  - **It may not call anything outside the database, and that is refused rather than reviewed
 *    for.** It runs with the event's queue row locked and two pooled connections held, which is the
 *    rule technical/02 states for a handler and which applies here with more force. The dispatcher
 *    wraps the call in `withOpenTransaction`, so a provider read reached from a sink meets
 *    `assertOutsideTransaction` exactly as one reached from a handler does. It was **not** marked
 *    when this module first shipped — round 1 measured `transactionIsOpen()` false here and true in
 *    a handler, which made this sentence a convention describing itself.
 *
 * ## A build with no sink still dead-letters
 *
 * The sink is optional because a process may dispatch without composing the pipeline. Its absence
 * changes what a human is told, never what the queue does: the event still leaves the queue, the
 * log line is still written and `event_dispatch_dead_lettered` still moves.
 */

import type { StoredEvent } from '../ports/event-store.js';
import type { TransactionScope } from '../ports/unit-of-work.js';

/** One event that will not be dispatched again, and why. */
export interface DeadLetterRecord {
  /** The event itself, straight from the log — never a summary of it. */
  readonly event: StoredEvent;
  /** The handler whose failure spent the bound. */
  readonly handler: string;
  /** Attempts the event had, including the one that spent the bound. */
  readonly attempts: number;
  /** The last failure's text, as `handler_executions.error` records it. */
  readonly error: string;
}

/**
 * Called once per dead-lettered event, inside the dispatcher's transaction.
 *
 * @throws anything it likes — see the module docblock: the dead letter rolls back with it and the
 * event is offered again on the next sweep.
 */
export type DeadLetterSink = (scope: TransactionScope, record: DeadLetterRecord) => Promise<void>;
