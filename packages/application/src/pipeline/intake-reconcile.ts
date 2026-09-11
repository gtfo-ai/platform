/**
 * Re-emitting a `ticket.matched` whose task was never created — PROGRESS backlog entry **20**, the
 * criterion WP-15d put on WP-15c's row.
 *
 * ## The loss, exactly
 *
 * Since WP-15d the intake handler **writes nothing**: `pipeline.intake` checks the 1:1 dedup and
 * enqueues a `pipeline.outbound` job with `duty: 'intake_check'` through `context.afterCommit`
 * (`saga.ts`), and the task row is created by that job. `afterCommit` is **at-most-once** (TD-004),
 * so a process that dies between the handler's commit and the enqueue leaves a matched ticket with
 * no task row — and nothing re-emits it, nothing retries it and nothing logs it: `EventBus` logs
 * only the case where the callback *threw*.
 *
 * ## Why the recovery is task-shaped and not delivery-shaped
 *
 * Two mechanisms are already in the tree and neither one covers this, which is why the answer had
 * to be a third:
 *
 *  - **Re-dispatching the same event is skipped by design.** `handlerExecutions.claim` and
 *    `complete` commit **in the handler's own transaction**, so the record that `pipeline.intake`
 *    ran commits together with the decision, and a second dispatch of that event position returns
 *    `skipped`. WP-19's backfill tool replays *positions*; it cannot help here.
 *  - **A webhook redelivery is deduplicated** on `inbox(provider, delivery_id)` — WP-15c's own
 *    acceptance criterion — so the provider sending it again performs nothing again.
 *
 * The two criteria coexist because **they name different units**: dedup is a statement about a
 * *delivery*, recovery is a statement about a *task*. So this finds matched tickets with no task
 * row and appends a **new** `ticket.matched`, leaving the inbox untouched. It is safe to run blind
 * because intake is idempotent on `tasks_project_id_ticket_key_mode` (`saga.ts`'s `findByTicket`).
 *
 * ## Bounded on purpose: once per ticket
 *
 * A ticket whose intake job fails *permanently* — a git binding an operator deleted, say — would
 * otherwise be re-emitted every interval for ever, and an append-only event log would grow with it.
 * So a ticket that already carries a re-emission from this component is skipped, and the residual
 * is stated rather than implied: recovering a ticket needs **one** crash in the microsecond window
 * between a commit and an enqueue, and a ticket that is not recovered needs **two**. The count is
 * the reason the re-emitted event carries a system actor naming this component — it is the mark the
 * next pass reads.
 *
 * ## The grace period is the interval, and that is one knob rather than two
 *
 * A `ticket.matched` appended a millisecond ago has a job in flight; re-emitting it would race the
 * intake it is waiting for and cost a doomed second `intake_check`. So only matches older than the
 * reconciliation interval are considered: *a ticket that has had a full interval to produce a task
 * row and has not.*
 */
import type { Actor, DomainEvent, Id, IsoDateTime } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import type { EventStore } from '../ports/event-store.js';
import type { JobHandler, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** `Actor.component` on a re-emitted `ticket.matched`, and the mark the next pass reads. */
export const INTAKE_RECONCILER_COMPONENT = 'pipeline.intake.reconcile';

export const INTAKE_RECONCILER_ACTOR: Actor = {
  kind: 'system',
  component: INTAKE_RECONCILER_COMPONENT,
};

/** One matched ticket the platform owes a task for. */
export interface UnstartedMatch {
  /** The `ticket.matched` event that was lost, for `cause_event_id` and for the log line. */
  readonly eventId: Id;
  readonly projectId: Id;
  /** Its payload, verbatim — re-emitted unchanged, because it is what intake reads. */
  readonly payload: Record<string, unknown>;
}

/**
 * The query, as a port: `events` joined against `tasks`, which no existing store method expresses.
 *
 * It is a *read* of the event log rather than of a projection, and that is deliberate — the log is
 * the only place a matched ticket with no task row exists at all.
 */
export interface IntakeReconciliationStore {
  /**
   * Matched tickets older than `olderThan` with no `mode: 'normal'` task row, excluding any this
   * component has already re-emitted.
   *
   * @param limit bounds one pass, so a backlog cannot turn into one enormous transaction.
   */
  findUnstartedMatches(input: {
    readonly olderThan: IsoDateTime;
    readonly limit: number;
    readonly reconcilerComponent: string;
  }): Promise<readonly UnstartedMatch[]>;
}

export interface IntakeReconciliationOptions {
  readonly store: IntakeReconciliationStore;
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  /** A match younger than this is still waiting for its own intake job. */
  readonly graceMs: number;
  /** How many tickets one pass may re-emit. @default 50 */
  readonly limit?: number;
  readonly logger?: Logger;
}

export const DEFAULT_INTAKE_RECONCILE_LIMIT = 50;

export interface IntakeReconciliationReport {
  readonly found: number;
  readonly reEmitted: number;
}

/**
 * One pass. Each ticket is re-emitted in a transaction of its own, so one ticket whose stream lost
 * a sequence race does not roll back the others.
 */
export const runIntakeReconciliation = async (
  options: IntakeReconciliationOptions,
): Promise<IntakeReconciliationReport> => {
  const logger = options.logger ?? silentLogger;
  const now = Date.parse(options.clock.now());
  const olderThan = new Date(now - Math.max(0, options.graceMs)).toISOString() as IsoDateTime;

  const matches = await options.store.findUnstartedMatches({
    olderThan,
    limit: options.limit ?? DEFAULT_INTAKE_RECONCILE_LIMIT,
    reconcilerComponent: INTAKE_RECONCILER_COMPONENT,
  });

  let reEmitted = 0;
  for (const match of matches) {
    const streamSeq = await options.eventStore.nextStreamSequence('project', match.projectId);
    const event = domainEventSchemasByType['ticket.matched'].parse({
      id: options.ids.next(),
      stream_type: 'project',
      stream_id: match.projectId,
      stream_seq: streamSeq,
      // The lost event is what caused this one, which is what makes the pair readable in the log.
      cause_event_id: match.eventId,
      correlation_id: null,
      actor: INTAKE_RECONCILER_ACTOR,
      occurred_at: options.clock.now(),
      type: 'ticket.matched',
      payload: match.payload,
    }) as DomainEvent;

    await options.unitOfWork.transaction(async (scope) => {
      await scope.events.append([event]);
    });
    reEmitted += 1;
    logger.warn(
      {
        project_id: match.projectId,
        lost_event_id: match.eventId,
        event_id: event.id,
      },
      'a matched ticket had no task row, so its ticket.matched was re-emitted (PROGRESS backlog 20)',
    );
  }

  return { found: matches.length, reEmitted };
};

// ── The timer that drives it ─────────────────────────────────────────────────

/**
 * `stately`, so the pass that is running may enqueue the next one.
 *
 * `exclusive` would be the obvious choice and is the wrong one: it admits one job per key in any
 * non-terminal state, and the running pass **is** non-terminal, so its own re-enqueue would be
 * dropped and the chain would die after one tick. `stately` admits one queued *and* one active,
 * which is exactly "one pass running, one waiting" — and it also collapses the boot enqueue of N
 * replicas onto the single pending job.
 */
export const declareIntakeReconcileQueue = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue({
    name: JOB_QUEUES.intakeReconcile,
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
  });
};

/** The singleton key the whole deployment shares: there is one backlog, not one per process. */
export const INTAKE_RECONCILE_KEY = 'intake-reconcile';

export const enqueueIntakeReconcile = async (
  jobs: Jobs,
  options: { readonly startAfter?: Date } = {},
): Promise<void> => {
  await jobs.enqueue({
    queue: JOB_QUEUES.intakeReconcile,
    singletonKey: INTAKE_RECONCILE_KEY,
    ...(options.startAfter === undefined ? {} : { startAfter: options.startAfter }),
  });
};

export interface IntakeReconcileJobOptions
  extends Omit<IntakeReconciliationOptions, 'graceMs' | 'limit'> {
  readonly jobs: Jobs;
  /**
   * How long until the next pass **and** the grace period a match must be older than.
   *
   * One knob rather than two, and the sentence that makes it one: *a ticket that has had a full
   * reconciliation interval to produce a task row and has not*. A match younger than that still has
   * its own `intake_check` job in flight, and re-emitting it would race the intake it is waiting
   * for.
   */
  readonly intervalMs: number;
  /** Tickets one pass may re-emit. */
  readonly limit?: number;
}

/**
 * One pass, then the next wake-up.
 *
 * The re-enqueue is in a `finally`, deliberately: a pass that threw is a pass whose *next* pass
 * must still happen, and pg-boss's own retry of this job would restore the chain only while the
 * retry limit lasts. The enqueue is the last statement either way, so a crash before it leaves the
 * chain to be re-established by the next process start — which is why the composition root enqueues
 * one at boot rather than relying on the chain alone.
 */
export const intakeReconcileHandler = (options: IntakeReconcileJobOptions): JobHandler => {
  const logger = options.logger ?? silentLogger;
  return async () => {
    try {
      const report = await runIntakeReconciliation({
        ...options,
        graceMs: options.intervalMs,
        ...(options.limit === undefined ? {} : { limit: options.limit }),
      });
      if (report.reEmitted > 0) {
        logger.info(
          { found: report.found, re_emitted: report.reEmitted },
          'intake reconciliation re-emitted matched tickets that had no task row',
        );
      }
    } finally {
      await enqueueIntakeReconcile(options.jobs, {
        startAfter: new Date(Date.parse(options.clock.now()) + options.intervalMs),
      });
    }
  };
};

/**
 * Declare the queue, start the worker, and put the first pass on it.
 *
 * Composed by the **composition root** rather than by `createPipelineRuntime`, beside
 * `registerPartitionMaintenance` which is the same shape: a maintenance schedule the process owns,
 * not a step of the ticket's journey. The consequence for the pool arithmetic is counted in
 * `apps/server/src/config.ts` (`POOL_RESERVATIONS.pipeline`), which is where every other worker of
 * this process is counted too.
 *
 * `intervalMs <= 0` starts nothing and returns `null`, which is how `APP_INTAKE_RECONCILE_INTERVAL_MS=0`
 * switches the recovery off — for an operator who would rather see a stuck ticket than an
 * automatic re-emission. The composition root logs which of the two it did.
 */
export const startIntakeReconciliation = async (
  options: IntakeReconcileJobOptions,
): Promise<JobWorker | null> => {
  if (options.intervalMs <= 0) {
    return null;
  }
  await declareIntakeReconcileQueue(options.jobs);
  const worker = await options.jobs.work({
    queue: JOB_QUEUES.intakeReconcile,
    handler: intakeReconcileHandler(options),
    concurrency: 1,
  });
  // The chain is re-established on every process start, which is what makes it survive a crash
  // between a pass and its own re-enqueue. `stately` plus the singleton key collapses this and
  // every replica's boot enqueue onto the one pending job.
  await enqueueIntakeReconcile(options.jobs);
  return worker;
};
