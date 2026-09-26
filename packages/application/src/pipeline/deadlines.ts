/**
 * Three deadlines, one mechanism (WP-56) — PROGRESS backlog **74**, **76** and **69**.
 *
 * | deadline | set by | measured from | expires into |
 * |---|---|---|---|
 * | a blocking question nobody answered | BD-006 (`pipeline.limits.question_timeout`, default `1 working day`) | `questions.asked_at` | `task.question.expired` → the saga escalates |
 * | a plan or budget approval nobody decided | BD-006's Q95 amendment: the same limit and calendar | `approvals.requested_at` | `task.approval.decided` (`expired`) → the saga escalates |
 * | a take-over nobody touched | product/19 §19: `5 working days` | the `task.taken_over` event | `task.escalated`, from here |
 *
 * Until this module every piece of the first two existed except the one that starts them: no site
 * wrote a deadline, nothing armed a timer, `expireTaskQuestion` had only test callers and
 * `expireTaskApproval` had none. The third was not built at all.
 *
 * ## The shape — decide in the transaction, arm after it, re-validate on fire
 *
 * 1. **The deadline is written where the aggregate is created.** A question and an approval carry
 *    `deadline_at`, computed by {@link questionDeadlineRule} from the instant the row stores, in
 *    the transaction that inserts the row — so the row and the event that announces it
 *    (`task.question.asked` carries the whole record) agree on it. A take-over has no row; its
 *    deadline is a function of the `task.taken_over` event's own instant and is recomputed from
 *    it, never stored.
 * 2. **The timer is armed by a handler, after commit** ({@link deadlineArmingHandler}):
 *    `Jobs.enqueue` does not join a transaction (TD-004's amendment), so a handler enqueues through
 *    `HandlerContext.afterCommit`, and a rolled-back dispatch arms nothing.
 * 3. **The job re-validates on fire** ({@link deadlineSweepHandler}), because a timer cannot be
 *    cancelled: it asks the aggregate whether it is *still* waiting and whether the deadline has
 *    passed on this process's clock. An answered question, a decided approval and a handed-back
 *    task are the normal case and do nothing; that is what "cancelled by hand-back" means here.
 *
 * ## One queue, and what it costs
 *
 * `deadline.sweep` (`JOB_QUEUES.deadlineSweep`) carries `(aggregate, id, kind)`. One worker, one
 * pooled connection — `POOL_RESERVATIONS.pipeline` counts it — rather than one per timer, which is
 * the architect's ruling and TD-004's amendment. The residual is stated where it lives: a wake-up
 * lost between the commit and the enqueue leaves an aggregate waiting past its deadline with no
 * timer, the lost-wake-up class `recovery/stranded.ts` exists for — and since WP-56 round 2 it is
 * a row of that table (`recovery/deadline.ts`), which expires such a row through
 * {@link settleDeadline}, the job's own path, and gives a row written before WP-56 its first
 * deadline.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { idSchema } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { escalateTask, isBefore } from '@platform/domain';
import * as z from 'zod';
import type { EventHandler } from '../events/handler.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { JobHandler, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { WorkingCalendar } from '../scheduling/working-calendar.js';
import {
  type DeadlineOutcome,
  expireTaskApproval,
  expireTaskQuestion,
  type TaskCommandDependencies,
} from './commands.js';
import { TAKE_OVER_INACTIVITY_TIMEOUT, takeOverDeadline } from './deadline-rules.js';
import type { PipelineStore } from './store.js';
import { PIPELINE_ACTOR } from './store.js';
import {
  escalateTaskAfterConflict,
  retryOnTaskConflict,
  TaskConflictExhaustedError,
} from './task-conflict.js';

/**
 * The floor under a re-arm, in milliseconds.
 *
 * A timer that fires before its deadline (the queue's clock is the database's, the deadline is this
 * process's) is re-armed at the deadline — and if the two clocks disagree, "at the deadline" is
 * already in the past for the queue, so without a floor the job would run again at once and spin
 * until the clocks agree. The floor makes every re-arm at least a minute away, so what it bounds is
 * the **rate**, not the count: one fire a minute for as long as this process's clock trails the
 * database's past the deadline. While that skew is under a minute that is one extra fire; a skew of
 * *n* minutes costs up to *n* extra fires, each a single read that finds `not_due`. The price is
 * expiring up to a minute late on a host whose clock is behind its database's.
 */
export const DEADLINE_REARM_FLOOR_MS = 60_000;

/**
 * One wake-up on `deadline.sweep`: which aggregate, which one, which of its deadlines.
 *
 * Exactly the triple the architect's ruling names and nothing else — in particular **no due
 * instant**: the job re-reads it from the row (a question, an approval) or recomputes it from the
 * event log (a take-over), so a wake-up that outlives a change of mind carries nothing stale.
 * Strict, like every boundary: a job enqueued by a newer build with a field this one does not know
 * is refused by name rather than half-understood.
 */
export const deadlineSweepDataSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    aggregate: z.literal('question'),
    id: idSchema,
    kind: z.literal('question_timeout'),
  }),
  z.strictObject({
    aggregate: z.literal('approval'),
    id: idSchema,
    kind: z.literal('approval_timeout'),
  }),
  z.strictObject({
    aggregate: z.literal('task'),
    id: idSchema,
    kind: z.literal('take_over_inactivity'),
  }),
]);

export type DeadlineSweepData = z.infer<typeof deadlineSweepDataSchema>;

/** The singleton key: one queued timer per `(aggregate, id, kind)`. */
export const deadlineKey = (data: DeadlineSweepData): string =>
  `${data.aggregate}:${data.id}:${data.kind}`;

/** Arms (or re-arms) one timer. */
export const enqueueDeadline = async (
  jobs: Jobs,
  data: DeadlineSweepData,
  dueAt: IsoDateTime,
): Promise<void> => {
  await jobs.enqueue<DeadlineSweepData>({
    queue: JOB_QUEUES.deadlineSweep,
    data,
    singletonKey: deadlineKey(data),
    startAfter: new Date(dueAt),
  });
};

export const declareDeadlineQueue = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue({
    name: JOB_QUEUES.deadlineSweep,
    // `stately` per key: see `JOB_QUEUES.deadlineSweep`.
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
  });
};

export interface DeadlineArmingOptions {
  readonly jobs: Jobs;
  readonly calendar: WorkingCalendar;
  readonly logger?: Logger;
}

/**
 * The TD-005 priority the arming handler runs at — **15**, the core band, because technical/02's
 * catalogue already gave `task.question.asked` a *"timer (15)"* consumer and this is it.
 *
 * It decides nothing about the task and writes nothing — it arms a timer after the dispatch
 * commits — so the same number serves the two events technical/02's table did not foresee a timer
 * on (`task.approval.requested`, `task.taken_over`). The core band rather than the integrations
 * band because a timer tells the outside world nothing.
 */
export const DEADLINE_ARMING_PRIORITY = 15;

/**
 * Arms the three timers — criterion (1)'s *"the enqueue goes through `HandlerContext.afterCommit`"*.
 *
 * It reads the deadline off the event rather than off the row: `task.question.asked` and
 * `task.approval.requested` carry the whole record, `deadline_at` included, and the record *is*
 * what the creating transaction stored. A record with no deadline — which nothing on this build
 * writes, and which a row created by an older build still carries — arms nothing, and says so.
 */
export const deadlineArmingHandler = (options: DeadlineArmingOptions): EventHandler => ({
  name: 'pipeline.deadlines',
  priority: DEADLINE_ARMING_PRIORITY,
  eventTypes: ['task.question.asked', 'task.approval.requested', 'task.taken_over'],
  handle: async (context) => {
    const logger = options.logger ?? silentLogger;
    const event = context.event.event;
    const arm = (data: DeadlineSweepData, dueAt: IsoDateTime): void => {
      context.afterCommit(async () => {
        await enqueueDeadline(options.jobs, data, dueAt);
      });
    };
    switch (event.type) {
      case 'task.question.asked': {
        const { question } = event.payload;
        if (question.deadline_at === null || question.deadline_at === undefined) {
          logger.warn(
            { question_id: question.id, task_id: event.payload.task_id },
            'a question was asked with no deadline, so nothing will expire it',
          );
          return;
        }
        arm(
          { aggregate: 'question', id: question.id, kind: 'question_timeout' },
          question.deadline_at,
        );
        return;
      }
      case 'task.approval.requested': {
        const { approval } = event.payload;
        if (approval.deadline_at === null || approval.deadline_at === undefined) {
          logger.warn(
            { approval_id: approval.id, task_id: event.payload.task_id },
            'an approval was requested with no deadline, so nothing will expire it',
          );
          return;
        }
        arm(
          { aggregate: 'approval', id: approval.id, kind: 'approval_timeout' },
          approval.deadline_at,
        );
        return;
      }
      case 'task.taken_over': {
        arm(
          { aggregate: 'task', id: event.payload.task_id, kind: 'take_over_inactivity' },
          takeOverDeadline(options.calendar, event.occurred_at),
        );
        return;
      }
      default:
        return;
    }
  },
});

export interface DeadlineSweepOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly jobs: Jobs;
  readonly calendar: WorkingCalendar;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  /** `TaskCommandDependencies.redactor`: the expiry commands store no free text, but share the type. */
  readonly redactor: SecretRedactor;
  readonly logger?: Logger;
}

const contextFor = (options: DeadlineSweepOptions, taskId: Id): CommandContext => ({
  ids: options.ids,
  actor: PIPELINE_ACTOR,
  clock: options.clock as CommandContext['clock'],
  correlationId: taskId,
  causeEventId: null,
});

/**
 * The take-over half of the re-validation, and the one ending this module writes itself.
 *
 * *"Still taken over"* is {@link PipelineStore}'s `takenOver` — the newest take-over boundary on the
 * task's stream — **and** the task still `paused`: a hand-back, a resume, a cancellation or a
 * completion ends the take-over, and a task somebody already escalated is not escalated twice. The
 * deadline is recomputed from the take-over the task holds *now*, so a timer armed for an earlier
 * take-over (taken, handed back, taken again inside the window, the second arm collapsing onto the
 * first) re-arms for the later one instead of expiring it early.
 *
 * **Inactivity is measured from the take-over itself, and that is a narrowing.** The platform can
 * observe some of what a person does on a taken-over task — a push to a branch with a merge request
 * arrives as `mr.updated`, and a command they issue leaves a `human_actions` row — and this timer
 * reads **neither**: it counts five working days from `task.taken_over` to the first of a hand-back,
 * a resume, a stage entry, a completion or a cancellation. So a person who is pushing every day
 * without handing back is escalated anyway. That is the cheaper direction (the escalation moves the
 * task to `needs_human` and keeps the take-over block on the workpad; it takes nothing from them),
 * and resetting the timer on those signals is filed as PROGRESS backlog 167 rather than guessed at
 * here — which signals count as activity is a product question, and `mr.updated` does not name the
 * pusher.
 */
const expireTakeOver = async (
  options: DeadlineSweepOptions,
  taskId: Id,
): Promise<DeadlineOutcome> => {
  const what = 'escalating a take-over nobody touched';
  try {
    return await retryOnTaskConflict(
      { taskId, what, ...(options.logger === undefined ? {} : { logger: options.logger }) },
      async () =>
        options.unitOfWork.transaction(async (scope): Promise<DeadlineOutcome> => {
          const stored = await options.store.tasks.load(scope.tx, taskId);
          if (stored === null || stored.task.state !== 'paused') {
            return { kind: 'settled' };
          }
          const takeOver = await options.store.tasks.takenOver(scope.tx, taskId);
          if (takeOver === null) {
            return { kind: 'settled' };
          }
          const dueAt = takeOverDeadline(options.calendar, takeOver.at);
          const context = contextFor(options, taskId);
          if (isBefore(context.clock.now(), dueAt)) {
            return { kind: 'not_due', dueAt };
          }
          const escalated = escalateTask(
            stored.task,
            {
              reason: `the take-over was inactive for ${TAKE_OVER_INACTIVITY_TIMEOUT}`,
              blockerBrief:
                `${stored.task.ticket.key} was taken over by a human at ${takeOver.at} and has not been ` +
                `handed back in ${TAKE_OVER_INACTIVITY_TIMEOUT} (pushes to the branch do not count). ` +
                `The work is on ${takeOver.branch}. Hand it back at the stage it should resume from, ` +
                'or cancel it.',
            },
            context,
          );
          await options.store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
          await scope.events.append(escalated.events);
          return { kind: 'expired' };
        }),
    );
  } catch (error) {
    if (!(error instanceof TaskConflictExhaustedError)) {
      throw error;
    }
    await escalateTaskAfterConflict(
      {
        unitOfWork: options.unitOfWork,
        store: options.store,
        context: (id) => contextFor(options, id),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      error,
    );
    return { kind: 'expired' };
  }
};

/**
 * The `deadline.sweep` worker — criterion (2): the job re-validates on fire.
 *
 * Every branch asks the aggregate, never the payload, whether anything is still owed. What it does
 * with the three answers is the same for all three kinds: `expired` is done, `settled` is done, and
 * `not_due` re-arms at the deadline (no earlier than {@link DEADLINE_REARM_FLOOR_MS} from now).
 * An expiry that meets a question or an approval the saga can no longer escalate — the task moved
 * meanwhile — is the saga's to ignore: `questionHandler` and `approvalHandler` act only on a task
 * still `waiting_answers` / `waiting_approval`.
 */
export const deadlineSweepHandler = (options: DeadlineSweepOptions): JobHandler => {
  const logger = options.logger ?? silentLogger;
  return async (job) => {
    const parsed = deadlineSweepDataSchema.safeParse(job.data);
    if (!parsed.success) {
      // A shape this build does not know: a newer deployment's timer during a rolling upgrade
      // (the reasoning `pipelineOutboundHandler`'s default branch gives). Failing it would retry
      // twice and dead-letter a wake-up the other half of the fleet understands.
      logger.warn(
        { job_id: job.id, issues: parsed.error.issues.map((issue) => issue.message) },
        'deadline.sweep: a wake-up this build cannot read was skipped',
      );
      return;
    }
    await settleDeadline(options, parsed.data);
  };
};

/**
 * One deadline, re-validated and acted on — the whole of what the `deadline.sweep` job does, and
 * what the recovery pass (`recovery/deadline.ts`) calls for a timer whose wake-up was lost, so a
 * lost arm and a fired one reach the aggregate through **one** path.
 */
export const settleDeadline = async (
  options: DeadlineSweepOptions,
  data: DeadlineSweepData,
): Promise<DeadlineOutcome> => {
  const logger = options.logger ?? silentLogger;
  const commands: TaskCommandDependencies = {
    unitOfWork: options.unitOfWork,
    store: options.store,
    context: (taskId) => contextFor(options, taskId),
    redactor: options.redactor,
  };
  // Each branch reads the aggregate and writes it in **one** transaction. A concurrent answer
  // (or decision) is serialised by the aggregate's own event stream rather than by a row lock:
  // both append at the same `stream_seq`, `events_enforce_stream_seq` refuses the second, and if
  // the second is this job it throws, is retried by the queue, and re-validates into `settled`.
  const outcome =
    data.kind === 'question_timeout'
      ? await expireTaskQuestion(commands, data.id)
      : data.kind === 'approval_timeout'
        ? await expireTaskApproval(commands, data.id)
        : await expireTakeOver(options, data.id);
  if (outcome.kind === 'not_due') {
    const floor = new Date(Date.parse(options.clock.now()) + DEADLINE_REARM_FLOOR_MS);
    const dueAt = isBefore(outcome.dueAt, floor.toISOString())
      ? (floor.toISOString() as IsoDateTime)
      : outcome.dueAt;
    logger.debug({ ...data, due_at: outcome.dueAt }, 'deadline.sweep: not due yet; re-armed');
    await enqueueDeadline(options.jobs, data, dueAt);
  } else if (outcome.kind === 'expired') {
    logger.info({ ...data }, 'deadline.sweep: a deadline passed and the waiting aggregate expired');
  }
  return outcome;
};
