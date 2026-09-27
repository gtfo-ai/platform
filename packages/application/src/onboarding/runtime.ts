/**
 * `createOnboardingRuntime` — the one queue and the one handler that record a discovery run
 * (WP-21), and since WP-64 the readiness re-check after a merge, **on the same queue**.
 *
 * One queue and one worker for both, the shape `JOB_QUEUES.historyBootstrap` took for its two
 * halves: the re-check is a handful of reads and one row, and a second worker would be a second
 * pooled connection (`POOL_RESERVATIONS.onboarding`) for work that never needs to run beside the
 * first. The payload's `kind` tells them apart; a discovery payload has none, which is how every
 * job enqueued before WP-64 is still read correctly.
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
import type { JobHandler, Jobs, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import {
  type ReadinessRecheckData,
  type ReadinessRecheckOptions,
  runReadinessRecheck,
} from './recheck.js';
import {
  type DiscoveryRecordData,
  type DiscoveryRecordOptions,
  declareDiscoveryRecordQueue,
  discoveryRecordHandler,
  discoveryTriggerHandlers,
} from './record.js';

/** The queue's two payloads. */
export type OnboardingJobData = DiscoveryRecordData | ReadinessRecheckData;

const isRecheck = (data: OnboardingJobData): data is ReadinessRecheckData =>
  (data as { kind?: unknown }).kind === 'readiness_recheck';

export interface OnboardingRuntimeOptions {
  readonly record: DiscoveryRecordOptions;
  /** The re-check after a merge (WP-64); its jobs arrive on the same queue. */
  readonly recheck: ReadinessRecheckOptions;
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
  const discovery = discoveryRecordHandler(options.record);
  const handler: JobHandler<OnboardingJobData> = async (job) => {
    if (isRecheck(job.data)) {
      await runReadinessRecheck(options.recheck, job.data);
      return;
    }
    await discovery({ ...job, data: job.data });
  };
  return {
    handlers: discoveryTriggerHandlers({
      jobs,
      ...(options.record.logger === undefined ? {} : { logger: options.record.logger }),
    }),
    start: async () => {
      await declareDiscoveryRecordQueue(jobs);
      workers.push(
        await jobs.work<OnboardingJobData>({
          queue: JOB_QUEUES.discoveryRecord,
          handler,
          // One: a discovery recording or a re-check is a handful of reads and rows, at most once per
          // merge. A second worker would cost a second pooled connection for no throughput anybody
          // needs.
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
