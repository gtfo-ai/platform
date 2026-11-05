/**
 * A job's own task transaction, on the conflict bound (WP-15e) — moved out of `jobs.ts` at WP-177
 * so the ticket claim (`ticket-claim.ts`), which `stage.execute` calls, can use it without a module
 * cycle. `jobs.ts` re-exports both names.
 */
import type { Id } from '@platform/contracts';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineSagaOptions } from './saga.js';
import {
  escalateTaskAfterConflict,
  retryOnTaskConflict,
  TaskConflictExhaustedError,
} from './task-conflict.js';

/**
 * A job's own transaction that writes a task, on the conflict bound (WP-15e).
 *
 * A job owns its transaction, so it owns the retry: a `save` refused because another writer moved
 * the row re-runs the **whole** unit in a new transaction, which rolls back what the failed attempt
 * wrote and re-reads the task. Exhausting the bound escalates the task rather than dropping the
 * decision — the same ending the stage executor gives, and for the same reason (`task-conflict.ts`).
 *
 * **`null` means two different things and the signature cannot tell them apart**: either `fn`
 * itself returned `null` — "there is nothing to do", the shape both callers already use for a task
 * that moved — or the bound was spent and the task has just been **escalated**. Both callers want
 * the same behaviour today (enqueue no follow-up work), which is why this is one nullable return
 * rather than a discriminated result; the cost of the conflation is that a caller which one day
 * needs to act on the escalation cannot, and would have to widen this first. The escalation is
 * never silent either way: it is logged here and it is a `task.escalated` event.
 */
/** What a job's own task transaction needs — no executor, so an outbound duty can settle too. */
export type TaskTransactionOptions = PipelineSagaOptions & { readonly unitOfWork: UnitOfWork };

export const inTaskTransaction = async <T>(
  options: TaskTransactionOptions,
  taskId: Id,
  what: string,
  fn: (scope: TransactionScope) => Promise<T>,
): Promise<T | null> => {
  try {
    return await retryOnTaskConflict(
      { taskId, what, ...(options.logger === undefined ? {} : { logger: options.logger }) },
      async () => options.unitOfWork.transaction(fn),
    );
  } catch (error) {
    if (!(error instanceof TaskConflictExhaustedError)) {
      throw error;
    }
    const logger: Logger = options.logger ?? silentLogger;
    logger.error(
      { task_id: taskId, what, attempts: error.attempts, err: error },
      'a job lost every race writing this task; it is escalated',
    );
    await escalateTaskAfterConflict(
      {
        unitOfWork: options.unitOfWork,
        store: options.store,
        context: (id) => ({
          ids: options.ids,
          actor: { kind: 'system', component: 'pipeline' },
          clock: options.clock as never,
          correlationId: id,
          causeEventId: null,
        }),
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      error,
    );
    return null;
  }
};
