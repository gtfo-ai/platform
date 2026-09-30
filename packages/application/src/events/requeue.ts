/**
 * Serving a dead-lettered event again (WP-95, PROGRESS backlog 126).
 *
 * WP-49 gave a poisoned event an ending: after `APP_DISPATCH_MAX_ATTEMPTS` failures its queue row is
 * marked `dead_lettered_at`, the stream moves on, and the task it names is escalated. What it left
 * to a hand-typed `update` was the way back once the handler is fixed. This is that way back, as a
 * command.
 *
 * ## What a re-queue does, and what it deliberately does not
 *
 * - **It changes the queue row and nothing else.** `attempts` back to 0, `dead_lettered_at` and
 *   `dead_letter_handler` cleared, `available_at` now — the statement migration 0037's header
 *   documented, now behind a state check. `error` is kept: it is the last thing that went wrong,
 *   and the next failure overwrites it.
 * - **The event is not copied and nothing is appended.** `events` is append-only (TD-005) and the
 *   re-queued event is the **same row at the same position** — same id, same payload, same
 *   `stream_seq` — so every handler sees the event it would have seen, and the log does not grow a
 *   second copy a replay would then serve twice.
 * - **Handlers that already succeeded do not run again.** `handler_executions` records each
 *   `(position, handler)` that completed, and the dispatcher's claim skips a `succeeded` row, so the
 *   re-dispatch runs the handler that failed and the ones after it — once each — and the effects the
 *   earlier ones committed are not doubled (TD-005's idempotency, not a property of this module).
 *   A dead letter never marks the remaining handlers `stopped` (`event-bus.ts`), which is what makes
 *   them runnable here.
 * - **Replay is not the mechanism.** `events/replay.ts` serves a *range* of the log to a handler
 *   set and never touches `event_dispatch`; re-serving one event through it would bypass the row
 *   that records the event was never dispatched, which is the row this command exists to act on.
 *
 * ## The wake-up
 *
 * The re-queue publishes `events.appended` on its own transaction, so a dispatcher listening for it
 * sweeps as soon as the row is visible rather than at the next poll. It is a hint, exactly as it is
 * for an append: the sweep is what dispatches.
 *
 * ## What it does not decide
 *
 * The task the dead letter escalated stays where the escalation put it (`needs_human`). A re-queued
 * event that now succeeds does whatever its handlers do; whether the task should move is the
 * handlers' and the human's, and a command that also resumed the task would be a second, unasked
 * decision. The route that calls this writes the `human_actions` row.
 */
import { EVENTS_APPENDED_TOPIC } from '../ports/broadcast.js';
import type {
  DeadLetterPage,
  DeadLetterPageRequest,
  DeadLetterRow,
  DeadLetterStore,
} from '../ports/dead-letters.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** Why a re-queue was refused, in the words the route answers with. */
export type DeadLetterRequeueRefusal = 'not_dead_lettered' | 'already_dispatched' | 'unknown_event';

/**
 * A re-queue refused by the queue row's state.
 *
 * Typed rather than a message, so the route maps it to its status without parsing prose: the two
 * refusals about a row that exists are `409`s naming the state, and an event that is not in the log
 * at all is a `404`.
 */
export class DeadLetterRequeueRefusedError extends Error {
  readonly position: number;
  readonly refusal: DeadLetterRequeueRefusal;

  constructor(position: number, refusal: DeadLetterRequeueRefusal) {
    super(describeRefusal(position, refusal));
    this.name = 'DeadLetterRequeueRefusedError';
    this.position = position;
    this.refusal = refusal;
  }
}

const describeRefusal = (position: number, refusal: DeadLetterRequeueRefusal): string => {
  switch (refusal) {
    case 'not_dead_lettered':
      return `event ${position} is queued and has not been dead-lettered; the dispatcher will offer it again by itself`;
    case 'already_dispatched':
      return `event ${position} has no dispatch row left: its dispatch already completed, so there is nothing to re-queue`;
    case 'unknown_event':
      return `there is no event at position ${position}`;
  }
};

export interface DeadLetterCommands {
  readonly list: (request: DeadLetterPageRequest) => Promise<DeadLetterPage>;
  /**
   * Puts one dead-lettered event back in the queue, or throws
   * {@link DeadLetterRequeueRefusedError}. Answers the row **as it was dead-lettered** — the handler,
   * the attempts and the task — because that is what the audit row records.
   */
  readonly requeue: (
    position: number,
  ) => Promise<{ readonly row: DeadLetterRow; readonly requeuedAt: string }>;
}

export const createDeadLetterCommands = (options: {
  readonly unitOfWork: UnitOfWork;
  readonly store: DeadLetterStore;
}): DeadLetterCommands => ({
  list: async (request) => options.store.list(request),
  requeue: async (position) =>
    options.unitOfWork.transaction(async (scope) => {
      const outcome = await options.store.requeue(scope.tx, position);
      switch (outcome.status) {
        case 'requeued':
          await scope.broadcast.publish({ topic: EVENTS_APPENDED_TOPIC, payload: {} });
          return { row: outcome.row, requeuedAt: outcome.requeuedAt };
        case 'pending':
          throw new DeadLetterRequeueRefusedError(position, 'not_dead_lettered');
        case 'dispatched':
          throw new DeadLetterRequeueRefusedError(position, 'already_dispatched');
        case 'unknown':
          throw new DeadLetterRequeueRefusedError(position, 'unknown_event');
      }
    }),
});
