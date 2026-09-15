/**
 * Composing ask-the-task: one handler, one job worker, one outbound duty (WP-31).
 *
 * It lives beside the pipeline's own composition (`pipeline/runtime.ts`) and is called from it, for
 * the reason that file gives: *which handler listens to which event, at which priority, and which
 * queue drives which job* is the product, and a composition root that re-derived it would be a
 * second copy of technical/02's table.
 *
 * **One more pooled connection.** The `task.ask` worker holds one during each of its transactions,
 * on top of the dispatcher's `2 × concurrency + 1` and the four workers the pipeline already starts.
 * `POOL_RESERVATIONS.pipeline` moved from 5 to 6 with this file, and that sentence is why a reader
 * of `apps/server/src/config.ts` can reach the number.
 */
import type { Id } from '@platform/contracts';
import type { BudgetGuard } from '../cost/guard.js';
import type { EventHandler } from '../events/handler.js';
import type { InboundIdentityDirectory } from '../integrations/inbound.js';
import type { RunLeaseOptions } from '../pipeline/lease.js';
import type { ProjectSettingsPort } from '../pipeline/settings.js';
import type { RunStopReasons } from '../pipeline/stop-reasons.js';
import type { PipelineStore } from '../pipeline/store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { JOB_QUEUES, type Jobs, type JobWorker } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import type { ClaudeRunner } from '../ports/runner.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { askHandlers } from './commands.js';
import { type AskExecuteData, type AskExecutor, createAskExecutor } from './executor.js';
import type { AskRunPlanner } from './planner.js';
import type { AskStore } from './store.js';

/** Everything ask-the-task needs that the pipeline's own composition does not already have. */
export interface AskRuntimeOptions {
  readonly asks: AskStore;
  readonly identities: InboundIdentityDirectory;
  readonly runner: ClaudeRunner;
  readonly planner: AskRunPlanner;
  readonly redactor: SecretRedactor;
  /** How the thread and the prompt label the asker — a display name, never an email (WP-27's rule). */
  readonly askedByLabel: (userId: Id) => Promise<string>;
  readonly budgets?: BudgetGuard;
  /** How many asks this process answers at once. One is enough: an ask is a minute. @default 1 */
  readonly concurrency?: number;
}

export interface AskCompositionOptions extends AskRuntimeOptions {
  /**
   * The process's run lease, taken from `StageExecutorOptions.lease` by `createPipelineRuntime`
   * rather than passed separately (WP-48, PROGRESS backlog 120).
   *
   * On **this** interface and not on {@link AskRuntimeOptions}, deliberately: a second optional key
   * on the composition root's own block is a second thing production can omit (standing rule 31),
   * and an ask's run must be held by the same owner string as a stage's — one process, one lease
   * identity. Absent is "this process claims no lease", which leaves an ask's run to the sweep's
   * wall-clock backstop, as every build before WP-48 did.
   */
  readonly lease?: RunLeaseOptions;
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly settings: ProjectSettingsPort;
  readonly stopReasons: RunStopReasons;
  readonly jobs: Jobs;
  readonly ids: { next(): Id };
  readonly clock: { now(): string };
  readonly context: Parameters<typeof createAskExecutor>[0]['context'];
  readonly logger?: Logger;
}

export interface AskComposition {
  readonly handlers: readonly EventHandler[];
  readonly executor: AskExecutor;
  declareQueue(): Promise<void>;
  startWorker(): Promise<JobWorker>;
}

export const composeAsk = (options: AskCompositionOptions): AskComposition => {
  const executor = createAskExecutor({
    unitOfWork: options.unitOfWork,
    asks: options.asks,
    store: options.store,
    runner: options.runner,
    planner: options.planner,
    stopReasons: options.stopReasons,
    jobs: options.jobs,
    settings: async (projectId) => options.settings.forProject(projectId),
    context: options.context,
    redactor: options.redactor,
    askedByLabel: options.askedByLabel,
    ...(options.lease === undefined ? {} : { lease: options.lease }),
    ...(options.budgets === undefined ? {} : { budgets: options.budgets }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });

  return {
    handlers: askHandlers({
      asks: options.asks,
      store: options.store,
      identities: options.identities,
      redactor: options.redactor,
      jobs: options.jobs,
      ids: options.ids,
      clock: options.clock as { now(): never },
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    }),
    executor,
    declareQueue: async () => {
      await options.jobs.defineQueue({
        name: JOB_QUEUES.taskAsk,
        // `stately` per `ask:<id>` — see the queue's own docblock for why the key is the ask and
        // not the task.
        policy: 'stately',
        retryLimit: 2,
        retryDelaySeconds: 30,
        retryBackoff: true,
        // An ask is a run: minutes, not the 15-minute default. Shorter than `stage.execute`'s two
        // hours because its turn limit is 12 and its cap is half a dollar.
        expireInSeconds: 30 * 60,
      });
    },
    startWorker: async () =>
      options.jobs.work<AskExecuteData>({
        queue: JOB_QUEUES.taskAsk,
        handler: async (job) => {
          await executor.execute(job.data);
        },
        concurrency: options.concurrency ?? 1,
      }),
  };
};
