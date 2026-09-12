/**
 * `createLibrarianRuntime` — the three queues, the one handler and the nightly schedule that make
 * up the Librarian pipeline, composed once so a root cannot register half of them (WP-18b).
 *
 * It is the shape `createKnowledgeIndexRuntime` already uses next door, and for the same reason:
 * *which handler listens to which event, and which queue drives which job, is the product*, so it
 * lives in this ring while every adapter it needs arrives as a port.
 *
 * The three workers are separate queues rather than one with a `duty` switch, because their
 * policies genuinely differ and the policy is the interesting part: curation is `standard` (each
 * wake-up is a different artifact), the apply is `stately` per project (BD-012 serialises knowledge
 * commits per repository), and the hygiene pass is `stately` for the whole deployment behind a
 * cron. A single queue would have to take the weakest of the three.
 */
import type { EventHandler } from '../events/handler.js';
import type { JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import {
  declareKnowledgeApplyQueue,
  type KnowledgeApplyData,
  type KnowledgeApplyOptions,
  knowledgeApplyHandler,
} from './apply.js';
import {
  declareKnowledgeHygieneQueue,
  type KnowledgeHygieneOptions,
  knowledgeHygieneHandler,
  knowledgeHygieneSchedule,
} from './hygiene.js';
import {
  declareLibrarianQueues,
  type KnowledgeProposalsData,
  type LibrarianJobOptions,
  librarianProposalsHandler,
  librarianTriggerHandlers,
} from './librarian.js';

export interface LibrarianRuntimeOptions {
  readonly curation: LibrarianJobOptions;
  readonly apply: KnowledgeApplyOptions;
  readonly hygiene: KnowledgeHygieneOptions;
  /** IANA zone the nightly schedule is read in — `Jobs.scheduleCron` requires one (TD-004). */
  readonly timezone: string;
}

export interface LibrarianRuntime {
  /** Registered on the `EventBus` by the composition root, before the outbox worker starts. */
  readonly handlers: readonly EventHandler[];
  start(): Promise<void>;
  stop(): Promise<void>;
}

export const createLibrarianRuntime = (options: LibrarianRuntimeOptions): LibrarianRuntime => {
  const workers: JobWorker[] = [];
  const { jobs } = options.curation;
  return {
    handlers: librarianTriggerHandlers({
      jobs,
      ...(options.curation.logger === undefined ? {} : { logger: options.curation.logger }),
    }),
    start: async () => {
      await declareLibrarianQueues(jobs);
      await declareKnowledgeApplyQueue(jobs);
      await declareKnowledgeHygieneQueue(jobs);
      workers.push(
        await jobs.work<KnowledgeProposalsData>({
          queue: JOB_QUEUES.knowledgeProposals,
          handler: librarianProposalsHandler(options.curation),
          concurrency: 1,
        }),
        await jobs.work<KnowledgeApplyData>({
          queue: JOB_QUEUES.knowledgeApply,
          // One: the queue is singleton per project, and a second worker here would only ever run a
          // different project's commit — at the cost of a second pooled connection.
          concurrency: 1,
          handler: knowledgeApplyHandler(options.apply),
        }),
        await jobs.work({
          queue: JOB_QUEUES.knowledgeHygiene,
          concurrency: 1,
          handler: knowledgeHygieneHandler(options.hygiene),
        }),
      );
      // Idempotent by the port's contract ("scheduling the same cron twice … is safe"), which is
      // what lets every worker process register it without an arbiter.
      await jobs.scheduleCron(knowledgeHygieneSchedule(options.timezone));
    },
    stop: async () => {
      const stopping = workers.splice(0, workers.length);
      for (const worker of stopping) {
        await worker.stop();
      }
    },
  };
};
