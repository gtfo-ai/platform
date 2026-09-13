/**
 * What a caller does when `TaskRepository.save` refuses a write over a row that moved (WP-15e).
 *
 * The refusal is only half of PROGRESS backlog 18. A `save` that cannot silently win is a `save`
 * that can *loudly lose*, and a loss with no ending is the same lost update with a stack trace — so
 * every writer needs one of exactly two endings, and which one it gets depends on **who owns the
 * transaction**:
 *
 *  - **The pipeline's jobs own theirs** (`stage.execute`, `mr.comment.debounce`,
 *    `pipeline.outbound`). They use {@link retryOnTaskConflict}, which re-runs the whole unit — a
 *    new transaction, so the previous attempt's writes are rolled back and the re-read is clean.
 *    That is the property criterion 4 of the work package asks for: the retry re-reads the
 *    aggregate and never re-applies the snapshot it was holding.
 *  - **Event handlers do not own theirs.** `EventBus` opens the transaction, and it re-runs the
 *    handler on a conflict for the same reason and with the same bound
 *    ({@link MAX_TASK_CONFLICT_ATTEMPTS}) — see `events/event-bus.ts`. A handler must therefore
 *    **let the conflict escape**: catching one inside a handler and retrying in place would leave
 *    the previous attempt's non-idempotent writes behind (`approvals.insert` runs before the `save`
 *    in `planApprovalGate`, and its id comes from `ids.next()`, so an in-transaction retry would
 *    write a second approval row).
 *
 * When the bound is spent the task is **escalated**, not dropped: {@link escalateTaskAfterConflict}
 * parks it in `needs_human` with a brief that says what happened. Standing rule 20 — fail closed on
 * a mutation — and no new task state (Q59's answer, reused).
 *
 * ## What the bound is worth
 *
 * {@link MAX_CONCURRENCY_CONFLICT_ATTEMPTS} states it once, for both retry sites, with the reasoning
 * that chose the number.
 */
import type { Id } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { escalateTask, IllegalTransitionError } from '@platform/domain';
import { isConcurrencyConflict, MAX_CONCURRENCY_CONFLICT_ATTEMPTS } from '../events/concurrency.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineStore } from './store.js';

/**
 * How many times a refused write is re-read and re-decided before the task is escalated.
 *
 * The bus's own bound and this one are the same number by construction, because they are the same
 * policy seen from the two sides of "who owns the transaction" (standing rule 63).
 */
export const MAX_TASK_CONFLICT_ATTEMPTS = MAX_CONCURRENCY_CONFLICT_ATTEMPTS;

/** The bound is spent: another writer won every attempt. */
export class TaskConflictExhaustedError extends Error {
  override readonly name = 'TaskConflictExhaustedError';

  readonly taskId: Id;
  readonly attempts: number;
  readonly what: string;

  // Explicit fields rather than parameter properties, for the reason
  // `TaskConcurrentModificationError` states: Node's strip-only type stripping refuses a parameter
  // property, and this repository runs its sources through it.
  constructor(taskId: Id, attempts: number, what: string, options?: { readonly cause?: unknown }) {
    super(
      `"${what}" for task ${taskId} lost ${attempts} races against another writer; ` +
        'the task is escalated rather than written from a stale snapshot',
      options,
    );
    this.taskId = taskId;
    this.attempts = attempts;
    this.what = what;
  }
}

export interface TaskConflictRetryOptions {
  readonly taskId: Id;
  /** What the unit was doing, for the log line and the blocker brief. */
  readonly what: string;
  /** @default MAX_TASK_CONFLICT_ATTEMPTS */
  readonly attempts?: number;
  readonly logger?: Logger;
}

/**
 * Runs `unit` until it stops losing, at most `attempts` times.
 *
 * `unit` is called again from the top, so whatever it reads it reads again — this function
 * deliberately has no access to the aggregate and therefore cannot re-apply a stale one.
 *
 * @throws {TaskConflictExhaustedError} when every attempt conflicted.
 */
export const retryOnTaskConflict = async <T>(
  options: TaskConflictRetryOptions,
  unit: (attempt: number) => Promise<T>,
): Promise<T> => {
  const attempts = options.attempts ?? MAX_TASK_CONFLICT_ATTEMPTS;
  const logger = options.logger ?? silentLogger;
  let last: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await unit(attempt);
    } catch (error) {
      if (!isConcurrencyConflict(error)) {
        throw error;
      }
      last = error;
      logger.warn(
        { task_id: options.taskId, what: options.what, attempt, attempts, err: error },
        'a task write lost a race with another writer; re-reading and deciding again',
      );
    }
  }
  throw new TaskConflictExhaustedError(options.taskId, attempts, options.what, { cause: last });
};

export interface ConflictEscalationOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly context: (taskId: Id) => CommandContext;
  readonly logger?: Logger;
}

/**
 * Parks a task whose write lost every race, in a transaction of its own.
 *
 * The escalation is itself a `save` and can itself be refused, so it is retried on the same bound —
 * and if *that* is spent the error escapes to the job's own retry, which is the one ending left.
 * A task that has already finished cannot be escalated (`IllegalTransitionError`); there is nothing
 * to park and nothing was lost, so it is logged and consumed, exactly as `transitions.ts` does.
 */
export const escalateTaskAfterConflict = async (
  options: ConflictEscalationOptions,
  failure: TaskConflictExhaustedError,
): Promise<void> => {
  const logger = options.logger ?? silentLogger;
  await retryOnTaskConflict(
    {
      taskId: failure.taskId,
      what: `escalating after ${failure.what}`,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
    async () =>
      options.unitOfWork.transaction(async (scope) => {
        const stored = await options.store.tasks.load(scope.tx, failure.taskId);
        if (stored === null) {
          return;
        }
        try {
          const escalated = escalateTask(
            stored.task,
            {
              reason: `"${failure.what}" could not be written: another writer won ${failure.attempts} times in a row`,
              blockerBrief:
                `The platform tried ${failure.attempts} times to record "${failure.what}" for ` +
                `${stored.task.ticket.key} and another writer changed the task each time. Nothing has been ` +
                'written from a stale snapshot. Look at the task, then hand it back at the stage it should resume from.',
            },
            options.context(stored.task.id),
          );
          await options.store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
          await scope.events.append(escalated.events);
        } catch (error) {
          if (!(error instanceof IllegalTransitionError)) {
            throw error;
          }
          logger.warn(
            { task_id: stored.task.id, state: stored.task.state, what: failure.what },
            'a task write lost every race and the task has already finished; nothing to escalate',
          );
        }
      }),
  );
};
