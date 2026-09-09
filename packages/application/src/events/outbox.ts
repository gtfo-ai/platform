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
 * ## The timer belongs to this process, and is always armed
 *
 * `event_dispatch` plus this sweep are the single queue of record; there is no `dispatch(event)`
 * pg-boss job (TD-004, amended at WP-04a). Two queues would disagree after a crash, and pg-boss has
 * no per-stream serialisation, so ordering would fall back on `hasEarlierPending` refusing and
 * rescheduling — a retry storm where head-of-line blocking belongs.
 *
 * Nor is the sweep cluster work an external scheduler could own. Every process LISTENs on its
 * **own** connection, so a missed `NOTIFY` is a *local* loss, and a cluster-singleton job cannot be
 * the fallback for a subscription it does not share — quite apart from pg-boss being unable to
 * express ~1s repetition at all (5-field cron, 1-minute floor). So each worker arms its own
 * `pollIntervalMs` timer unconditionally and the subscription only shortens the wait. N replicas
 * polling one queue is cheap: the claim uses `FOR UPDATE SKIP LOCKED`, so concurrent sweeps never
 * block, and `drain()` returns as soon as a batch dispatches nothing.
 */
import { type Broadcast, EVENTS_APPENDED_TOPIC } from '../ports/broadcast.js';
import type { EventStore } from '../ports/event-store.js';
import { type Logger, silentLogger } from '../ports/logger.js';
import type { DispatchStatus, EventBus, StopOptions, StopReport } from './event-bus.js';

/**
 * The canonical name of the sweep: a **log and metric label, not a queue name**.
 *
 * Nothing enqueues it and nothing may — the sweep is a timer inside each process (see the module
 * comment). The constant exists so every log line and metric about the sweep spells it the same
 * way, and so the name has one home rather than being retyped per call site. It is exported from
 * the package index for that single home only: re-exporting it as a queue name, or handing it to
 * `Jobs`, is the mistake this whole comment exists to prevent.
 */
export const OUTBOX_SWEEP_LABEL = 'events.outbox.sweep' as const;

export interface OutboxWorkerOptions {
  readonly bus: EventBus;
  readonly store: EventStore;
  /** Wake-up transport. Without it the worker is a pure poller, which is still correct. */
  readonly broadcast?: Broadcast;
  readonly logger?: Logger;
  /** Events per sweep batch. */
  readonly batchSize?: number;
  /**
   * Longest a fully idle worker waits before sweeping again. Always armed: this timer is the
   * fallback for *this* process's own wake-up subscription, so nothing outside the process can
   * stand in for it.
   */
  readonly pollIntervalMs?: number;
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

export class OutboxWorker {
  readonly #bus: EventBus;
  readonly #store: EventStore;
  readonly #broadcast: Broadcast | undefined;
  readonly #logger: Logger;
  readonly #batchSize: number;
  readonly #pollIntervalMs: number;

  #running = false;
  #loop: Promise<void> | undefined;
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
    } catch (error) {
      // A subscription that failed would leave the worker half-started — `running` true with no
      // loop behind it — so the caller would be told a worker that never sweeps had started. Undo
      // the flag and let the caller decide. `subscribe` threw, so there is no handle to close.
      this.#running = false;
      throw error;
    }
    this.#loop = this.#run();
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
      await this.#waitForWork();
    }
  }

  async #drainGuarded(): Promise<void> {
    try {
      const report = await this.drain();
      if (report.dispatched > 0 || report.failed > 0) {
        this.#logger.debug({ sweep: OUTBOX_SWEEP_LABEL, ...report }, 'outbox sweep');
      }
    } catch (error) {
      // A sweep that throws is a transport fault, not a handler fault — a pool that ran out, a
      // connection reset. Log it and keep the loop alive: the queue rows are still there, so the
      // next pass retries them and nothing is lost.
      this.#logger.error(
        {
          sweep: OUTBOX_SWEEP_LABEL,
          error: error instanceof Error ? error.message : String(error),
        },
        'outbox sweep failed',
      );
    }
  }

  /**
   * Resolves on a wake-up hint, or after the poll interval — whichever comes first.
   *
   * The timer is armed on every pass, with or without a broadcast: it is what makes a missed
   * `NOTIFY` cost latency rather than an event.
   */
  async #waitForWork(): Promise<void> {
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
