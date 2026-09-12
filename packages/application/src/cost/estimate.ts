/**
 * The cost estimate a task gets at refinement — product/09: *"Estimate before spend: each task gets
 * a cost estimate at refinement (size × project history)"*.
 *
 * A handler on `artifact.created`, in TD-005's core band just after the pipeline's own transition,
 * because refinement's `RefinedSpec` is where a task's **size** is first known — nothing else in
 * this build ever writes `tasks.size`, and the estimate is a function of it. The alternative was a
 * step inside the saga; a handler keeps the pipeline's state machine free of a projection it does
 * not read, and the whole thing is additive: if it fails, the task still moves.
 *
 * ## Two columns, one narrow write
 *
 * `tasks.size` and `tasks.estimate_usd` are written by {@link CostStore.saveEstimate} and by
 * nothing else. Not `tasks.save`: this runs in an event handler beside the `stage.execute` job's
 * transactions, which is precisely the premise that turned a whole-row write into a lost update at
 * WP-15d (standing rule 79, measured at 0.40 USD of a task's recorded spend).
 *
 * ## The **estimate** is written once; the size is not, and the difference is deliberate
 *
 * A re-run of refinement produces a second `RefinedSpec`, and the estimate is "before spend" — an
 * expectation set at the start, which is what makes `estimateAccuracy` meaningful later. So the
 * guard is `estimateUsd !== null`: a task that already carries a number keeps it, whatever a later
 * round says.
 *
 * A task with a **size and no estimate** is therefore *not* left alone — it is the project's first
 * task, which had no history to estimate from (`basis: 'unknown'`), and the second round is the
 * first chance to give it a number now that other tasks may have finished. `tasks.size` is rewritten
 * in the same narrow write, from the newest spec, which is the value a reader should see when the
 * two rounds disagree. The cost of this branch is one extra read plus one two-column update per
 * re-refinement of an unestimated task; `estimate.test.ts` pins both directions.
 */
import type { Id } from '@platform/contracts';
import { estimateTaskCostUsd } from '@platform/domain';
import type { EventHandler } from '../events/handler.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { CostStore } from './ports.js';

export const COST_ESTIMATE_HANDLER = 'cost.estimate';

/**
 * Just after the pipeline transition (10) and well before the integrations band, so the estimate is
 * on the row before anything renders it (the workpad is 120).
 */
export const COST_ESTIMATE_PRIORITY = 15;

/**
 * How many finished tasks the estimate reads.
 *
 * Bounded because the query runs inside a dispatch's transaction: an organisation with ten thousand
 * finished tasks must not make one event handler read them all. The newest tasks are the relevant
 * ones anyway — prices and models move.
 */
export const ESTIMATE_HISTORY_LIMIT = 100;

export interface CostEstimateOptions {
  readonly store: CostStore;
  readonly logger?: Logger;
}

export const costEstimateHandler = (options: CostEstimateOptions): EventHandler => ({
  name: COST_ESTIMATE_HANDLER,
  priority: COST_ESTIMATE_PRIORITY,
  eventTypes: ['artifact.created'],
  handle: async (context) => {
    const logger = options.logger ?? silentLogger;
    const event = context.event.event;
    if (event.type !== 'artifact.created') {
      return;
    }
    const { payload } = event;
    if (payload.artifact.artifact_type !== 'RefinedSpec') {
      return;
    }
    const taskId = payload.task_id as Id;
    const existing = await options.store.taskEstimate(context.scope.tx, taskId);
    if (existing === null || existing.estimateUsd !== null) {
      return;
    }
    const size = await options.store.refinedSize(context.scope.tx, taskId);
    if (size === null) {
      logger.debug(
        { task_id: taskId },
        'cost estimate: the refined spec carries no usable size, so the task keeps none',
      );
      return;
    }
    const history = await options.store.estimateHistory(
      context.scope.tx,
      payload.project_id as Id,
      ESTIMATE_HISTORY_LIMIT,
    );
    const estimate = estimateTaskCostUsd(size, history);
    await options.store.saveEstimate(context.scope.tx, taskId, {
      size,
      estimateUsd: estimate.usd,
    });
    logger.debug(
      {
        task_id: taskId,
        size,
        estimate_usd: estimate.usd,
        basis: estimate.basis,
        samples: estimate.samples,
      },
      'cost estimate: a task was estimated',
    );
  },
});
