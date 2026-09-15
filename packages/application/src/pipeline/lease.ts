/**
 * The run lease, from the side that **holds** it — `runs.lease_owner` / `lease_expires_at`
 * (TD-003, WP-47; PROGRESS backlog **109**).
 *
 * Both columns have existed since migration 0004 and had no reader and no writer until WP-47: a
 * grep over `packages/`, `apps/` and `test/` answered three sites, all of them declarations or
 * prose. This module is the writer; `../recovery/run-lease.ts` is the reader.
 *
 * ## Who owns a lease, and what a missing heartbeat means
 *
 * The **process executing the run** owns it. It claims the lease in the transaction that creates
 * the `runs` row and renews it on a timer for as long as the session is in flight, so that
 * *"nothing is renewing this lease"* becomes a question a query can ask.
 *
 * The answer to that question is deliberately narrow, and it is the whole of what this mechanism
 * licenses anybody to conclude: **no process is renewing the lease**. Not that the model stopped —
 * a session in a process that lost its database connection is still running and still spending.
 * Not that the work was wasted. What the sweep does with that is `../recovery/run-lease.ts`'s
 * business, and it ends the row rather than the session, because ending the row is the only thing
 * it actually knows how to be right about.
 *
 * ## Why a heartbeat rather than the wall clock alone
 *
 * The wall clock is the cheaper signal — `started_at + spec.limits.wallClockMs + grace`, no writes
 * at all — and it is kept, as the **backstop** for rows written before this column had a writer
 * (`../recovery/run-lease.ts`). It cannot be the primary one: the default wall clock is an hour, so
 * a process that dies a minute into a run would hold its stage's reservation against every future
 * window for the next hour and a bit. The heartbeat costs one narrow `update` per run per
 * {@link RUN_LEASE_RENEW_MS} and turns that hour into about six minutes.
 *
 * ## The two numbers, and what being wrong in each direction costs
 *
 * {@link RUN_LEASE_TTL_MS} is **five minutes**, the same figure as technical/02's stall timeout,
 * and for a related reason: a process whose event loop has not run a timer in five minutes is not
 * driving a run either. Renewing at a third of that ({@link RUN_LEASE_RENEW_MS}) means two
 * consecutive beats can be lost — to a slow query, a pool that is momentarily empty, a garbage
 * collection — before the lease lapses.
 *
 * Being **early** (a lease that lapses while its process is alive) ends a run that was working and
 * escalates its task: one human, one wasted run. Being **late** (a lease that outlives its holder)
 * holds one stage's reservation for a few more minutes. The sweep adds its own grace on top — a
 * whole pass interval — so the practical floor is the TTL plus that, and the error is biased
 * towards late, which is the direction that costs money rather than work.
 *
 * ## What a failed beat does, and does not, do
 *
 * Nothing. A beat that throws is logged and the next one is attempted; a beat that writes no row
 * stops the heartbeat, because the run has ended or another process has taken the lease over and
 * renewing either would be asserting a claim this process does not hold. **A lost lease never
 * interrupts the run** — the session keeps going and its own `finish` arbitrates when it ends, which
 * is exactly the race `RunRepository.finish` was made conditional for.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineStore } from './store.js';

/** How long a lease is granted for; see the module docblock for both directions of being wrong. */
export const RUN_LEASE_TTL_MS = 5 * 60_000;

/** A third of the TTL: two consecutive beats may be lost before the lease lapses. */
export const RUN_LEASE_RENEW_MS = RUN_LEASE_TTL_MS / 3;

/**
 * Starts a repeating callback and answers how to stop it.
 *
 * Injectable so a test can drive the beat instead of waiting for it; the default is
 * {@link intervalHeartbeatSchedule}, which is `setInterval` with the timer `unref`'d so a pending
 * beat cannot keep a process alive that is otherwise finished.
 */
export type HeartbeatSchedule = (everyMs: number, beat: () => void) => () => void;

export const intervalHeartbeatSchedule: HeartbeatSchedule = (everyMs, beat) => {
  const timer = setInterval(beat, everyMs);
  // `unref` exists on Node's timer and not in a DOM lib; a scheduler that lacks it loses nothing
  // but the courtesy.
  (timer as { unref?: () => void }).unref?.();
  return () => {
    clearInterval(timer);
  };
};

export interface RunLeaseOptions {
  /**
   * Who holds the lease — a **per-process** identity, not a per-run one.
   *
   * It is what `renewLease` matches on, so two processes cannot renew one lease, and it is what an
   * operator reads off the row when they ask which instance was driving a run that died. A
   * composition root builds it once (hostname plus a random suffix is enough: it has to be unique
   * among live processes, not stable across restarts — a restarted process must **not** inherit
   * the lease its predecessor held).
   */
  readonly owner: string;
  /** @default RUN_LEASE_TTL_MS */
  readonly ttlMs?: number;
  /** @default RUN_LEASE_RENEW_MS */
  readonly renewEveryMs?: number;
  /** @default intervalHeartbeatSchedule */
  readonly schedule?: HeartbeatSchedule;
}

/**
 * Stops the heartbeat and **resolves when the beat in flight has finished**.
 *
 * The awaited half is what lets the stage executor claim that no beat's connection borrow overlaps
 * its own transaction 2: a beat is fired and forgotten by design (it must never block the run), so
 * clearing the timer alone leaves at most one `update` in flight. The overlap is harmless in itself
 * — `renewLease` refuses a terminal row — but it is one unaccounted pooled connection per ending,
 * and `POOL_RESERVATIONS` is arithmetic somebody has to be able to do.
 *
 * Idempotent: calling it twice is not an error, and the second call resolves immediately.
 */
export type StopHeartbeat = () => Promise<void>;

export interface RunHeartbeatDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly clock: { now(): IsoDateTime };
  readonly lease: RunLeaseOptions;
  readonly logger?: Logger;
}

/** The instant a lease claimed now would expire. */
export const leaseExpiryAt = (now: IsoDateTime, ttlMs: number): IsoDateTime =>
  new Date(Date.parse(now) + ttlMs).toISOString() as IsoDateTime;

/**
 * Renews one run's lease, in a transaction of its own.
 *
 * Its own transaction deliberately: this runs *between* the executor's two transactions, while the
 * run is in flight and no connection is held, so it borrows one for a single narrow `update` and
 * gives it back. Holding a connection for the length of a run is the defect the executor's whole
 * shape exists to avoid.
 *
 * Answers `false` when the row refused the write — the run has ended, or another process owns the
 * lease. The caller stops beating; it never stops the run.
 */
export const renewRunLease = async (
  deps: RunHeartbeatDependencies,
  runId: Id,
): Promise<boolean> => {
  const ttlMs = deps.lease.ttlMs ?? RUN_LEASE_TTL_MS;
  return deps.unitOfWork.transaction(async (scope) =>
    deps.store.runs.renewLease(scope.tx, {
      runId,
      owner: deps.lease.owner,
      expiresAt: leaseExpiryAt(deps.clock.now(), ttlMs),
    }),
  );
};

/**
 * Beats until the run ends, the lease is lost, or the caller stops it.
 *
 * A beat that **throws** is logged and swallowed: a database hiccup must not fail the run that is
 * executing beside it, and the next beat will either succeed or the lease will lapse and the sweep
 * will do the honest thing. A beat that returns `false` stops the heartbeat and says so once.
 */
export const startRunHeartbeat = (deps: RunHeartbeatDependencies, runId: Id): StopHeartbeat => {
  const logger = deps.logger ?? silentLogger;
  const everyMs = deps.lease.renewEveryMs ?? RUN_LEASE_RENEW_MS;
  const schedule = deps.lease.schedule ?? intervalHeartbeatSchedule;
  let stopped = false;
  /** The beat currently borrowing a connection, or `null`; what {@link StopHeartbeat} awaits. */
  let inFlight: Promise<void> | null = null;
  /**
   * Assigned **after** `schedule` returns, and therefore read through a nullable binding.
   *
   * A `const cancel = schedule(…, () => { … cancel() … })` reads `cancel` from inside the callback
   * it is being assigned from, which is a temporal dead zone for any scheduler that beats
   * **synchronously** — a `ReferenceError` thrown out of the scheduler rather than a heartbeat.
   * Nothing in the tree schedules that way today; the shape is what makes it a hazard, so it is the
   * shape that is fixed rather than a comment saying the shipped scheduler is safe.
   */
  let cancel: (() => void) | undefined;

  const halt = (): void => {
    stopped = true;
    cancel?.();
  };

  cancel = schedule(everyMs, () => {
    // One beat at a time: a beat that is slower than the interval must not queue a second
    // connection borrow behind itself, which is how a stalled pool turns into a stalled process.
    if (stopped || inFlight !== null) {
      return;
    }
    inFlight = renewRunLease(deps, runId)
      .then((renewed) => {
        if (renewed || stopped) {
          return;
        }
        halt();
        logger.info(
          { run_id: runId, lease_owner: deps.lease.owner },
          'the run lease was not renewed: the run has ended or another process owns it, so the heartbeat stopped',
        );
      })
      .catch((error: unknown) => {
        logger.warn(
          { err: error, run_id: runId, lease_owner: deps.lease.owner },
          'a run lease heartbeat failed; the run continues and the next beat will try again',
        );
      })
      .finally(() => {
        inFlight = null;
      });
  });

  return async () => {
    halt();
    // Unbounded on purpose, and stated: a beat whose `update` never returns holds the stop until
    // the statement does. The pool's `connectionTimeoutMillis` bounds the borrow, not the
    // statement, and nothing on this stack sets `statement_timeout` (`createDatabasePool` sets the
    // connection timeout and the role only), so **the bound is absent by default** — only an
    // operator-set `statement_timeout` or the socket dying ends such a beat. The alternative —
    // abandoning the beat — is the concurrent borrow the executor's docblock rules out, which
    // costs more than a stop that waits.
    await inFlight;
  };
};
