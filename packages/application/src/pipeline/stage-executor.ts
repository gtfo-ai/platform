/**
 * The stage executor — product/04's "Run": one execution of an agent stage.
 *
 * It is driven by the `stage.execute` job (TD-004, `stately` per task), never by an event handler,
 * for one reason: a run takes minutes and an event handler holds a database transaction. The shape
 * is therefore **transaction, no transaction, transaction**:
 *
 * ```
 * tx  1   load the task, re-validate, check the budget, create the Run  → run.created, run.started
 * ——      start the runner and await its outcome                        (minutes; no connection held)
 * tx  2   store the artifact and the outcome                            → run.finished | run.failed,
 *                                                                          artifact.created,
 *                                                                          task.stage.completed
 * ```
 *
 * Neither transaction is nested and neither is open while the run is. The job worker's own
 * concurrency is therefore **additive** to the dispatcher's `2 × concurrency + 1` pool floor rather
 * than covered by it — see {@link StageExecutorOptions.concurrency}.
 *
 * ## Re-validation, because the enqueue is not in the handler's transaction
 *
 * The job that brought us here was enqueued *after* the handler that decided to run this stage
 * committed, and the port has no cancel (TD-004: "every timer job re-validates state when it
 * fires"). So the first thing tx 1 does is check that the task still exists, is still `active`, is
 * still at this stage and is still on this attempt. Finding nothing to do is a **success**: a
 * duplicate wake-up, a task a human paused in the meantime, and a stage that has already moved on
 * all land here, and none of them is an error.
 *
 * ## `budget_exceeded` is two different endings
 *
 * WP-12 stops a run whose result carried no usable `total_cost_usd` with status `budget_exceeded`
 * and terminal reason `error_max_budget_usd`, because `RunTerminalReason` is a closed contract with
 * no name for the fault — and it carries the distinct name in the `run_stopped` transcript row's
 * `data.reason`. A blind stop is **not** an overspend, and the two need different endings: an
 * overspend pauses the task so a human can raise the cap (product/09), while a CLI that stopped
 * reporting what it spent is a fault that escalates. This module therefore branches on
 * `data.reason` from the transcript — the structured field — rather than on the status, or on a
 * substring of the human-readable `error`. The runner takes one sink for every run it drives, so
 * the reason arrives through {@link RunStopReasons} rather than through a sink this module wraps.
 */
import type { ArtifactRef, DomainEvent, Id, JsonValue, Slug } from '@platform/contracts';
import type { CommandContext, PipelineStage, Run } from '@platform/domain';
import {
  askQuestion,
  compilePipeline,
  completeStage,
  createRun,
  DEFAULT_STAGE_RUN_BUDGET_USD,
  escalateTask,
  failRun,
  finishRun,
  isRunnableTaskState,
  markRunning,
  openQuestion,
  pauseTask,
  recordArtifact,
  stageOf,
  startRun,
  toQuestionRecord,
} from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { ClaudeRunner, RunOutcome, RunSpec } from '../ports/runner.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import type { ProjectSettings } from './settings.js';
import type { RunStopReasons } from './stop-reasons.js';
import type { PipelineStore, StoredArtifact, StoredTask } from './store.js';
import { artifactQuestions, rawVerdict, stageVerdict } from './verdicts.js';

export interface StageRunRequest {
  readonly runId: Id;
  readonly stage: PipelineStage;
  readonly attempt: number;
  readonly task: StoredTask;
  readonly artifacts: readonly StoredArtifact[];
  readonly settings: ProjectSettings;
  /** Why the task came back to this stage, when it did (`task.stage.returned.reason`). */
  readonly returnFeedback: string | null;
}

/**
 * Builds the `RunSpec` for one stage.
 *
 * A port rather than a function, because everything interesting about a spec belongs to other work
 * packages: the prompt layers are WP-17, the context pack is WP-16 and the workspace is WP-14.
 * `basicStageRunPlanner` (`./planner.js`) is the shipped implementation until they land.
 */
export interface StageRunPlanner {
  plan(request: StageRunRequest): Promise<RunSpec>;
}

export type StageExecutionOutcome =
  /** The run happened and its result has been recorded. */
  | { readonly kind: 'ran'; readonly runId: Id; readonly verdict: string | null }
  /** Nothing to do: the task moved on, was paused, or the job is a duplicate. */
  | { readonly kind: 'skipped'; readonly reason: string }
  /** A budget stopped it; the task is `paused` and a human may raise the cap. */
  | { readonly kind: 'paused'; readonly reason: string }
  /** The run ended without a usable result; the pipeline escalates on the event. */
  | { readonly kind: 'failed'; readonly runId: Id; readonly reason: string };

export interface StageExecutorOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly runner: ClaudeRunner;
  readonly planner: StageRunPlanner;
  /** Where `run_stopped.data.reason` comes from; see `./stop-reasons.js`. */
  readonly stopReasons: RunStopReasons;
  /** A fresh `CommandContext` per command: ids, clock and the pipeline's system actor. */
  readonly context: (correlationId: Id) => CommandContext;
  readonly settings: (projectId: Id) => Promise<ProjectSettings>;
  readonly logger?: Logger;
  /**
   * How many stages this process runs at once. Stated here because it is a **pool** number: each
   * concurrent execution holds one connection during each of its two transactions, on top of the
   * dispatcher's `2 × concurrency + 1`. A composition root that raises this and not
   * `APP_DB_POOL_MAX` gets a pipeline that stalls waiting for connections it is holding itself.
   */
  readonly concurrency?: number;
}

export interface StageExecutionJob {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly stage: Slug;
  readonly attempt: number;
}

export interface StageExecutor {
  execute(job: StageExecutionJob): Promise<StageExecutionOutcome>;
}

/** The name WP-12 puts on `run_stopped.data.reason` when the CLI reported no usable cost. */
export const COST_UNREPORTED = 'cost_unreported';

/** Per-run cap: the project's `stages.<id>.budget_usd`, else product/04's table (BD-013). */
export const runBudgetUsd = (settings: ProjectSettings, stage: Slug): number =>
  settings.config.stages?.[stage]?.budget_usd ?? DEFAULT_STAGE_RUN_BUDGET_USD[stage] ?? 5;

/**
 * Has the task spent its cap? product/09: the task scope "pauses the task rather than blocking
 * silently, and a human may raise the cap".
 *
 * The comparison adds what *this* run may spend to what the task has already spent, because a
 * budget checked only against past spend is a budget discovered one run too late.
 */
export const taskBudgetExhausted = (
  stored: StoredTask,
  settings: ProjectSettings,
  stage: Slug,
): boolean => stored.costActualUsd + runBudgetUsd(settings, stage) > settings.taskBudgetUsd;

type Prepared =
  | { readonly kind: 'skipped'; readonly reason: string }
  | { readonly kind: 'paused'; readonly reason: string }
  | {
      readonly kind: 'ready';
      readonly spec: RunSpec;
      readonly stage: PipelineStage;
      readonly stored: StoredTask;
      readonly run: Run;
    };

export const createStageExecutor = (options: StageExecutorOptions): StageExecutor => {
  const { unitOfWork, store, runner, planner, stopReasons } = options;
  const logger = options.logger ?? silentLogger;

  const prepare = async (job: StageExecutionJob, settings: ProjectSettings): Promise<Prepared> =>
    unitOfWork.transaction(async (scope): Promise<Prepared> => {
      const stored = await store.tasks.load(scope.tx, job.taskId);
      if (stored === null) {
        return { kind: 'skipped', reason: 'the task no longer exists' };
      }
      const { task } = stored;
      // Not `state === 'active'`: the retrospective runs in the `retro` state. What disqualifies a
      // run is the task having stopped — paused, parked for a human, waiting, or finished.
      if (!isRunnableTaskState(task.state) || task.currentStage !== job.stage) {
        return {
          kind: 'skipped',
          reason: `the task is "${task.state}" at "${task.currentStage ?? 'no stage'}", not running at "${job.stage}"`,
        };
      }
      if ((task.stageAttempts[job.stage] ?? 0) !== job.attempt) {
        return {
          kind: 'skipped',
          reason: `attempt ${job.attempt} of "${job.stage}" has been superseded by attempt ${task.stageAttempts[job.stage] ?? 0}`,
        };
      }
      const stage = stageOf(compilePipeline(task.template, stored.template), job.stage);
      if (stage === null || stage.kind !== 'agent' || stage.role === null) {
        return {
          kind: 'skipped',
          reason: `"${job.stage}" is not an agent stage of template "${task.template}"`,
        };
      }

      if (taskBudgetExhausted(stored, settings, job.stage)) {
        const decision = pauseTask(task, { reason: 'budget' }, options.context(task.id));
        await store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
        await scope.events.append(decision.events);
        return {
          kind: 'paused',
          reason:
            `the task has spent ${stored.costActualUsd} USD of its ${settings.taskBudgetUsd} USD cap ` +
            `and "${job.stage}" may spend ${runBudgetUsd(settings, job.stage)} more`,
        };
      }

      const context = options.context(task.id);
      const runId = context.ids.next();
      const artifacts = await store.artifacts.listFor(scope.tx, task.id);
      const spec = await planner.plan({
        runId,
        stage,
        attempt: job.attempt,
        task: stored,
        artifacts,
        settings,
        returnFeedback: await store.tasks.lastReturnReason(scope.tx, task.id, job.stage),
      });

      // `created → starting → running`: two transitions, two catalogue events, and no observable
      // moment between them here — the platform has the spec and is handing it to the runner. The
      // states exist for the runner's own lifecycle (technical/02), not for this seam.
      const created = createRun({
        id: runId,
        taskId: task.id,
        projectId: task.projectId,
        stage: job.stage,
        role: stage.role,
        mode: task.mode === 'shadow' ? 'shadow' : 'normal',
        attempt: job.attempt,
        model: spec.model,
        effort: spec.effort,
        promptVersion: spec.promptVersion,
      });
      const starting = startRun(created, context);
      const running = markRunning(
        starting.aggregate,
        {
          contextPack: {
            tier0: [],
            tier1: [],
            budget_tokens: 0,
            total_tokens: 0,
            kb_commit: null,
          },
        },
        context,
      );
      await store.runs.insert(scope.tx, {
        id: runId,
        taskId: task.id,
        projectId: task.projectId,
        stage: job.stage,
        role: stage.role,
        mode: created.mode,
        attempt: job.attempt,
        model: spec.model,
        effort: spec.effort,
        promptVersion: spec.promptVersion,
        status: running.aggregate.status,
        terminalReason: null,
        sessionId: null,
        numTurns: 0,
        usage: null,
        cost: null,
        wallMs: 0,
        createdAt: context.clock.now(),
      });
      await scope.events.append([...starting.events, ...running.events]);
      return { kind: 'ready', spec, stage, stored, run: running.aggregate };
    });

  return {
    execute: async (job) => {
      const settings = await options.settings(job.projectId);
      const prepared = await prepare(job, settings);
      if (prepared.kind !== 'ready') {
        logger.info(
          {
            task_id: job.taskId,
            stage: job.stage,
            outcome: prepared.kind,
            reason: prepared.reason,
          },
          'stage execution did not start',
        );
        return prepared;
      }

      const handle = runner.start(prepared.spec);
      const outcome = await handle.outcome;
      const stopReason = stopReasons.reasonFor(prepared.spec.runId);
      stopReasons.forget(prepared.spec.runId);

      return unitOfWork.transaction(async (scope) =>
        record(scope, {
          job,
          settings,
          stage: prepared.stage,
          run: prepared.run,
          outcome,
          stopReason,
          options,
        }),
      );
    },
  };
};

interface RecordInput {
  readonly job: StageExecutionJob;
  readonly settings: ProjectSettings;
  readonly stage: PipelineStage;
  readonly run: Run;
  readonly outcome: RunOutcome;
  readonly stopReason: string | null;
  readonly options: StageExecutorOptions;
}

/**
 * Transaction 2: everything the run produced, written once.
 *
 * The artifact, the run's terminal event, the task's spend and `task.stage.completed` all commit
 * together — a partial write here would leave a task whose stage completed but whose artifact is
 * missing, and the interpreter would then transition on an artifact nobody can read.
 */
const record = async (
  scope: TransactionScope,
  input: RecordInput,
): Promise<StageExecutionOutcome> => {
  const { options, outcome, run, stage, job } = input;
  const { store } = options;
  const stored = await store.tasks.load(scope.tx, job.taskId);
  if (stored === null) {
    return { kind: 'skipped', reason: 'the task was deleted while its stage was running' };
  }
  const context = options.context(job.taskId);

  const spent = Number.isFinite(outcome.cost.usd) ? Math.max(0, outcome.cost.usd) : 0;
  const withCost: StoredTask = { ...stored, costActualUsd: stored.costActualUsd + spent };

  if (outcome.status !== 'completed') {
    return recordUnsuccessful(scope, input, withCost, context);
  }

  const finished = finishRun(
    run,
    {
      status: 'completed',
      terminalReason: outcome.terminalReason,
      usage: outcome.usage,
      modelUsage: outcome.modelUsage,
      cost: outcome.cost,
      numTurns: outcome.numTurns,
    },
    context,
  );
  await store.runs.finish(scope.tx, {
    runId: run.id,
    status: 'completed',
    terminalReason: outcome.terminalReason,
    sessionId: outcome.sessionId,
    numTurns: outcome.numTurns,
    usage: outcome.usage,
    cost: outcome.cost,
    wallMs: outcome.wallMs,
  });

  const events: DomainEvent[] = [...finished.events];
  let artifactRef: ArtifactRef | null = null;
  let data: JsonValue | null = null;
  let task = withCost.task;

  if (stage.produces !== null) {
    if (outcome.structuredOutput === null) {
      // The runner re-validates structured output against the artifact schema and reports
      // `error_max_structured_output_retries` when it never arrived; there is nothing to store and
      // nothing to transition on.
      return escalateOnRun(scope, input, withCost, context, 'the run produced no artifact', [
        ...finished.events,
      ]);
    }
    data = outcome.structuredOutput;
    const version = await store.artifacts.nextVersion(scope.tx, job.taskId, stage.produces);
    const artifactId = context.ids.next();
    await store.artifacts.insert(scope.tx, {
      id: artifactId,
      taskId: job.taskId,
      type: stage.produces,
      version,
      markdown: null,
      data,
      schemaVersion: '1',
      producedByRunId: run.id,
      createdAt: context.clock.now(),
    });
    artifactRef = { id: artifactId, artifact_type: stage.produces, version, url: null };
    const recorded = recordArtifact(
      task,
      { artifact: artifactRef, producedByRunId: run.id },
      context,
    );
    task = recorded.aggregate;
    events.push(...recorded.events);
  }

  const verdictInput = {
    artifactType: stage.produces,
    data,
    attemptOnLowConfidence: false,
  };
  // A verdict the platform cannot map is still passed through, capped: the interpreter escalates
  // on it either way, and "the stage said `ship it`" is a far better blocker brief than "the stage
  // said nothing".
  const verdict = stageVerdict(verdictInput) ?? rawVerdict(verdictInput);

  const completed = completeStage(
    task,
    {
      stage: job.stage,
      artifacts: artifactRef === null ? [] : [artifactRef],
      ...(verdict === null ? {} : { verdict }),
    },
    context,
  );
  events.push(...completed.events);
  task = completed.aggregate;

  const questions =
    verdict === 'questions' ? artifactQuestions(data).filter((draft) => draft.blocking) : [];
  for (const draft of questions) {
    const question = openQuestion(
      {
        id: context.ids.next(),
        taskId: job.taskId,
        projectId: stored.task.projectId,
        stage: job.stage,
        runId: run.id,
        text: draft.text,
        blocking: true,
        ...(draft.options === null ? {} : { options: draft.options }),
      },
      context,
    );
    await store.questions.insert(scope.tx, question);
    const asked = askQuestion(task, { question: toQuestionRecord(question) }, context);
    task = asked.aggregate;
    events.push(...asked.events);
  }

  await store.tasks.save(scope.tx, { ...withCost, task });
  await store.tasks.recordStageExited(scope.tx, {
    taskId: job.taskId,
    stage: job.stage,
    attempt: job.attempt,
    outcome: verdict ?? 'unknown',
    returnReason: null,
  });
  await scope.events.append(events);
  return { kind: 'ran', runId: run.id, verdict };
};

/** A run that did not complete: budget, fault, timeout, stall or cancellation. */
const recordUnsuccessful = async (
  scope: TransactionScope,
  input: RecordInput,
  stored: StoredTask,
  context: CommandContext,
): Promise<StageExecutionOutcome> => {
  const { options, outcome, run } = input;
  const { store } = options;

  const costUnreported = input.stopReason === COST_UNREPORTED;
  const overspent = outcome.status === 'budget_exceeded' && !costUnreported;

  const decision =
    outcome.status === 'failed' || outcome.status === 'stalled'
      ? failRun(
          run,
          {
            status: outcome.status,
            terminalReason: outcome.terminalReason,
            error: outcome.error ?? outcome.terminalReason,
            usage: outcome.usage,
            cost: outcome.cost,
          },
          context,
        )
      : finishRun(
          run,
          {
            status: outcome.status,
            terminalReason: outcome.terminalReason,
            usage: outcome.usage,
            modelUsage: outcome.modelUsage,
            cost: outcome.cost,
            numTurns: outcome.numTurns,
          },
          context,
        );

  await store.runs.finish(scope.tx, {
    runId: run.id,
    status: outcome.status,
    terminalReason: outcome.terminalReason,
    sessionId: outcome.sessionId,
    numTurns: outcome.numTurns,
    usage: outcome.usage,
    cost: outcome.cost,
    wallMs: outcome.wallMs,
  });

  if (overspent) {
    // BD-010: a task budget pauses the task; a human may raise the cap and resume it.
    const paused = pauseTask(stored.task, { reason: 'budget' }, context);
    await store.tasks.save(scope.tx, { ...stored, task: paused.aggregate });
    await scope.events.append([...decision.events, ...paused.events]);
    return {
      kind: 'paused',
      reason: `the run stopped at its ${outcome.terminalReason} cap`,
    };
  }

  const reason = costUnreported
    ? 'the platform could not tell what the run cost, so it stopped it without verifying the budget'
    : `the run ended as ${outcome.status} (${outcome.terminalReason})`;
  return escalateOnRun(scope, input, stored, context, reason, decision.events);
};

/**
 * Ends the stage without a verdict. The pipeline's `run.failed` handler is *not* what escalates —
 * the task is parked here, in the same transaction that recorded the run, so there is no window in
 * which a task looks `active` at a stage that has already stopped.
 */
const escalateOnRun = async (
  scope: TransactionScope,
  input: RecordInput,
  stored: StoredTask,
  context: CommandContext,
  reason: string,
  runEvents: readonly DomainEvent[] = [],
): Promise<StageExecutionOutcome> => {
  const { options, run } = input;
  const { job } = input;
  const escalated = escalate(stored, context, job.stage, reason);
  await options.store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
  await options.store.tasks.recordStageExited(scope.tx, {
    taskId: job.taskId,
    stage: job.stage,
    attempt: job.attempt,
    outcome: 'failed',
    returnReason: reason,
  });
  await scope.events.append([...runEvents, ...escalated.events]);
  return { kind: 'failed', runId: run.id, reason };
};

const escalate = (stored: StoredTask, context: CommandContext, stage: Slug, reason: string) =>
  escalateTask(
    stored.task,
    {
      reason: `stage "${stage}": ${reason}`,
      blockerBrief:
        `The "${stage}" stage of ${stored.task.ticket.key} stopped without a result: ${reason}. ` +
        "Nothing is retried automatically. Open the run's transcript, decide what should change, " +
        'and hand the task back at the stage you want it to resume from.',
    },
    context,
  );
