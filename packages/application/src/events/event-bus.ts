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
 *   any failure?   record it, then either re-queue with a backoff or spend the last attempt:
 *                  mark the row dead-lettered and tell the dead-letter sink (WP-49)
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
 * It is bounded (WP-49). Until then the block was **permanent** for an event whose handler fails
 * deterministically — nothing compared the row's `attempts` with anything, so the sweep re-offered
 * it at the backoff ceiling for ever and the stream behind it never moved. After
 * {@link DEFAULT_MAX_DISPATCH_ATTEMPTS} attempts the event is dead-lettered instead: it leaves the
 * queue into a terminal state the sweep and the ordering guard both skip, the {@link DeadLetterSink}
 * is told inside the same transaction (which is how the task ends up in `needs_human` with a brief
 * naming this event and this handler), and `events` is untouched — the event is still in the log
 * and still replayable by `events/replay.ts`.
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
import type { DeadLetterSink } from './dead-letter.js';
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
  /**
   * A handler threw for the last time: the event spent its attempt bound, left the queue into a
   * terminal state and will not be dispatched again (WP-49). Also what a dispatch of an
   * already-dead-lettered event answers, so a second `dispatch()` call re-runs nothing.
   */
  | 'dead-lettered'
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
  /**
   * What the dispatches of {@link chained} ended as, in the same order (WP-49, backlog 5).
   *
   * Empty when nothing was emitted **and** when the chain was not followed — the depth guard, or a
   * bus that started draining mid-chain — so it is shorter than `chained` rather than lying about
   * it. Without this a chained handler's failure was invisible to everything above `dispatch()`:
   * the parent reported `dispatched`, the sweep counted it as a success, and the only trace was a
   * log line. `countChainFailures` in `outbox.ts` is what reads it.
   */
  readonly chainedResults: readonly DispatchResult[];
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
  /**
   * Attempts an event gets before it is dead-lettered instead of retried (WP-49).
   * @default DEFAULT_MAX_DISPATCH_ATTEMPTS
   */
  readonly maxDispatchAttempts?: number;
}

export const DEFAULT_MAX_CHAIN_DEPTH = 16;
export const DEFAULT_MAX_CONCURRENT_DISPATCHES = 1;
/** Pooled connections one in-flight dispatch holds: the dispatch transaction plus a handler's. */
export const CONNECTIONS_PER_DISPATCH = 2;
export const DEFAULT_RETRY_DELAY_MS = 5_000;
export const DEFAULT_MAX_RETRY_DELAY_MS = 5 * 60_000;
/**
 * How many times one event is dispatched before it is dead-lettered (WP-49, backlog 43).
 *
 * **The arithmetic, from the two constants above.** The delay before attempt `n + 1` is
 * `min(DEFAULT_RETRY_DELAY_MS × 2ⁿ⁻¹, DEFAULT_MAX_RETRY_DELAY_MS)`, so the nine waits that ten
 * attempts contain are 5 s, 10, 20, 40, 80, 160, then the 300 s ceiling three times — **1 215 s,
 * about 20 minutes** of retrying before the event leaves the queue ({@link dispatchRetryWindowMs}
 * computes exactly that, and `event-bus.test.ts` pins the number so this sentence cannot drift from
 * the defaults it quotes).
 *
 * **Why twenty minutes.** It has to be longer than every transient fault the platform can ride out
 * — a database failover, a rolling deploy, a provider's five-minute outage — because a dead letter
 * parks the task in front of a human, and it has to be short enough that a task poisoned by a
 * payload no handler can parse stops moving for a fifth of an hour rather than for ever. Ten
 * attempts is also where the backoff stops growing: from the seventh on, every further attempt buys
 * the same five minutes, so the number says "three attempts at the ceiling and then stop" rather
 * than an arbitrary count.
 *
 * Configurable as `APP_DISPATCH_MAX_ATTEMPTS` for an operator who would rather have a stuck stream
 * than an escalated task — `Infinity` is the behaviour every build before WP-49 had.
 */
export const DEFAULT_MAX_DISPATCH_ATTEMPTS = 10;

/**
 * How long a dead letter takes to arrive, from the first failure to the last attempt.
 *
 * The sum of the `attempts − 1` backoff delays. It exists so the number quoted on
 * {@link DEFAULT_MAX_DISPATCH_ATTEMPTS} is produced rather than remembered (standing rule 39): it
 * is the same formula `DispatchQueue.failAttempt` schedules with, written once here and asserted
 * against the shipped defaults.
 */
export const dispatchRetryWindowMs = (
  options: {
    readonly retryDelayMs?: number;
    readonly maxRetryDelayMs?: number;
    readonly maxAttempts?: number;
  } = {},
): number => {
  const base = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const max = options.maxRetryDelayMs ?? DEFAULT_MAX_RETRY_DELAY_MS;
  const attempts = options.maxAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS;
  if (!Number.isFinite(attempts)) {
    // A bound that is not a number has no window, and saying so is better than counting to it.
    return Number.POSITIVE_INFINITY;
  }
  let total = 0;
  for (let attempt = 1; attempt < attempts; attempt += 1) {
    // `2 ** Math.min(attempt - 1, 10)` is the exponent cap the SQL applies (`least(attempts, 10)`),
    // which matters only for a base small enough that doubling has not reached `max` by then.
    total += Math.min(base * 2 ** Math.min(attempt - 1, 10), max);
  }
  return total;
};

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
  readonly #maxDispatchAttempts: number;
  #deadLetter: DeadLetterSink | undefined;
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
    this.#maxDispatchAttempts = options.maxDispatchAttempts ?? DEFAULT_MAX_DISPATCH_ATTEMPTS;
    if (this.#maxDispatchAttempts < 1) {
      throw new RangeError(
        `maxDispatchAttempts must be at least 1, got ${String(options.maxDispatchAttempts)}`,
      );
    }
  }

  register(handler: EventHandler): this {
    this.registry.register(handler);
    return this;
  }

  /**
   * Registers what happens to a dead-lettered event's task (WP-49).
   *
   * Late-bound like {@link register}, and for the same reason: `createEventing` builds the bus
   * before a composition root has a pipeline to escalate with. **Exactly one** — a second
   * registration throws rather than replacing the first, because a silently replaced sink is a
   * task nobody is told about.
   */
  onDeadLetter(sink: DeadLetterSink): this {
    if (this.#deadLetter !== undefined) {
      throw new Error(
        'a dead-letter sink is already registered on this bus; one process decides what a poisoned event does to its task, and a second registration would silently replace the first',
      );
    }
    this.#deadLetter = sink;
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
    // Kept, not discarded: a chained dispatch's failure was invisible above this line until WP-49
    // (backlog 5), because only the parent's status ever came back.
    const chainedResults: DispatchResult[] = [];
    for (const chainedEvent of result.chained) {
      if (this.#stopping) {
        break;
      }
      chainedResults.push(await this.#dispatchTracked(chainedEvent, depth + 1));
    }
    return { ...result, chainedResults };
  }

  async #runHandlers(event: StoredEvent, depth: number): Promise<DispatchResult> {
    const { position } = event;
    const { stream_type: streamType, stream_id: streamId, stream_seq: streamSeq } = event.event;
    const handlers = this.registry.handlersFor(event.event.type);
    const done = (status: DispatchStatus, outcomes: HandlerOutcome[], chained: StoredEvent[]) =>
      ({
        position,
        status,
        handlers: outcomes,
        chained,
        chainedResults: [],
        depth,
      }) satisfies DispatchResult;

    return this.#uow.transaction(async (scope) => {
      const claim = await scope.dispatchQueue.claim(position);
      if (claim !== 'claimed') {
        // A dead-lettered row is reported as itself rather than as `busy`: a caller told `busy`
        // tries again, and this row must never be dispatched again (WP-49).
        return done(claim, [], []);
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
        // The bound is checked where the attempt is *recorded* — one statement, in the
        // dispatcher's transaction, so the count that decides cannot be read before the increment
        // that changes it, and no handler can be written in a way that escapes it.
        //
        // **Here and not in the handler's transaction**, which is the one other place it could go
        // and where it would never fire: that transaction rolled back with the throw, taking the
        // mark with it, so the row would come back at `attempts` for ever. The same rollback is
        // why `recordFailure` above is on this transaction too (TD-005), and it is what makes the
        // dead letter a *dispatcher* decision rather than something a handler can opt out of.
        const attempt = await scope.dispatchQueue.failAttempt(position, {
          error: failure.error,
          handler: failure.handler.handler,
          backoff: this.#backoff,
          maxAttempts: this.#maxDispatchAttempts,
        });
        const context = {
          position,
          type: event.event.type,
          handler: failure.handler.handler,
          attempts: attempt.attempts,
          error: failure.error,
        };
        if (attempt.ending === 'retry') {
          this.#logger.error(
            context,
            'event handler failed; the event stays queued behind its stream',
          );
          return done('failed', outcomes, []);
        }
        // Marked for the same reason the handler invocation above is, and it was **not** until
        // WP-49 round 1: measured `transactionIsOpen()` false inside the sink and true inside a
        // handler, which made `dead-letter.ts`'s "it may not call anything outside the database" a
        // convention rather than a refusal. The sink runs with this event's queue row locked and
        // two pooled connections held, which is strictly more than a handler holds.
        await withOpenTransaction(async () => {
          await this.#deadLetter?.(scope, {
            event,
            handler: failure.handler.handler,
            attempts: attempt.attempts,
            error: failure.error,
          });
        });
        this.#logger.error(
          {
            ...context,
            max_attempts: this.#maxDispatchAttempts,
            // What was *called*, never what it did: a sink that found no task escalates nothing,
            // and a log line claiming otherwise would be read as an escalation that happened.
            dead_letter_sink: this.#deadLetter === undefined ? 'absent' : 'called',
          },
          'event handler failed for the last time; the event is dead-lettered, its stream moves on, and it stays in the log for a replay (WP-49)',
        );
        return done('dead-lettered', outcomes, []);
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
   * It is here rather than left to the queue's own retry because that path costs the **whole
   * stream** five seconds and doubles from there ({@link DEFAULT_RETRY_DELAY_MS}), for a loss whose
   * winner has already committed: the row the retry reads is settled before the first attempt even
   * returns. Exhausting the bound falls through to the ordinary failure path, which records the
   * failure and re-queues the event — and, since WP-49, dead-letters it instead once the event has
   * spent {@link DEFAULT_MAX_DISPATCH_ATTEMPTS} attempts. Never a drop either way: `events` is
   * append-only and a dead-lettered event is still replayable.
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
  chainedResults: [],
  depth: 0,
});

const toHandlerRef = (handler: EventHandler): HandlerRef => ({
  handler: handler.name,
  priority: handler.priority,
});

const describeError = (error: unknown): string =>
  error instanceof Error ? `${error.name}: ${error.message}` : String(error);
