/**
 * Replaying a window of the log into a handler that was not registered when it happened — the
 * backfill WP-15a's outbox sweep made necessary (PROGRESS backlog 1, `docs/TODO.md`).
 *
 * ## Why this is not a re-dispatch
 *
 * `EventBus.dispatch` refuses an event that has already been dispatched, by design: the dispatch
 * *claims the `event_dispatch` row*, and a completed dispatch has deleted it and written the
 * `$dispatch` marker in `handler_executions`. That is right — leaving the row would make
 * `hasEarlierPending` block every later event of the same stream — and it is exactly why a handler
 * registered afterwards can never be served by the queue. So this is a **distinct read-and-apply**:
 * it reads `events` (append-only, TD-005 `REVOKE DELETE`), never `event_dispatch`, and it runs the
 * handlers it was given and nothing else.
 *
 * ## It does not bypass `handler_executions` — it *uses* it
 *
 * Each handler still claims `(position, handler)` in the transaction that holds its writes, so the
 * replay inherits TD-005's exactly-once effects unchanged:
 *
 *  - a **new** handler has no row at any position, so it runs once per event;
 *  - a **second** replay over the same range finds `succeeded` rows and skips every one of them;
 *  - a handler that was already dispatched normally is skipped, so a range that overlaps live
 *    traffic is safe;
 *  - the `$dispatch` marker is a different handler name and is never consulted here, which is what
 *    makes a completed dispatch replayable for a handler that has no record of its own.
 *
 * The one thing the replay must not do is *write* the marker or complete a queue row: the events in
 * range have already been dispatched for everybody else, and a marker written twice would claim a
 * completeness this pass does not have.
 *
 * ## What it costs, stated
 *
 * Handlers run **out of dispatch order relative to live traffic** — the replay holds no dispatch
 * slot and no queue claim, so an event being replayed can interleave with a live event of the same
 * stream. For a projection keyed by its own rows (the cost ledger) that is harmless; for a handler
 * whose effect depends on the *state* another handler is concurrently changing, it is not, and such
 * a handler must not be replayed while its producer is running. Events a replayed handler emits are
 * appended normally, so they queue and the outbox dispatches them like any other.
 *
 * A handler that throws **stops the pass**. A backfill that skipped what it could not apply would
 * report success over a ledger with holes in it; stopping leaves `lastPosition` as a resume point,
 * and the failure is reported by name. Nothing is written to `handler_executions` for it: the
 * handler's transaction rolled back, so there is no partial effect to record, and a `failed` row
 * from a maintenance pass would look like a dispatcher failure to an operator reading the table.
 */
import type { DomainEventType } from '@platform/contracts';
import type { EventStore, StoredEvent } from '../ports/event-store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { EventHandler } from './handler.js';

export const DEFAULT_REPLAY_BATCH_SIZE = 200;

export interface ReplayOptions {
  readonly store: EventStore;
  readonly unitOfWork: UnitOfWork;
  readonly logger?: Logger;
}

export interface ReplayRequest {
  /**
   * The handlers to serve. The event types read from the log are **derived** from them, so a
   * caller cannot ask for a range that does not match what it registered.
   */
  readonly handlers: readonly EventHandler[];
  /** Exclusive lower bound on `events.position`. @default 0 (the whole log) */
  readonly fromPosition?: number;
  /** Inclusive upper bound. @default the end of the log at the moment each batch is read */
  readonly toPosition?: number;
  /** Events per read. @default 200 */
  readonly batchSize?: number;
}

export interface ReplayFailure {
  readonly position: number;
  readonly handler: string;
  readonly error: string;
}

export interface ReplayReport {
  readonly scanned: number;
  /** Handler executions that ran and committed. */
  readonly applied: number;
  /** Handler executions skipped because they had already reached a terminal status. */
  readonly skipped: number;
  /** The last position fully processed; a resume point after a failure. */
  readonly lastPosition: number;
  /** Empty unless the pass stopped: at most one, because a failure ends the pass. */
  readonly failures: readonly ReplayFailure[];
}

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);

/** Every type the handlers want, or `undefined` when one of them wants all of them. */
export const replayTypesOf = (
  handlers: readonly EventHandler[],
): readonly DomainEventType[] | undefined => {
  const types = new Set<DomainEventType>();
  for (const handler of handlers) {
    if (handler.eventTypes === 'all') {
      return undefined;
    }
    for (const type of handler.eventTypes) {
      types.add(type);
    }
  }
  return [...types];
};

const handlersFor = (
  handlers: readonly EventHandler[],
  event: StoredEvent,
): readonly EventHandler[] =>
  handlers
    .filter(
      (handler) => handler.eventTypes === 'all' || handler.eventTypes.includes(event.event.type),
    )
    .toSorted((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : 1));

/**
 * Runs `request.handlers` over the events in range, once each, and reports what it did.
 *
 * Safe to run twice: the second pass skips everything the first applied.
 */
export const replayEvents = async (
  options: ReplayOptions,
  request: ReplayRequest,
): Promise<ReplayReport> => {
  const logger = options.logger ?? silentLogger;
  const types = replayTypesOf(request.handlers);
  const batchSize = request.batchSize ?? DEFAULT_REPLAY_BATCH_SIZE;
  let cursor = request.fromPosition ?? 0;
  let scanned = 0;
  let applied = 0;
  let skipped = 0;

  for (;;) {
    const batch = await options.store.readRange({
      fromPosition: cursor,
      ...(request.toPosition === undefined ? {} : { toPosition: request.toPosition }),
      ...(types === undefined ? {} : { types }),
      limit: batchSize,
    });
    if (batch.length === 0) {
      break;
    }
    for (const event of batch) {
      scanned += 1;
      for (const handler of handlersFor(request.handlers, event)) {
        const ref = { handler: handler.name, priority: handler.priority };
        const afterCommit: (() => Promise<void> | void)[] = [];
        let ran = false;
        try {
          ran = await options.unitOfWork.transaction(async (scope) => {
            if (!(await scope.handlerExecutions.claim(event.position, ref))) {
              return false;
            }
            await handler.handle({
              scope,
              event,
              emit: async (events) =>
                scope.events.append(events, { causeEventPosition: event.position }),
              stop: (reason: string) => {
                // A replay has no "remaining handlers" to silence: it serves the set it was given
                // and nothing else. Recording the request is honest; acting on it would write
                // `stopped` rows for handlers this pass never considered.
                logger.warn(
                  { position: event.position, handler: handler.name, reason },
                  'replay: a handler asked to stop the remaining handlers; a replay has none to stop',
                );
              },
              afterCommit: (callback) => {
                afterCommit.push(callback);
              },
            });
            await scope.handlerExecutions.complete(event.position, ref);
            return true;
          });
        } catch (error) {
          const failure = {
            position: event.position,
            handler: handler.name,
            error: describeError(error),
          };
          logger.error(
            { ...failure, scanned, applied, skipped },
            'replay: a handler failed; the pass stops here so the range can be resumed',
          );
          return { scanned, applied, skipped, lastPosition: cursor, failures: [failure] };
        }
        if (ran) {
          applied += 1;
          for (const callback of afterCommit) {
            try {
              await callback();
            } catch (error) {
              logger.error(
                { position: event.position, handler: handler.name, err: error },
                'replay: an after-commit callback failed; the handler’s effect stands',
              );
            }
          }
        } else {
          skipped += 1;
        }
      }
      cursor = event.position;
    }
    if (batch.length < batchSize) {
      break;
    }
  }

  logger.info({ scanned, applied, skipped, last_position: cursor }, 'replay finished');
  return { scanned, applied, skipped, lastPosition: cursor, failures: [] };
};
