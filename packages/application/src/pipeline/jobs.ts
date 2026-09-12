/**
 * The pipeline's background jobs (TD-004) — the queue names, the payloads and two of the handlers.
 *
 * `stage.execute` runs one stage of one task — an agent run, or a gate the platform evaluates
 * itself. `mr.comment.debounce` is BD-007's two-minute batch window for human merge-request
 * comments. `pipeline.outbound` is every provider call an event handler decided on (WP-15d); its
 * handler lives in `outbound.ts`, because it routes to duties this file must not depend on.
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
import { gitReads, integrationsForProject, noRunScopedSecrets } from './integrations.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StageExecutionJob, StageExecutor } from './stage-executor.js';
import { ensureTicketSnapshot } from './ticket-snapshot.js';
import { applyDecision } from './transitions.js';

/** `stage.execute` payload — snake_case, like every other payload on the wire. */
export interface StageExecuteData {
  readonly task_id: string;
  readonly project_id: string;
  readonly stage: string;
  readonly attempt: number;
  /** How many times a gate has answered "not yet"; absent for an agent stage. */
  readonly gate_checks?: number;
  /**
   * How many times this stage's run failed to **start** for a transport reason (Q59(a), WP-15g).
   *
   * Absent for the ordinary first wake-up. It rides the payload rather than living in the executor
   * because the process that retries may not be the one that failed, and a counter a restart forgets
   * is an unbounded retry — the same reasoning as `gate_checks` two lines up.
   */
  readonly start_attempts?: number;
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

/**
 * One outbound duty: a provider call an event handler decided on and did not make (WP-15d).
 *
 * snake_case, like every other payload on the wire (CLAUDE.md). It carries **ids and the event's
 * own text**, never a resolved binding or a credential: the job re-reads the task and re-resolves
 * the project's bindings when it fires, because a job is a wake-up and not a message
 * (TD-004: "re-validate on fire").
 */
export interface PipelineOutboundData {
  readonly duty: 'intake_check' | 'workpad' | 'status';
  readonly project_id: string;
  /** Absent for `intake_check`, which runs before there is a task. */
  readonly task_id?: string;
  /** The event that caused the wake-up: the replay identity of a ticket write, and the cause id. */
  readonly cause_event_id: string;
  /** `intake_check` only — `ticket.matched`'s payload, which no row holds until the task exists. */
  readonly ticket?: {
    readonly provider: string;
    readonly key: string;
    readonly url: string;
  };
  readonly issue_type?: string | null;
  readonly priority?: string | null;
  /** `workpad` only: the brief lives on the event, not on the task row. */
  readonly blocker_brief?: string;
  /**
   * `status` only: the provider's own status name the handler mapped this event to.
   *
   * Decided by the handler rather than re-derived when the job fires, because a transition is a
   * movement and the board owes a human every move in order; see `statusMappingHandler`.
   */
  readonly status?: string;
  readonly [key: string]: unknown;
}

/**
 * The only way a handler asks for a provider call.
 *
 * Always from `HandlerContext.afterCommit`: `Jobs.enqueue` does not join the handler's transaction
 * (TD-004), so an enqueue written inline would be durable even when the decision that caused it
 * rolled back. The consequence — a crash between the commit and the callback loses the wake-up —
 * is the at-most-once residual `afterCommit` documents, and it is why every duty here re-derives
 * what it should do from committed state rather than trusting the payload.
 */
export const enqueueOutbound = async (jobs: Jobs, data: PipelineOutboundData): Promise<void> => {
  await jobs.enqueue<PipelineOutboundData>({ queue: JOB_QUEUES.pipelineOutbound, data });
};

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
  await jobs.defineQueue({
    name: JOB_QUEUES.pipelineOutbound,
    // `standard`, not `stately`: see `JOB_QUEUES.pipelineOutbound`. A dropped wake-up would take
    // the event's blocker brief with it, and that is the one thing a render cannot re-derive.
    policy: 'standard',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
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
      ...(job.startAttempts === undefined ? {} : { start_attempts: job.startAttempts }),
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
      ...(job.data.start_attempts === undefined ? {} : { startAttempts: job.data.start_attempts }),
    };

    // The task travels out of the transaction beside the stage it resolved, because the next step
    // needs it: `ensureTicketSnapshot` asks one question of the row this load already has, and
    // re-loading it would be a second transaction per agent stage for a field in hand (WP-15f,
    // review round 1).
    const admitted = await options.unitOfWork.transaction(async (scope) => {
      const stored = await options.store.tasks.load(scope.tx, request.taskId);
      if (stored === null || stored.task.currentStage !== request.stage) {
        return null;
      }
      return {
        stage: stageOf(compilePipeline(stored.task.template, stored.template), request.stage),
        stored,
      };
    });

    const stage = admitted?.stage ?? null;
    if (admitted === null || stage === null) {
      logger.debug(
        { task_id: request.taskId, stage: request.stage },
        'stage job found nothing to do',
      );
      return;
    }

    if (stage.kind === 'agent') {
      /**
       * **The ticket's own words, if this task still has none** (WP-15f).
       *
       * Here, between the transactions and before the executor, because this is the last moment
       * that is ordered with respect to the prompt: `planner.plan` reads `StoredTask` and
       * `assemblePrompt` renders it. It is the self-healing half: a task whose intake fetch failed,
       * one created before migration 0015, or one whose project gained a task-management binding
       * afterwards gets the text here instead.
       *
       * The task is handed in rather than re-loaded, so the ordinary path really is **one
       * already-loaded field** — the sentence used to say that while the function opened a second
       * transaction per agent stage to re-read the row this handler had just discarded.
       *
       * It never throws for a provider failure and never fails the stage: a run without the ticket
       * text is worse than one with it and far better than none (standing rule 20). A
       * `TransactionOpenError` **does** come out, because that is a programming error rather than a
       * provider being down.
       */
      await ensureTicketSnapshot(options, admitted.stored);
      const outcome = await options.executor.execute(request);
      /**
       * **A run that could not be *started* for a transport reason is re-enqueued here** (Q59(a)).
       *
       * The executor failed the `runs` row and left the task exactly where it was, so this is the
       * wake-up that owes it another attempt. It is an `enqueue` and not a `throw`: throwing would
       * hand the job to pg-boss's own retry policy, whose count this payload cannot see and whose
       * exhaustion is a dead letter no screen shows — which is the failure WP-15c closed. The bound
       * travels in the payload, and the escalation at the end of it is the executor's.
       *
       * `stately` frees the queued slot the moment this job starts, so this enqueue is admitted;
       * the delay is what stops it from becoming a spin.
       */
      if (outcome.kind === 'retry') {
        await enqueueStage(options.jobs, {
          ...request,
          startAttempts: outcome.startAttempts,
          startAfter: new Date(Date.parse(options.clock.now()) + RUN_START_RETRY_MS),
        });
      }
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

  return async (job) => {
    const windowMs = options.reviewCommentWindowMs ?? 2 * 60_000;
    const stored = await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.load(scope.tx, job.data.task_id),
    );
    if (stored === null || stored.task.state !== 'ready_for_merge' || stored.mr === null) {
      logger.debug({ task_id: job.data.task_id }, 'review window found nothing to do');
      return;
    }

    // The window closes outside any run, so the call's scope holds no minted credential (Q55).
    const reads = gitReads(
      await integrationsForProject(
        options.integrations,
        stored.task.projectId,
        noRunScopedSecrets(),
      ),
    );
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
