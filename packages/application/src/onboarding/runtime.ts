/**
 * `createOnboardingRuntime` — the one queue and the one handler that record a discovery run
 * (WP-21).
 *
 * The shape `createLibrarianRuntime` and `createKnowledgeIndexRuntime` next door already use, and
 * for the same reason: *which handler listens to which event, and which queue drives which job, is
 * the product*, so the wiring lives in this ring while every adapter it needs arrives as a port. A
 * composition root that registered the handler and forgot the worker would enqueue jobs nothing
 * runs, which is exactly what one function prevents.
 *
 * Starting the discovery run itself is **not** here: `startProjectDiscovery` is a command an HTTP
 * route calls, not a worker, and it enqueues onto `stage.execute`, whose worker the pipeline
 * runtime already starts.
 */
import type { EventHandler } from '../events/handler.js';
import type { Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import {
  type DiscoveryRecordData,
  type DiscoveryRecordOptions,
  declareDiscoveryRecordQueue,
  discoveryRecordHandler,
  discoveryTriggerHandlers,
} from './record.js';

export interface OnboardingRuntimeOptions {
  readonly record: DiscoveryRecordOptions;
  readonly jobs: Jobs;
}

export interface OnboardingRuntime {
  /** Registered on the `EventBus` by the composition root, before the outbox worker starts. */
  readonly handlers: readonly EventHandler[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const createOnboardingRuntime = (options: OnboardingRuntimeOptions): OnboardingRuntime => {
  const workers: JobWorker[] = [];
  const { jobs } = options;
  return {
    handlers: discoveryTriggerHandlers({
      jobs,
      ...(options.record.logger === undefined ? {} : { logger: options.record.logger }),
    }),
    start: async () => {
      await declareDiscoveryRecordQueue(jobs);
      workers.push(
        await jobs.work<DiscoveryRecordData>({
          queue: JOB_QUEUES.discoveryRecord,
          handler: discoveryRecordHandler(options.record),
          // One: onboarding happens once per project and the work is a handful of rows. A second
          // worker would cost a second pooled connection for no throughput anybody needs.
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
