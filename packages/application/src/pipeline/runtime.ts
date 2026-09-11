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
 * (`InsufficientPoolError`), and since WP-15d the pipeline's term is **flat**: one per job worker
 * this runtime starts — `stage.execute`, `mr.comment.debounce` and `pipeline.outbound` — each
 * holding one connection during each of its transactions.
 *
 * That is the whole of it because **no handler calls a provider any more**. Until WP-15d three did
 * (the intake branch check, the workpad, the status mapping), and each made its dispatch hold a
 * *third* connection: the executor's audit row commits in a transaction of its own (BD-003), which
 * nests inside the caller's, so the term was proportional to the dispatch concurrency rather than
 * flat. `apps/server/src/config.ts` counted it as `POOL_RESERVATIONS.auditPerDispatch`; that
 * constant is **0** now, and it is the receipt — while it is 1, the shape is back.
 *
 * So a process running the pipeline needs
 * `2 × dispatchConcurrency + 1 + stageConcurrency + reviewConcurrency + outboundConcurrency` at
 * least, and the number is a floor rather than a budget — the HTTP layer and the projections draw
 * on the same pool.
 *
 * **One thing a handler still does inside its transaction is read `ProjectSettingsPort`**, which in
 * `apps/server` is a `projects` query on a connection borrowed inside the handler's. It is a
 * transient borrow of the local database rather than a connection held across a third party's
 * latency, so it contends where a provider call stalled — every other borrower releases without
 * waiting on a dispatch, so there is no hold-and-wait cycle — and the reservations below cover it.
 * It is filed as discovered work rather than fixed here: the honest fix is for the port to take the
 * caller's transaction.
 */
import type { EventHandler } from '../events/handler.js';
import { markTransactions } from '../events/open-transaction.js';
import type { JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  declarePipelineQueues,
  type PipelineJobOptions,
  type PipelineOutboundData,
  type ReviewWindowData,
  reviewWindowHandler,
  type StageExecuteData,
  stageExecuteHandler,
} from './jobs.js';
import { pipelineOutboundHandler } from './outbound.js';
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
  /**
   * Every transaction the pipeline opens is marked as open (WP-15d).
   *
   * The dispatcher marks the handler path itself; this covers the job path, so a stage executor or
   * a job that reaches a provider from inside its own transaction is refused rather than reviewed
   * for. A decorator, because there are several `UnitOfWork` implementations and a rule maintained
   * in each of them drifts (standing rule 7).
   */
  const unitOfWork = markTransactions(options.unitOfWork);
  const executor = createStageExecutor({
    ...options.execution,
    unitOfWork,
    store: options.store,
    settings: async (projectId) => options.settings.forProject(projectId),
    ...(logger === undefined ? {} : { logger }),
  });

  const jobOptions: PipelineJobOptions = { ...options, unitOfWork, executor };
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
      workers.push(
        await options.jobs.work<PipelineOutboundData>({
          queue: JOB_QUEUES.pipelineOutbound,
          handler: pipelineOutboundHandler(jobOptions),
          /**
           * One, and the trade is stated rather than assumed.
           *
           * One worker keeps a task's outbound calls in the order its handlers decided on, and
           * costs one pooled connection. What it buys the *dispatcher* is the whole of this work
           * package — a slow provider no longer stops every project's events — and what it does
           * not buy is isolation between projects on this queue: a provider that takes ten seconds
           * delays the ticket writes of everything behind it. That is a throughput knob, not a
           * correctness one, and it is deliberately not exposed until something measures a need
           * for it: each unit of concurrency is another connection in `requiredPoolConnections`.
           */
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
