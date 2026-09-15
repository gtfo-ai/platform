/**
 * `createHistoryBootstrapRuntime` — the one queue, the one worker and the one handler the history
 * bootstrap needs (WP-35).
 *
 * The shape `createOnboardingRuntime` and `createLibrarianRuntime` next door already use, and for
 * the same reason: *which handler listens to which event, and which queue drives which job, is the
 * product*, so the wiring lives in this ring while every adapter it needs arrives as a port. A
 * composition root that registered the handler and forgot the worker would enqueue jobs nothing
 * runs, which is exactly what one function prevents.
 *
 * Starting a bootstrap is **not** here: `startHistoryBootstrap` is a command an HTTP route calls,
 * and the stages its collection creates run on `stage.execute`, whose worker the pipeline runtime
 * already starts.
 *
 * **One worker for both halves of the job**, which is what keeps `POOL_RESERVATIONS.bootstrap` at
 * one connection: a `record` wake-up cannot arrive before the `collect` that created the run it
 * reports on, so the two never contend (`JOB_QUEUES.historyBootstrap` carries the argument).
 */

import type { Id } from '@platform/contracts';
import type { EventHandler } from '../events/handler.js';
import type { JobHandler, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { HistoryCollectJobData } from './batch.js';
import { collectHistory, type HistoryCollectOptions } from './collect.js';
import {
  type HistoryRecordJobData,
  type HistoryRecordOptions,
  historyTriggerHandlers,
  recordHistoryFindings,
} from './record.js';

export type HistoryBootstrapJobData = HistoryCollectJobData | HistoryRecordJobData;

export interface HistoryBootstrapRuntimeOptions {
  readonly collect: HistoryCollectOptions;
  readonly record: HistoryRecordOptions;
  readonly jobs: Jobs;
  readonly logger?: Logger;
}

export interface HistoryBootstrapRuntime {
  /** Registered on the `EventBus` by the composition root, before the outbox worker starts. */
  readonly handlers: readonly EventHandler[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * The one handler both halves share, discriminated on `kind`.
 *
 * Exported so a test can drive the dispatch without a queue — and because the discrimination is
 * where a third wake-up would have to declare itself rather than falling through silently.
 */
export const historyBootstrapJobHandler =
  (options: HistoryBootstrapRuntimeOptions): JobHandler<HistoryBootstrapJobData> =>
  async (job) => {
    const logger = options.logger ?? silentLogger;
    if (job.data.kind === 'collect') {
      const report = await collectHistory(options.collect, {
        batchId: job.data.batch_id as Id,
        projectId: job.data.project_id as Id,
      });
      if (report.status === 'skipped') {
        // Not a throw: every skip is a state the platform can legitimately be in (a deleted batch,
        // a redelivery), and a throw would spend two pg-boss retries on it.
        logger.warn(
          { batch_id: job.data.batch_id, reason: report.reason },
          'a history bootstrap collected nothing',
        );
      }
      return;
    }
    const report = await recordHistoryFindings(options.record, job.data);
    if (report.status === 'skipped') {
      logger.warn(
        { task_id: job.data.task_id, reason: report.reason },
        'a history mining run recorded nothing',
      );
    }
  };

export const createHistoryBootstrapRuntime = (
  options: HistoryBootstrapRuntimeOptions,
): HistoryBootstrapRuntime => {
  const workers: JobWorker[] = [];
  const { jobs } = options;
  return {
    handlers: historyTriggerHandlers({
      jobs,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    start: async () => {
      await declareHistoryBootstrapQueue(jobs);
      workers.push(
        await jobs.work<HistoryBootstrapJobData>({
          queue: JOB_QUEUES.historyBootstrap,
          handler: historyBootstrapJobHandler(options),
          // One: a bootstrap happens once per project, the collection is one long read and the
          // recordings are a handful of rows each. A second worker would cost a second pooled
          // connection for throughput nobody needs.
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

/** Declares the queue this module's job runs on. Idempotent. */
export const declareHistoryBootstrapQueue = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue({
    name: JOB_QUEUES.historyBootstrap,
    // `standard`: every wake-up carries a different batch or a different artifact.
    policy: 'standard',
    retryLimit: 2,
    // Longer than the knowledge jobs' 30 s: a retry of `collect` re-reads the provider, and a
    // failure there is usually a rate limit or an outage that a few seconds will not have cleared.
    retryDelaySeconds: 60,
    retryBackoff: true,
  });
};
