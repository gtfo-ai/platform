/**
 * **A task's duty lease** — two performers of one group of outbound duties take turns (WP-184,
 * migration 0091, `TaskDutyLeaseRepository`).
 *
 * ## Why the idempotency key is not enough
 *
 * `IntegrationActionExecutor` looks a key up **before** its call and records it **after**
 * (`action-executor.ts`, steps 2 and 5): nothing is claimed in between. So two performers of the
 * same key that overlap both miss, both call the provider and both post — read off the executor at
 * WP-184 and measured in `owed-duties.test.ts` (the concurrent case with the lease disarmed posts
 * every finding twice). One after the other is what the key handles: the second finds the record
 * and replays without a call.
 *
 * The overlap is real since WP-184: the `stage.execute` job performs the review conversation's owed
 * duties before it plans the next agent stage (`owed-duties.ts`), and the `pipeline.outbound` duty
 * the completion enqueued still fires — the two queues have nothing ordering them, which is the
 * defect WP-184 fixes. This module makes them take turns.
 *
 * ## The shape
 *
 * {@link withTaskDutyLease} claims the lease in a transaction of its own, runs the work **outside**
 * every transaction (the work calls providers, WP-15d), renews the lease while it runs and releases
 * it at the end, success or failure. A claimant that finds the lease held waits, polling, up to
 * `waitMs`, and then throws {@link TaskDutyLeaseBusyError} — each caller decides what that means: the
 * stage job plans without the posts (a `warn`), the outbound duty throws and pg-boss's retry is the
 * next turn. A holder whose process died stops renewing, and its lease is taken over once it
 * expires ({@link TASK_DUTY_LEASE_TTL_MS}).
 *
 * **What it cannot promise**: a holder that is alive but has not renewed for a whole lease length
 * (a renewal lost to a database outage while a provider call hangs) can be overlapped. The residual
 * is the old behaviour — a duplicate post — and never a lost one.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { type HeartbeatSchedule, intervalHeartbeatSchedule } from './lease.js';
import type { PipelineStore } from './store.js';

/** The review conversation's duties and the ticket lifecycle's moves — one group, one lease. */
export const REVIEW_CONVERSATION_LEASE = 'review_conversation';

/** How long a claim holds without a renewal: a dead holder is out of the way after this. */
export const TASK_DUTY_LEASE_TTL_MS = 2 * 60_000;

/** A quarter of the lease, so three renewals in a row may be lost before it lapses. */
export const TASK_DUTY_LEASE_RENEW_MS = TASK_DUTY_LEASE_TTL_MS / 4;

/**
 * How long a claimant waits for the holder before it gives up on this turn. The holder is doing at
 * most one review's posts (one call per finding and a summary), which on a provider that answers
 * takes seconds; past this, the provider is slow enough that the holder's own bound is the story.
 */
export const TASK_DUTY_LEASE_WAIT_MS = 30_000;

/**
 * How long an **outbound** duty waits for the lease before it gives up on this turn (WP-184 review
 * round 1). The `pipeline.outbound` worker runs one job at a time for every project, so a duty
 * that waits stalls all of them: it waits briefly and then throws {@link TaskDutyLeaseBusyError}
 * into the job's retry (`PIPELINE_OUTBOUND_RETRY`, 30 s then 60 s), whose next turn finds the
 * holder done and replays its keys. The stage job keeps {@link TASK_DUTY_LEASE_WAIT_MS}: it holds
 * only its own task's stage, and waiting is how its prompt gets the threads.
 */
export const OUTBOUND_DUTY_LEASE_WAIT_MS = 2_000;

/** How often a waiting claimant asks again. */
export const TASK_DUTY_LEASE_POLL_MS = 200;

/** The lease was held by another performer for the whole wait. */
export class TaskDutyLeaseBusyError extends Error {
  override readonly name = 'TaskDutyLeaseBusyError';
  readonly taskId: Id;
  readonly lease: string;

  constructor(taskId: Id, lease: string, waitedMs: number) {
    super(
      `the ${lease} lease of task ${taskId} was held by another performer for ${String(waitedMs)} ms`,
    );
    this.taskId = taskId;
    this.lease = lease;
  }
}

export interface TaskDutyLeaseOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: Pick<PipelineStore, 'dutyLeases'>;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  readonly logger?: Logger;
  /** Test seams; production takes the defaults. */
  readonly dutyLease?: {
    readonly ttlMs?: number;
    readonly renewEveryMs?: number;
    readonly pollMs?: number;
    readonly schedule?: HeartbeatSchedule;
    /** Disarms the lease — the canary of the concurrent case, never a production setting. */
    readonly disarmed?: boolean;
  };
}

const later = (now: string, ms: number): IsoDateTime =>
  new Date(Date.parse(now) + ms).toISOString() as IsoDateTime;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `work` while holding the task's `lease` — see the module docblock. Throws
 * {@link TaskDutyLeaseBusyError} when the lease stayed held for `waitMs`; anything `work` throws
 * comes out unchanged, after the release.
 */
export const withTaskDutyLease = async <T>(
  options: TaskDutyLeaseOptions,
  input: { readonly taskId: Id; readonly lease: string; readonly waitMs: number },
  work: () => Promise<T>,
): Promise<T> => {
  if (options.dutyLease?.disarmed === true) {
    return work();
  }
  const logger = options.logger ?? silentLogger;
  const ttlMs = options.dutyLease?.ttlMs ?? TASK_DUTY_LEASE_TTL_MS;
  const pollMs = options.dutyLease?.pollMs ?? TASK_DUTY_LEASE_POLL_MS;
  const holder = `duty:${options.ids.next()}`;
  const claim = () =>
    options.unitOfWork.transaction(async (scope) => {
      const now = options.clock.now();
      return options.store.dutyLeases.claim(scope.tx, {
        taskId: input.taskId,
        lease: input.lease,
        holder,
        now: now as IsoDateTime,
        expiresAt: later(now, ttlMs),
      });
    });

  const started = Date.now();
  while (!(await claim())) {
    const waited = Date.now() - started;
    if (waited >= input.waitMs) {
      throw new TaskDutyLeaseBusyError(input.taskId, input.lease, waited);
    }
    await pause(Math.min(pollMs, Math.max(1, input.waitMs - waited)));
  }

  /**
   * **The renewal, and why the release waits for it** (WP-184 review round 1, `lease.ts`'s
   * `startRunHeartbeat` shape). A renewal is a transaction of its own; one still in flight when the
   * work ends could otherwise land after the release's `delete` and leave a finished holder's row
   * with a fresh expiry — the next performer would then wait out its whole wait for nobody. So:
   * one renewal at a time, none started once the work has ended, the release awaits the one in
   * flight, and a renewal is `renew` — an `update` of the holder's own live row that never inserts —
   * so even a renewal that somehow outlived the release would find nothing to bring back.
   */
  const renew = () =>
    options.unitOfWork.transaction(async (scope) => {
      const now = options.clock.now();
      return options.store.dutyLeases.renew(scope.tx, {
        taskId: input.taskId,
        lease: input.lease,
        holder,
        now: now as IsoDateTime,
        expiresAt: later(now, ttlMs),
      });
    });
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  const schedule = options.dutyLease?.schedule ?? intervalHeartbeatSchedule;
  const stopRenewing = schedule(options.dutyLease?.renewEveryMs ?? TASK_DUTY_LEASE_RENEW_MS, () => {
    if (stopped || inFlight !== null) {
      return;
    }
    inFlight = renew()
      .then(
        (held) => {
          if (!held && !stopped) {
            logger.warn(
              { task_id: input.taskId, lease: input.lease },
              'a duty lease was taken over while its holder still worked; the next performer may repeat a call',
            );
          }
        },
        (error: unknown) => {
          logger.warn(
            { task_id: input.taskId, lease: input.lease, err: error },
            'a duty lease could not be renewed; it lapses at its expiry if no renewal lands',
          );
        },
      )
      .finally(() => {
        inFlight = null;
      });
  });
  try {
    return await work();
  } finally {
    stopped = true;
    stopRenewing();
    // The renewal in flight lands before the release, never after it (see above).
    await inFlight;
    await options.unitOfWork
      .transaction(async (scope) =>
        options.store.dutyLeases.release(scope.tx, {
          taskId: input.taskId,
          lease: input.lease,
          holder,
        }),
      )
      .catch((error: unknown) => {
        // A release that failed leaves the row to expire: the next performer waits one lease length
        // at most, and the work itself is done.
        logger.warn(
          { task_id: input.taskId, lease: input.lease, err: error },
          'a duty lease could not be released; it expires on its own',
        );
      });
  }
};
