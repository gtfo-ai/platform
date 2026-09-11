/**
 * Composing the pipeline: the handlers a bus registers, the workers a process starts.
 *
 * This is the seam an `apps/*` composition root uses. It is in the application ring rather than in
 * `apps/server` because the wiring is the *product* — which handler listens to which event, at
 * which priority, and which queue drives which job — and a composition root that re-derived it
 * would be a second copy of technical/02's table.
 *
 * ## Pool arithmetic, stated once
 *
 * The dispatcher needs `2 × APP_DISPATCH_MAX_CONCURRENCY + 1` connections
 * (`InsufficientPoolError`). The pipeline adds to that in **two** ways, and only the first is
 * flat:
 *
 *  - each `stage.execute` worker holds one connection during each of its two transactions, and
 *    each review-window worker holds one during each of its two. Both make their provider calls
 *    *outside* those transactions, so an audit write started from either replaces the worker's
 *    connection rather than nesting inside it;
 *  - a **handler** that calls a provider inside `context.scope.tx` does nest: the audit row is
 *    written in a transaction of its own (WP-15b, BD-003 requires the row and its event to commit
 *    together), so that dispatch holds **three** connections, not two. Three handlers do it today
 *    — the intake default-branch read, the workpad and the status mapping — which makes the term
 *    proportional to the dispatch concurrency. `apps/server/src/config.ts` counts it as
 *    `POOL_RESERVATIONS.auditPerDispatch` and names the filed defect underneath it: CLAUDE.md's
 *    shape is *transaction / no transaction / transaction*, and a handler holding a pooled
 *    connection across provider latency is not that.
 *
 * So a process running the pipeline needs
 * `3 × dispatchConcurrency + 1 + stageConcurrency + reviewConcurrency` at least, and the number is
 * a floor rather than a budget — the HTTP layer and the projections draw on the same pool.
 */
import type { EventHandler } from '../events/handler.js';
import type { JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  declarePipelineQueues,
  type PipelineJobOptions,
  type ReviewWindowData,
  reviewWindowHandler,
  type StageExecuteData,
  stageExecuteHandler,
} from './jobs.js';
import { type PipelineSagaOptions, pipelineHandlers } from './saga.js';
import {
  createStageExecutor,
  type StageExecutor,
  type StageExecutorOptions,
} from './stage-executor.js';

export interface PipelineRuntimeOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
  /** Everything the stage executor needs that the saga does not. */
  readonly execution: Omit<
    StageExecutorOptions,
    'unitOfWork' | 'store' | 'settings' | 'logger' | 'context'
  > &
    Pick<StageExecutorOptions, 'context'>;
  /** How many stages this process runs at once. @default 1 */
  readonly stageConcurrency?: number;
}

export interface PipelineRuntime {
  /** Registered on the `EventBus` by the composition root, in TD-005's core band. */
  readonly handlers: readonly EventHandler[];
  readonly executor: StageExecutor;
  /** Declares the queues and starts the workers. Idempotent. */
  start(): Promise<void>;
  /** Stops the workers; the handlers stop with the bus. */
  stop(): Promise<void>;
}

export const createPipelineRuntime = (options: PipelineRuntimeOptions): PipelineRuntime => {
  const logger: Logger | undefined = options.logger;
  const executor = createStageExecutor({
    ...options.execution,
    unitOfWork: options.unitOfWork,
    store: options.store,
    settings: async (projectId) => options.settings.forProject(projectId),
    ...(logger === undefined ? {} : { logger }),
  });

  const jobOptions: PipelineJobOptions = { ...options, executor };
  const workers: JobWorker[] = [];

  return {
    handlers: pipelineHandlers(options),
    executor,
    start: async () => {
      await declarePipelineQueues(options.jobs);
      workers.push(
        await options.jobs.work<StageExecuteData>({
          queue: JOB_QUEUES.stageExecute,
          handler: stageExecuteHandler(jobOptions),
          concurrency: options.stageConcurrency ?? 1,
        }),
      );
      workers.push(
        await options.jobs.work<ReviewWindowData>({
          queue: JOB_QUEUES.mrCommentDebounce,
          handler: reviewWindowHandler(jobOptions),
          concurrency: 1,
        }),
      );
    },
    stop: async () => {
      const stopping = workers.splice(0, workers.length);
      for (const worker of stopping) {
        await worker.stop();
      }
    },
  };
};
