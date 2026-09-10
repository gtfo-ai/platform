/**
 * The pipeline's two background jobs (TD-004).
 *
 * `stage.execute` runs one stage of one task — an agent run, or a gate the platform evaluates
 * itself. `mr.comment.debounce` is BD-007's two-minute batch window for human merge-request
 * comments.
 *
 * ## Why the batch window is a delayed wake-up and not a coalesced job
 *
 * technical/02 asks for "one `task.stage.returned` after a 2-minute debounce per MR". The `Jobs`
 * port has coalescing, and it is the wrong tool: **both** of its modes are leading-edge, so the
 * first comment of a burst would run immediately and bounce the task back to Implementation while
 * the human was still typing the second one. The port refuses `coalesce` together with
 * `startAfter` for exactly this reason.
 *
 * What does work is a `stately` queue plus a singleton key per merge request and a `startAfter` two
 * minutes out: `stately` admits one *queued* job per key, so a burst of comments collapses onto the
 * first one's timer, and the handler re-reads **every unresolved thread** when it fires rather than
 * acting on the comment that scheduled it. If a comment arrived inside the last window, the handler
 * schedules another one instead of returning the task — which is what makes it a real debounce
 * ("wait until they stop") built out of a timer that cannot be cancelled.
 *
 * `coalesced` is a success, not an error: it means the window this comment belongs to is already
 * scheduled.
 */
import type { Id, Slug } from '@platform/contracts';
import { compilePipeline, interpret, isRunnableTaskState, stageOf } from '@platform/domain';
import type { JobHandler, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import { createGateEvaluator, MAX_GATE_CHECKS } from './gates.js';
import { gitReads } from './integrations.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StageExecutionJob, StageExecutor } from './stage-executor.js';
import { applyDecision } from './transitions.js';

/** `stage.execute` payload — snake_case, like every other payload on the wire. */
export interface StageExecuteData {
  readonly task_id: string;
  readonly project_id: string;
  readonly stage: string;
  readonly attempt: number;
  /** How many times a gate has answered "not yet"; absent for an agent stage. */
  readonly gate_checks?: number;
  readonly [key: string]: unknown;
}

export interface ReviewWindowData {
  readonly task_id: string;
  readonly project_id: string;
  readonly iid: number;
  /** The instant the window was opened, so the handler can tell a fresh comment from an old one. */
  readonly opened_at: string;
  readonly [key: string]: unknown;
}

export const declarePipelineQueues = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue({
    name: JOB_QUEUES.stageExecute,
    // TD-004: `stately` per task — at most one queued and one active, so a task never runs two
    // stages at once and a burst of wake-ups collapses.
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
    // A stage is a whole agent run: minutes, not the 15-minute default.
    expireInSeconds: 2 * 60 * 60,
  });
  await jobs.defineQueue({
    name: JOB_QUEUES.mrCommentDebounce,
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
  });
};

/**
 * How long a gate waits before asking again after answering "not yet".
 *
 * It is a `startAfter`, not a sleep, and it is not zero: a gate that re-enqueues itself with no
 * delay spins through {@link MAX_GATE_CHECKS} in a few milliseconds and parks the task for a human
 * before the pipeline it is waiting for has even started. Thirty seconds against a five-check
 * budget gives a CI pipeline two and a half minutes to reach a terminal status before anyone is
 * asked to look at it; the event (`ci.pipeline.finished`) normally arrives long before that and
 * settles the gate without a re-check at all.
 */
export const GATE_RECHECK_MS = 30_000;

export const enqueueStage = async (
  jobs: Jobs,
  job: StageExecutionJob & { readonly gateChecks?: number; readonly startAfter?: Date },
): Promise<void> => {
  await jobs.enqueue<StageExecuteData>({
    queue: JOB_QUEUES.stageExecute,
    singletonKey: `task:${job.taskId}`,
    ...(job.startAfter === undefined ? {} : { startAfter: job.startAfter }),
    data: {
      task_id: job.taskId,
      project_id: job.projectId,
      stage: job.stage,
      attempt: job.attempt,
      ...(job.gateChecks === undefined ? {} : { gate_checks: job.gateChecks }),
    },
  });
};

export const enqueueReviewCommentWindow = async (
  jobs: Jobs,
  input: {
    readonly taskId: Id;
    readonly projectId: Id;
    readonly iid: number;
    readonly windowMs: number;
    readonly now: Date;
  },
): Promise<void> => {
  await jobs.enqueue<ReviewWindowData>({
    queue: JOB_QUEUES.mrCommentDebounce,
    // One window per merge request, whatever the task: the human is commenting on the MR.
    singletonKey: `mr:${input.iid}`,
    startAfter: new Date(input.now.getTime() + input.windowMs),
    data: {
      task_id: input.taskId,
      project_id: input.projectId,
      iid: input.iid,
      opened_at: input.now.toISOString(),
    },
  });
};

export interface PipelineJobOptions extends PipelineSagaOptions {
  readonly unitOfWork: UnitOfWork;
  readonly executor: StageExecutor;
}

/**
 * `stage.execute`: an agent stage runs, a platform gate is evaluated, anything else is skipped.
 *
 * Every path re-validates: the task may have moved on, been paused or been cancelled between the
 * enqueue and the fire, and none of those is an error (TD-004 has no cancel).
 */
export const stageExecuteHandler = (options: PipelineJobOptions): JobHandler<StageExecuteData> => {
  const logger: Logger = options.logger ?? silentLogger;
  const gates = createGateEvaluator(options.integrations);

  return async (job) => {
    const request: StageExecutionJob = {
      taskId: job.data.task_id,
      projectId: job.data.project_id,
      stage: job.data.stage,
      attempt: job.data.attempt,
    };

    const stage = await options.unitOfWork.transaction(async (scope) => {
      const stored = await options.store.tasks.load(scope.tx, request.taskId);
      if (stored === null || stored.task.currentStage !== request.stage) {
        return null;
      }
      return stageOf(compilePipeline(stored.task.template, stored.template), request.stage);
    });

    if (stage === null) {
      logger.debug(
        { task_id: request.taskId, stage: request.stage },
        'stage job found nothing to do',
      );
      return;
    }

    if (stage.kind === 'agent') {
      const outcome = await options.executor.execute(request);
      logger.info(
        { task_id: request.taskId, stage: request.stage, outcome: outcome.kind },
        'stage executed',
      );
      return;
    }

    if (stage.kind !== 'gate') {
      return;
    }

    const stored = await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.load(scope.tx, request.taskId),
    );
    // Not `state === 'active'`: `merged_gate` is entered in the `merged` state, and
    // `ready_for_merge` is its own state too. What disqualifies a gate is the task having stopped
    // — finished, cancelled, paused, parked for a human, or waiting for an answer.
    if (stored === null || !isRunnableTaskState(stored.task.state)) {
      return;
    }
    const result = await gates.evaluate(stage, stored);
    const checks = (job.data.gate_checks ?? 0) + 1;

    if (result.kind === 'pending') {
      if (checks >= MAX_GATE_CHECKS) {
        await settle(options, request, {
          kind: 'escalate',
          reason: `the "${request.stage}" gate could not be decided after ${checks} attempts: ${result.detail}`,
          blockerBrief:
            `The "${request.stage}" gate for this task still has no answer after ${checks} checks (${result.detail}). ` +
            'Look at the merge request or the pipeline yourself, then hand the task back.',
        });
        return;
      }
      // The gate has no answer yet. `stately` frees the queued slot the moment this job starts, so
      // re-enqueuing here is the timer that asks again — delayed, or it is a spin.
      await enqueueStage(options.jobs, {
        ...request,
        gateChecks: checks,
        startAfter: new Date(Date.parse(options.clock.now()) + GATE_RECHECK_MS),
      });
      return;
    }

    if (result.kind === 'unsupported') {
      await settle(options, request, {
        kind: 'escalate',
        reason: result.detail,
        blockerBrief: `The platform cannot evaluate the "${request.stage}" gate: ${result.detail}. Decide it yourself and hand the task back at the stage that should run next.`,
      });
      return;
    }

    await settle(options, request, {
      kind: 'gate_settled',
      stage: request.stage,
      passed: result.passed,
      detail: result.detail,
    });
  };
};

/** Applies a decision from outside a handler: its own transaction, its own follow-up enqueue. */
const settle = async (
  options: PipelineJobOptions,
  request: StageExecutionJob,
  signal:
    | {
        readonly kind: 'gate_settled';
        readonly stage: Slug;
        readonly passed: boolean;
        readonly detail: string;
      }
    | { readonly kind: 'escalate'; readonly reason: string; readonly blockerBrief: string },
): Promise<void> => {
  const work = await options.unitOfWork.transaction(async (scope) => {
    const stored = await options.store.tasks.load(scope.tx, request.taskId);
    if (stored === null || stored.task.currentStage !== request.stage) {
      return null;
    }
    const pipeline = compilePipeline(stored.task.template, stored.template);
    const decision =
      signal.kind === 'escalate'
        ? ({ kind: 'escalate', reason: signal.reason, blockerBrief: signal.blockerBrief } as const)
        : interpret(pipeline, signal);
    const applied = await applyDecision({
      store: options.store,
      pipeline,
      tx: scope.tx,
      stored,
      decision,
      context: {
        ids: options.ids,
        actor: { kind: 'system', component: 'pipeline' },
        clock: options.clock as never,
        correlationId: stored.task.id,
        causeEventId: null,
      },
      causedByEventId: null,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await scope.events.append(applied.events);
    return applied.work;
  });
  if (work !== null) {
    await enqueueStage(options.jobs, work);
  }
};

/**
 * `mr.comment.debounce`: the window closed — read every unresolved thread and act once.
 *
 * Three endings, and the first two are the reason this is not a coalesced job:
 *  - nothing unresolved → nothing to do (a human resolved the threads inside the window);
 *  - a comment arrived inside the window → open another window instead of returning the task;
 *  - otherwise → one `task.stage.returned`, whatever the number of threads.
 */
export const reviewWindowHandler = (options: PipelineJobOptions): JobHandler<ReviewWindowData> => {
  const logger: Logger = options.logger ?? silentLogger;
  const reads = gitReads(options.integrations);

  return async (job) => {
    const windowMs = options.reviewCommentWindowMs ?? 2 * 60_000;
    const stored = await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.load(scope.tx, job.data.task_id),
    );
    if (stored === null || stored.task.state !== 'ready_for_merge' || stored.mr === null) {
      logger.debug({ task_id: job.data.task_id }, 'review window found nothing to do');
      return;
    }

    const discussions = await reads.discussions(stored.mr, {
      projectId: stored.task.projectId,
      taskId: stored.task.id,
    });
    const unresolved = discussions.filter(
      (discussion) =>
        discussion.resolvable &&
        !discussion.resolved &&
        discussion.notes.some((note) => !note.system),
    );
    if (unresolved.length === 0) {
      return;
    }

    const now = new Date(options.clock.now());
    const newest = unresolved
      .flatMap((discussion) => discussion.notes.filter((note) => !note.system))
      .map((note) => Date.parse(note.created_at))
      .reduce((latest, at) => (Number.isNaN(at) ? latest : Math.max(latest, at)), 0);
    if (newest > 0 && now.getTime() - newest < windowMs) {
      // Somebody is still typing. Open another window rather than bouncing the task now: this is
      // the extending half of the debounce, built from a timer that cannot be cancelled.
      await enqueueReviewCommentWindow(options.jobs, {
        taskId: stored.task.id,
        projectId: stored.task.projectId,
        iid: stored.mr.iid,
        windowMs,
        now,
      });
      return;
    }

    const work = await options.unitOfWork.transaction(async (scope) => {
      const current = await options.store.tasks.load(scope.tx, job.data.task_id);
      if (current === null || current.task.state !== 'ready_for_merge') {
        return null;
      }
      const pipeline = compilePipeline(current.task.template, current.template);
      const decision = interpret(pipeline, {
        kind: 'event',
        stage: current.task.currentStage ?? 'ready_for_merge',
        event: 'mr.review.comment',
        detail: `${unresolved.length} unresolved review thread${unresolved.length === 1 ? '' : 's'}`,
      });
      const applied = await applyDecision({
        store: options.store,
        pipeline,
        tx: scope.tx,
        stored: current,
        decision,
        context: {
          ids: options.ids,
          actor: { kind: 'system', component: 'pipeline' },
          clock: options.clock as never,
          correlationId: current.task.id,
          causeEventId: null,
        },
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append(applied.events);
      return applied.work;
    });
    if (work !== null) {
      await enqueueStage(options.jobs, work);
    }
  };
};
