/**
 * The outbox job of TD-005: the loop that takes events off the log and hands them to the bus.
 *
 * Two ways in, one of which is only about latency:
 *
 * - **the sweep** — `EventStore.readPendingDispatch` returns the earliest queued event of each
 *   stream, which the worker dispatches in position order. This is the guarantee: whatever else
 *   happens, a committed event is eventually dispatched, because the only thing that removes it
 *   from the queue is the transaction that finished its handlers.
 * - **the wake-up** — the append publishes on `events.appended`, and Postgres delivers that
 *   `NOTIFY` once per committing transaction (TD-005). Missing it costs a poll interval, nothing
 *   more; TD-014's polling fallback is exactly this worker's `pollIntervalMs`.
 *
 * `stop()` drains: the current sweep finishes and the bus waits for its in-flight dispatches, so
 * shutting down never leaves a handler half-run — it leaves the event queued for the next process.
 *
 * ## Where WP-05 plugs in
 *
 * `event_dispatch` plus this sweep stay the single queue of record; pg-boss does not get a
 * `dispatch(event)` job of its own. Two queues would disagree after a crash, and pg-boss has no
 * per-stream serialisation, so ordering would fall back on `hasEarlierPending` refusing and
 * rescheduling — a retry storm where head-of-line blocking belongs. What WP-05 replaces is only the
 * *timer*: pass a `DrainScheduler` and the internal `setTimeout` poll gives way to a recurring
 * pg-boss job calling `drain()`, while the `NOTIFY` subscription keeps waking it for latency.
 */
import { type Broadcast, EVENTS_APPENDED_TOPIC } from '../ports/broadcast.js';
import type { EventStore } from '../ports/event-store.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import type { DispatchStatus, EventBus, StopOptions, StopReport } from './event-bus.js';

/**
 * The seam WP-05's `Jobs` port implements: run `drain` on a recurring schedule.
 *
 * Deliberately smaller than a job queue — one recurring call, no payload, no retries of its own —
 * because the durability is already in `event_dispatch`. A scheduler that misses a run costs
 * latency, never an event.
 */
export interface DrainScheduler {
  /**
   * Registers `run` to be called about every `intervalMs`, and resolves to a handle that stops it.
   * Implementations should coalesce overlapping runs (pg-boss `singleton`): a sweep already draining
   * needs no second caller.
   */
  schedule(
    name: string,
    intervalMs: number,
    run: () => Promise<void>,
  ): Promise<{ stop(): Promise<void> }>;
}

/** Job name WP-05 registers the sweep under. */
export const OUTBOX_SWEEP_JOB = 'events.outbox.sweep' as const;

export interface OutboxWorkerOptions {
  readonly bus: EventBus;
  readonly store: EventStore;
  /** Wake-up transport. Without it the worker is a pure poller, which is still correct. */
  readonly broadcast?: Broadcast;
  readonly logger?: Logger;
  /** Events per sweep batch. */
  readonly batchSize?: number;
  /** Longest a fully idle worker waits before sweeping again. */
  readonly pollIntervalMs?: number;
  /**
   * Runs the sweep on an external schedule instead of this worker's own timer (WP-05). The
   * `NOTIFY` subscription still wakes `drain()` directly, so latency does not depend on it.
   */
  readonly scheduler?: DrainScheduler;
}

export const DEFAULT_BATCH_SIZE = 32;
export const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface SweepReport {
  readonly scanned: number;
  readonly dispatched: number;
  readonly failed: number;
  /** Events another worker held or whose stream had an earlier event still queued. */
  readonly deferred: number;
}

const EMPTY_SWEEP: SweepReport = { scanned: 0, dispatched: 0, failed: 0, deferred: 0 };

/** Runs cleanup that must never mask the failure it is cleaning up after. */
const suppressed = async (work: () => Promise<unknown>): Promise<void> => {
  try {
    await work();
  } catch {
    // Deliberately dropped: the original error is the one worth reporting.
  }
};

export class OutboxWorker {
  readonly #bus: EventBus;
  readonly #store: EventStore;
  readonly #broadcast: Broadcast | undefined;
  readonly #logger: Logger;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;
  readonly #scheduler: DrainScheduler | undefined;

  #running = false;
  #loop: Promise<void> | undefined;
  #scheduled: { stop(): Promise<void> } | undefined;
  #subscription: { close(): Promise<void> } | undefined;
  #wake: (() => void) | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  /** A wake-up that arrived while the worker was busy is remembered, not lost. */
  #pendingWake = false;

  constructor(options: OutboxWorkerOptions) {
    this.#bus = options.bus;
    this.#store = options.store;
    this.#broadcast = options.broadcast;
    this.#logger = options.logger ?? silentLogger;
    this.#batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#scheduler = options.scheduler;
  }

  get running(): boolean {
    return this.#running;
  }

  /** Subscribes to the wake-up topic and starts the loop. Idempotent. */
  async start(): Promise<void> {
    if (this.#running) {
      return;
    }
    this.#running = true;
    try {
      if (this.#broadcast !== undefined) {
        this.#subscription = await this.#broadcast.subscribe([EVENTS_APPENDED_TOPIC], () => {
          this.#onWake();
        });
      }
      if (this.#scheduler === undefined) {
        this.#loop = this.#run();
        return;
      }
      // An external scheduler owns the timer; a wake-up hint still drains directly, so the two
      // paths race only into `drain`, which is safe to call concurrently — the queue claims decide.
      this.#scheduled = await this.#scheduler.schedule(
        OUTBOX_SWEEP_JOB,
        this.#pollIntervalMs,
        async () => {
          await this.#drainGuarded();
        },
      );
      this.#loop = this.#runWoken();
    } catch (error) {
      // A subscription or a schedule that failed leaves the worker half-started: `running` true, a
      // live subscription, no loop. Undo it and let the caller decide, rather than reporting a
      // worker that is not sweeping as started.
      //
      // The unwind runs through `suppressed`, not `.catch()`: a `close()` that throws
      // *synchronously* never reaches an attached `.catch`, so it would escape and replace the
      // failure the caller actually needs to see.
      this.#running = false;
      await suppressed(async () => this.#subscription?.close());
      this.#subscription = undefined;
      await suppressed(async () => this.#scheduled?.stop());
      this.#scheduled = undefined;
      throw error;
    }
  }

  /**
   * Stops the loop, waits for the sweep in progress and drains the bus.
   *
   * @returns whether everything in flight finished within `timeoutMs`.
   */
  async stop(options: StopOptions = {}): Promise<StopReport> {
    this.#running = false;
    this.#onWake();
    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#subscription?.close();
    this.#subscription = undefined;
    await this.#scheduled?.stop();
    this.#scheduled = undefined;
    await this.#loop;
    this.#loop = undefined;
    return this.#bus.stop(options);
  }

  /**
   * Sweeps until nothing more can be dispatched right now, and reports the totals.
   *
   * Used by the loop and, on its own, by tests and by a one-shot `ROLE=worker --once` mode.
   */
  async drain(): Promise<SweepReport> {
    let total = EMPTY_SWEEP;
    for (;;) {
      const batch = await this.sweepOnce();
      total = {
        scanned: total.scanned + batch.scanned,
        dispatched: total.dispatched + batch.dispatched,
        failed: total.failed + batch.failed,
        deferred: total.deferred + batch.deferred,
      };
      if (batch.dispatched === 0 || this.#bus.stopping) {
        return total;
      }
    }
  }

  /** One batch: read the queue head per stream, dispatch each in position order. */
  async sweepOnce(): Promise<SweepReport> {
    const pending = await this.#store.readPendingDispatch({ limit: this.#batchSize });
    if (pending.length === 0) {
      return EMPTY_SWEEP;
    }

    let dispatched = 0;
    let failed = 0;
    let deferred = 0;
    for (const event of pending) {
      if (this.#bus.stopping) {
        break;
      }
      const result = await this.#bus.dispatch(event);
      const status: DispatchStatus = result.status;
      if (status === 'dispatched' || status === 'completed') {
        dispatched += 1;
      } else if (status === 'failed') {
        failed += 1;
      } else {
        deferred += 1;
      }
    }
    return { scanned: pending.length, dispatched, failed, deferred };
  }

  async #run(): Promise<void> {
    while (this.#running) {
      await this.#drainGuarded();
      if (!this.#running) {
        return;
      }
      await this.#waitForWork({ withTimer: true });
    }
  }

  /**
   * With an external scheduler the loop reacts to wake-up hints and **nothing else**.
   *
   * Arming the poll timer here too would leave two recurring drains — the worker's and the
   * scheduler's — which is precisely what handing the timer over is meant to avoid. `stop()` calls
   * `#onWake`, so the loop still exits promptly.
   */
  async #runWoken(): Promise<void> {
    while (this.#running) {
      await this.#waitForWork({ withTimer: false });
      if (!this.#running) {
        return;
      }
      await this.#drainGuarded();
    }
  }

  async #drainGuarded(): Promise<void> {
    try {
      const report = await this.drain();
      if (report.dispatched > 0 || report.failed > 0) {
        this.#logger.debug({ ...report }, 'outbox sweep');
      }
    } catch (error) {
      // A sweep that throws is a transport fault, not a handler fault — a pool that ran out, a
      // connection reset. Log it and keep the loop alive: the queue rows are still there, so the
      // next pass retries them and nothing is lost.
      this.#logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'outbox sweep failed',
      );
    }
  }

  /**
   * Resolves on a wake-up hint, and — when this worker owns the timer — after the poll interval.
   *
   * `withTimer: false` is the scheduler case: no timer is armed at all, so the worker really has
   * handed its poll over instead of keeping a second one.
   */
  async #waitForWork(options: { withTimer: boolean }): Promise<void> {
    if (this.#pendingWake) {
      this.#pendingWake = false;
      return;
    }
    await new Promise<void>((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        this.#wake = undefined;
        if (this.#timer !== undefined) {
          clearTimeout(this.#timer);
          this.#timer = undefined;
        }
        resolve();
      };
      this.#wake = finish;
      if (!options.withTimer) {
        return;
      }
      this.#timer = setTimeout(finish, this.#pollIntervalMs);
      // `unref` keeps a poll interval from holding the process open at shutdown; it does not
      // exist in every runtime this code may be bundled for, hence the guard.
      this.#timer.unref?.();
    });
  }

  #onWake(): void {
    if (this.#wake === undefined) {
      this.#pendingWake = true;
      return;
    }
    this.#wake();
  }
}
