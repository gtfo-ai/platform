/**
 * The `stage.execute` enqueue and the two delays a run's follow-on wake-up waits — moved out of
 * `./jobs.ts` at WP-275a so that `settleRun` (`./settle.ts`), which enqueues a start failure's
 * retry and a hand-back's re-run **after its commit** (TD-031's 2026-11-04 amendment §1), reaches
 * them without importing the job handlers that import it.
 */
import type { EnqueueResult, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { StageExecuteData } from './jobs.js';
import type { StageExecutionJob } from './stage-executor.js';

/**
 * How long a stage waits before trying to *start* a run again after a transport failure (Q59(a)).
 *
 * The same thirty seconds as {@link GATE_RECHECK_MS}, and for the same reason: a re-enqueue with no
 * delay spins through {@link MAX_RUN_START_ATTEMPTS} in milliseconds and escalates the task before
 * the launcher it is waiting for has finished restarting. Three attempts at this delay is the whole
 * bound — about a minute of flapping absorbed, and a launcher that is down parks the task about a
 * minute later instead of never.
 */
export const RUN_START_RETRY_MS = 30_000;

/**
 * How long a handed-back stage waits before its run is started again (WP-144 ruling (a)).
 *
 * Thirty seconds, {@link RUN_START_RETRY_MS}'s: long enough for the stopped `runner` to have exited
 * and for compose (or the operator) to have started it again, short enough that a restart costs the
 * task half a minute. Any process subscribed to `stage.execute` may take it — the job is durable.
 */
export const SHUTDOWN_HAND_BACK_DELAY_MS = 30_000;

export const enqueueStage = async (
  jobs: Jobs,
  job: StageExecutionJob & {
    readonly gateChecks?: number;
    readonly startAfter?: Date;
    /** Backlog 490: a gate's provider outage, carried from one failed read to the next. */
    readonly providerOutage?: { readonly since: string; readonly failures: number };
  },
): Promise<EnqueueResult> =>
  jobs.enqueue<StageExecuteData>({
    queue: JOB_QUEUES.stageExecute,
    singletonKey: `task:${job.taskId}`,
    ...(job.startAfter === undefined ? {} : { startAfter: job.startAfter }),
    data: {
      task_id: job.taskId,
      project_id: job.projectId,
      stage: job.stage,
      attempt: job.attempt,
      ...(job.gateChecks === undefined ? {} : { gate_checks: job.gateChecks }),
      ...(job.providerOutage === undefined
        ? {}
        : {
            provider_failing_since: job.providerOutage.since,
            provider_failures: job.providerOutage.failures,
          }),
      ...(job.overrides?.model === undefined ? {} : { model: job.overrides.model }),
      ...(job.overrides?.effort === undefined ? {} : { effort: job.overrides.effort }),
    },
  });
