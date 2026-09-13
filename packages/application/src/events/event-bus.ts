/**
 * The priority dispatcher of TD-005.
 *
 * ## What one dispatch does
 *
 * ```
 * transaction (the dispatcher's own)
 *   claim the event's queue row            -- FOR UPDATE SKIP LOCKED: one worker per event
 *   refuse if an earlier event of the same stream is still queued   -- ordering per stream
 *   for each handler, in priority order:
 *       transaction (the handler's own)
 *          claim (event, handler)          -- skips if it already reached a terminal status
 *          run the handler                 -- its writes, its emitted events, all in here
 *          mark it succeeded
 *       commit                             -- effect and bookkeeping are one write, or neither
 *   all terminal?  delete the queue row and write the $dispatch marker
 *   any failure?   leave it queued with a backoff and record the failure
 * commit
 * then: dispatch whatever the handlers emitted (chaining)
 * ```
 *
 * ## Why that yields exactly-once effects from at-least-once delivery
 *
 * A handler's effect and its `handler_executions` row commit together, so there are only two
 * possible worlds after a crash: both are there (a redelivery finds the terminal row and skips),
 * or neither is (a redelivery re-runs it). Nothing in between. The queue row survives every crash
 * because it is only deleted in the transaction that also proves the work is done. Effects that
 * leave the database — a Slack post — are outside that argument, which is exactly why TD-005
 * requires every handler to be idempotent.
 *
 * ## What it costs
 *
 * Ordering per stream is head-of-line blocking per stream: a handler that keeps failing keeps its
 * stream's later events queued behind it, visible as `handler_executions.status = 'failed'` and as
 * a growing `event_dispatch` backlog. That is the intended trade: an audit log whose consumers may
 * see effects out of order is worse than one that stalls loudly.
 *
 * And **two database connections per dispatch in flight** — the dispatcher's transaction stays open
 * while the handler's runs beside it. That is why `maxConcurrentDispatches` exists and is enforced
 * here rather than left to callers: the number is what an adapter checks its pool against
 * (`createEventing` refuses `poolMax < 2 × concurrency + 1`), so it has to be a property of the bus
 * and not a hope about how often `dispatch` is called. A chained dispatch inherits its parent's
 * slot, because by then the parent's transactions have committed and released their connections.
 */
import type { DomainEvent } from '@platform/contracts';
import type { RetryBackoff } from '../ports/dispatch-queue.js';
import type { StoredEvent } from '../ports/event-store.js';
import {
  DISPATCH_MARKER,
  DISPATCH_MARKER_PRIORITY,
  type HandlerRef,
} from '../ports/handler-executions.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { isConcurrencyConflict, MAX_CONCURRENCY_CONFLICT_ATTEMPTS } from './concurrency.js';
import type { EventHandler, HandlerContext } from './handler.js';
import { HandlerRegistry } from './handler.js';
import { withOpenTransaction } from './open-transaction.js';

/** Why a dispatch attempt ended. */
export type DispatchStatus =
  /** Every handler reached a terminal status; the event left the queue. */
  | 'dispatched'
  /** The event had already been dispatched. */
  | 'completed'
  /** Another worker holds it. */
  | 'busy'
  /** An earlier event of the same stream is still queued. */
  | 'blocked'
  /** At least one handler threw; the event stays queued with a backoff. */
  | 'failed'
  /** The bus is draining and refused new work. */
  | 'stopping';

export interface HandlerOutcome {
  readonly handler: string;
  /**
   * `ran` — handled this delivery. `skipped` — had already reached a terminal status.
   * `stopped` — either called `stop()` itself or was silenced by a handler that did.
   * `failed` — threw; its transaction rolled back, so it left no effect.
   */
  readonly result: 'ran' | 'skipped' | 'stopped' | 'failed';
  readonly error?: string;
}

export interface DispatchResult {
  readonly position: number;
  readonly status: DispatchStatus;
  readonly handlers: readonly HandlerOutcome[];
  /** Events the handlers emitted, in emission order. */
  readonly chained: readonly StoredEvent[];
  /** How deep in a chain this dispatch was; 0 for an event taken from the queue. */
  readonly depth: number;
}

export interface EventBusOptions {
  readonly unitOfWork: UnitOfWork;
  readonly registry?: HandlerRegistry;
  readonly logger?: Logger;
  /**
   * How far a chain of handler-emitted events is followed inside one call. Beyond it the events
   * stay queued and the sweep picks them up: durability is never traded for the guard, only the
   * call stack is bounded, so a handler cycle logs loudly instead of overflowing.
   */
  readonly maxChainDepth?: number;
  /**
   * How many dispatches may be in flight at once. Each holds two pooled connections, so this is
   * the number an adapter sizes its connection pool against; further callers wait for a slot.
   */
  readonly maxConcurrentDispatches?: number;
  /** Base of the retry backoff, in milliseconds; doubled per attempt up to `maxRetryDelayMs`. */
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
}

export const DEFAULT_MAX_CHAIN_DEPTH = 16;
export const DEFAULT_MAX_CONCURRENT_DISPATCHES = 1;
/** Pooled connections one in-flight dispatch holds: the dispatch transaction plus a handler's. */
export const CONNECTIONS_PER_DISPATCH = 2;
export const DEFAULT_RETRY_DELAY_MS = 5_000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000;

export interface StopOptions {
  /** Give up waiting after this long and report what was still in flight. */
  readonly timeoutMs?: number;
}

export interface StopReport {
  readonly drained: boolean;
  readonly inFlight: number;
}

export class EventBus {
  readonly registry: HandlerRegistry;
  readonly #uow: UnitOfWork;
  readonly #logger: Logger;
  readonly #maxChainDepth: number;
  readonly #maxConcurrentDispatches: number;
  readonly #retryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #inFlight = new Set<Promise<unknown>>();
  /** Callers waiting for a dispatch slot, in arrival order. */
  readonly #waiting: (() => void)[] = [];
  #active = 0;
  #stopping = false;

  constructor(options: EventBusOptions) {
    this.registry = options.registry ?? new HandlerRegistry();
    this.#uow = options.unitOfWork;
    this.#logger = options.logger ?? silentLogger;
    this.#maxChainDepth = options.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH;
    this.#maxConcurrentDispatches =
      options.maxConcurrentDispatches ?? DEFAULT_MAX_CONCURRENT_DISPATCHES;
    if (!Number.isInteger(this.#maxConcurrentDispatches) || this.#maxConcurrentDispatches < 1) {
      throw new RangeError(
        `maxConcurrentDispatches must be a positive integer, got ${String(options.maxConcurrentDispatches)}`,
      );
    }
    this.#retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  }

  register(handler: EventHandler): this {
    this.registry.register(handler);
    return this;
  }

  get stopping(): boolean {
    return this.#stopping;
  }

  /** Connections an adapter must keep available for this bus, plus one for the sweep's own reads. */
  get requiredConnections(): number {
    return CONNECTIONS_PER_DISPATCH * this.#maxConcurrentDispatches + 1;
  }

  get maxConcurrentDispatches(): number {
    return this.#maxConcurrentDispatches;
  }

  /**
   * Dispatches one event and then, unless the chain depth is exhausted, whatever its handlers
   * emitted. Safe to call for an event that was already dispatched: it returns `completed`.
   */
  async dispatch(event: StoredEvent): Promise<DispatchResult> {
    if (this.#stopping) {
      return stoppingResult(event);
    }
    // Waiting for a slot bounds the connections in flight. A caller that ignored the bound would
    // otherwise queue on the connection pool instead, which is the same wait with no name on it.
    await this.#acquireSlot();
    if (this.#stopping) {
      this.#releaseSlot();
      return stoppingResult(event);
    }
    try {
      return await this.#dispatchTracked(event, 0);
    } finally {
      this.#releaseSlot();
    }
  }

  /**
   * Stops accepting work and waits for what is in flight, including chained dispatches.
   *
   * Draining rather than dropping is what keeps the guarantee: an event whose handlers are
   * half-run at shutdown is left queued, not lost, and the next process picks it up.
   */
  async stop(options: StopOptions = {}): Promise<StopReport> {
    this.#stopping = true;
    const timeoutMs = options.timeoutMs;

    while (this.#inFlight.size > 0) {
      const settled = Promise.allSettled([...this.#inFlight]);
      if (timeoutMs === undefined) {
        await settled;
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<'timeout'>((resolve) => {
        timer = setTimeout(() => resolve('timeout'), timeoutMs);
      });
      const outcome = await Promise.race([settled.then(() => 'drained' as const), expired]);
      if (timer !== undefined) {
        clearTimeout(timer);
      }
      if (outcome === 'timeout') {
        this.#logger.warn(
          { inFlight: this.#inFlight.size, timeoutMs },
          'event bus stop timed out with dispatches still running',
        );
        return { drained: false, inFlight: this.#inFlight.size };
      }
    }
    return { drained: true, inFlight: 0 };
  }

  /** Re-arms a stopped bus. Only tests and the composition root's restart path use this. */
  resume(): void {
    this.#stopping = false;
  }

  #dispatchTracked(event: StoredEvent, depth: number): Promise<DispatchResult> {
    const running = this.#dispatchOnce(event, depth).finally(() => {
      this.#inFlight.delete(running);
    });
    this.#inFlight.add(running);
    return running;
  }

  async #dispatchOnce(event: StoredEvent, depth: number): Promise<DispatchResult> {
    const result = await this.#runHandlers(event, depth);
    if (result.chained.length === 0) {
      return result;
    }
    if (depth >= this.#maxChainDepth) {
      this.#logger.warn(
        { position: event.position, type: event.event.type, depth, chained: result.chained.length },
        'chain depth exhausted; the emitted events stay queued for the outbox sweep',
      );
      return result;
    }
    for (const chainedEvent of result.chained) {
      if (this.#stopping) {
        break;
      }
      await this.#dispatchTracked(chainedEvent, depth + 1);
    }
    return result;
  }

  async #runHandlers(event: StoredEvent, depth: number): Promise<DispatchResult> {
    const { position } = event;
    const { stream_type: streamType, stream_id: streamId, stream_seq: streamSeq } = event.event;
    const handlers = this.registry.handlersFor(event.event.type);
    const done = (status: DispatchStatus, outcomes: HandlerOutcome[], chained: StoredEvent[]) =>
      ({ position, status, handlers: outcomes, chained, depth }) satisfies DispatchResult;

    return this.#uow.transaction(async (scope) => {
      const claim = await scope.dispatchQueue.claim(position);
      if (claim !== 'claimed') {
        return done(claim === 'busy' ? 'busy' : 'completed', [], []);
      }
      if (await scope.dispatchQueue.hasEarlierPending(streamType, streamId, streamSeq)) {
        return done('blocked', [], []);
      }

      const outcomes: HandlerOutcome[] = [];
      const chained: StoredEvent[] = [];
      let stopped = false;
      let failure: { handler: HandlerRef; error: string } | undefined;

      for (const [index, handler] of handlers.entries()) {
        if (stopped) {
          outcomes.push({ handler: handler.name, result: 'stopped' });
          continue;
        }
        const remaining = handlers.slice(index + 1).map(toHandlerRef);
        const outcome = await this.#runHandler(event, handler, remaining, chained);
        outcomes.push(outcome);
        if (outcome.result === 'failed') {
          failure = { handler: toHandlerRef(handler), error: outcome.error ?? 'unknown error' };
          break;
        }
        if (outcome.result === 'stopped') {
          stopped = true;
        }
      }

      if (failure !== undefined) {
        await scope.handlerExecutions.recordFailure(position, failure.handler, failure.error);
        await scope.dispatchQueue.retryLater(position, failure.error, this.#backoff);
        this.#logger.error(
          {
            position,
            type: event.event.type,
            handler: failure.handler.handler,
            error: failure.error,
          },
          'event handler failed; the event stays queued behind its stream',
        );
        return done('failed', outcomes, []);
      }

      await scope.dispatchQueue.complete(position);
      await scope.handlerExecutions.complete(position, {
        handler: DISPATCH_MARKER,
        priority: DISPATCH_MARKER_PRIORITY,
      });
      return done('dispatched', outcomes, chained);
    });
  }

  /**
   * One handler, in its own transaction: claim, run, mark succeeded — or roll all three back.
   *
   * The rollback is the point. A handler that throws leaves no effect *and* no execution record,
   * so the retry is a clean re-run rather than a partial replay.
   *
   * ## A handler that lost a race is re-run here, immediately (WP-15e)
   *
   * A repository that refuses to write over a row another transaction moved throws a
   * {@link isConcurrencyConflict} error, and the unit that has to run again is this whole
   * transaction: a retry *inside* it would leave the failed attempt's non-idempotent writes behind
   * (`planApprovalGate` inserts an approval with a fresh id before it saves the task). A handler
   * therefore lets the conflict escape, and the bus re-runs it against a clean re-read —
   * {@link MAX_CONCURRENCY_CONFLICT_ATTEMPTS} times.
   *
   * It is here rather than left to `retryLater` because that path costs the **whole stream** five
   * seconds and doubles from there ({@link DEFAULT_RETRY_DELAY_MS}), for a loss whose winner has
   * already committed: the row the retry reads is settled before the first attempt even returns.
   * Exhausting the bound falls through to the ordinary failure path, which records the failure and
   * re-queues the event — never a drop.
   *
   * `emitted` and `afterCommit` are rebuilt per attempt, because a rolled-back attempt's events
   * were never appended and its callbacks were never owed.
   */
  async #runHandler(
    event: StoredEvent,
    handler: EventHandler,
    remaining: readonly HandlerRef[],
    chained: StoredEvent[],
  ): Promise<HandlerOutcome> {
    let outcome = await this.#runHandlerOnce(event, handler, remaining, chained);
    for (
      let attempt = 2;
      attempt <= MAX_CONCURRENCY_CONFLICT_ATTEMPTS && outcome.conflict === true;
      attempt += 1
    ) {
      this.#logger.warn(
        {
          position: event.position,
          type: event.event.type,
          handler: handler.name,
          attempt,
          attempts: MAX_CONCURRENCY_CONFLICT_ATTEMPTS,
          error: outcome.error,
        },
        'a handler lost a race with another writer; re-running it against a fresh read',
      );
      outcome = await this.#runHandlerOnce(event, handler, remaining, chained);
    }
    const { conflict: _conflict, ...result } = outcome;
    return result;
  }

  async #runHandlerOnce(
    event: StoredEvent,
    handler: EventHandler,
    remaining: readonly HandlerRef[],
    chained: StoredEvent[],
  ): Promise<HandlerOutcome & { conflict?: true }> {
    const ref = toHandlerRef(handler);
    const emitted: StoredEvent[] = [];
    const afterCommit: (() => Promise<void> | void)[] = [];
    let stopReason: string | undefined;

    try {
      const ran = await this.#uow.transaction(async (scope) => {
        if (!(await scope.handlerExecutions.claim(event.position, ref))) {
          return false;
        }
        const context = this.#contextFor(
          event,
          scope,
          emitted,
          (reason) => {
            stopReason = reason;
          },
          afterCommit,
        );
        // Marked, so anything the handler reaches that must not hold a pooled connection across a
        // network round trip can refuse rather than be reviewed for (WP-15d, `open-transaction.ts`).
        await withOpenTransaction(async () => handler.handle(context));
        if (stopReason !== undefined && remaining.length > 0) {
          await scope.handlerExecutions.markStopped(event.position, remaining, stopReason);
        }
        await scope.handlerExecutions.complete(event.position, ref);
        return true;
      });

      if (!ran) {
        return { handler: handler.name, result: 'skipped' };
      }
      // Only now: the handler's effect and its execution record are durable, so a job enqueued
      // here can never outlive a rollback. A callback that throws has already lost its race with
      // durability — log it and let the handler stand, because failing it would replay the effect.
      for (const callback of afterCommit) {
        try {
          await callback();
        } catch (error) {
          this.#logger.error(
            {
              position: event.position,
              type: event.event.type,
              handler: handler.name,
              err: error,
            },
            'an after-commit callback failed; the handler’s effect stands and the callback is lost',
          );
        }
      }
      chained.push(...emitted);
      if (stopReason !== undefined) {
        this.#logger.debug(
          { position: event.position, handler: handler.name, reason: stopReason },
          'handler stopped the remaining handlers of this event',
        );
        return { handler: handler.name, result: 'stopped' };
      }
      return { handler: handler.name, result: 'ran' };
    } catch (error) {
      return {
        handler: handler.name,
        result: 'failed',
        error: describeError(error),
        ...(isConcurrencyConflict(error) ? { conflict: true as const } : {}),
      };
    }
  }

  #contextFor(
    event: StoredEvent,
    scope: TransactionScope,
    emitted: StoredEvent[],
    onStop: (reason: string) => void,
    afterCommit: (() => Promise<void> | void)[],
  ): HandlerContext {
    return {
      scope,
      event,
      emit: async (events: readonly DomainEvent[]) => {
        const appended = await scope.events.append(events, {
          causeEventPosition: event.position,
        });
        emitted.push(...appended);
        return appended;
      },
      stop: (reason: string) => {
        onStop(reason);
      },
      afterCommit: (callback: () => Promise<void> | void) => {
        afterCommit.push(callback);
      },
    };
  }

  get #backoff(): RetryBackoff {
    return { baseMs: this.#retryDelayMs, maxMs: this.#maxRetryDelayMs };
  }

  /**
   * Takes a dispatch slot, waiting for one if the bus is at its limit.
   *
   * A waiter does **not** increment on waking: the slot was handed to it by `#releaseSlot`, which
   * never gave it back to the counter. See there for why that matters.
   */
  async #acquireSlot(): Promise<void> {
    if (this.#active < this.#maxConcurrentDispatches) {
      this.#active += 1;
      return;
    }
    await new Promise<void>((resolve) => {
      this.#waiting.push(resolve);
    });
  }

  /**
   * Hands the slot to the next waiter, or gives it back to the counter when there is none.
   *
   * The distinction is the whole guarantee. Decrementing first and *then* waking a waiter — which
   * resumes a microtask later — leaves `#active` below the limit for that gap, so a `dispatch()`
   * call already sitting in the microtask queue takes the freed slot synchronously and the woken
   * waiter takes one too: with a limit of 1, two handlers run at once and `requiredConnections`
   * stops being an upper bound. Transferring the slot without it ever passing through the counter
   * closes the gap, because there is no instant at which the slot is free.
   */
  #releaseSlot(): void {
    // FIFO, so a burst of callers cannot starve the one that arrived first.
    const next = this.#waiting.shift();
    if (next !== undefined) {
      next();
      return;
    }
    this.#active -= 1;
  }
}

const stoppingResult = (event: StoredEvent): DispatchResult => ({
  position: event.position,
  status: 'stopping',
  handlers: [],
  chained: [],
  depth: 0,
});

const toHandlerRef = (handler: EventHandler): HandlerRef => ({
  handler: handler.name,
  priority: handler.priority,
});

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
