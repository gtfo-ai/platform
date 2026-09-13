/**
 * Turning a {@link PipelineDecision} into aggregate commands, events and follow-up work.
 *
 * The interpreter decides *what* should happen; this decides *how the task records it*. The split
 * matters because the two have different failure modes: the interpreter is pure and total, while
 * every command here can refuse — `assertTaskTransition` rejects a move the state machine does not
 * have — and a refusal must not become a poisoned event.
 *
 * ## Which command a stage entry becomes
 *
 * product/04's task states are not one per stage: most stages are `active`, and five of them are
 * their own state (`ready_for_merge`, `merged`, `retro` — which both `retrospective` and
 * `librarian` run in — and `done`). The mapping is by stage id,
 * which is why those four ids are reserved in `BUILTIN_STAGE_IDS` — a template that renames
 * `ready_for_merge` gets a task that stays `active` through the human wait, and the board would
 * show it as running.
 *
 * ## What happens when the template and the state machine disagree
 *
 * An `IllegalTransitionError` here means the pipeline asked for a move technical/02's table does
 * not have — a hand-edited template that jumps from `merged_gate` to `done` with no retrospective,
 * say. Letting it throw would fail the handler, and the dispatcher would retry it for ever behind
 * its stream (there is no dead-letter state, WP-04's note). So it is caught and turned into an
 * escalation, which is the same ending every other unrecoverable pipeline state has: the task is
 * parked in `Needs human` with a brief, and its stream keeps moving.
 */
import type { DomainEvent, Id, Slug } from '@platform/contracts';
import type { CommandContext, CompiledPipeline, PipelineDecision, Task } from '@platform/domain';
import {
  completeStage,
  completeTask,
  enterStage,
  escalateTask,
  IllegalTransitionError,
  LIBRARIAN_STAGE,
  MERGED_GATE_STAGE,
  markReadyForMerge,
  READY_FOR_MERGE_STAGE,
  RETROSPECTIVE_STAGE,
  recordMerge,
  returnToStage,
  stageOf,
  startLibrarianCuration,
  startRetrospective,
} from '@platform/domain';
import type { Logger } from '../ports/logger.js';
import type { StageExecutionJob } from './stage-executor.js';
import type { PipelineStore, StoredTask } from './store.js';

/** The stage id a `system` stage uses to mean "the pipeline is over". */
export const DONE_STAGE = 'done' as const;

export interface AppliedDecision {
  readonly stored: StoredTask;
  readonly events: readonly DomainEvent[];
  /**
   * Work to enqueue **after the transaction commits** — an agent stage to run or a gate to
   * evaluate. Never enqueued inline: see `HandlerContext.afterCommit`.
   */
  readonly work: StageExecutionJob | null;
}

const totalsOf = async (options: ApplyOptions) => {
  const totals = await options.store.runs.totalsFor(options.tx, options.stored.task.id);
  return {
    cost_usd: totals.costUsd,
    is_estimate: totals.isEstimate,
    runs: totals.runs,
    wall_ms: totals.wallMs,
  };
};

/** Entering these stages is a state change of its own (product/04 § "Task states"). */
const enterCommand = (
  stage: Slug,
):
  | ((task: Task, context: CommandContext) => { aggregate: Task; events: readonly DomainEvent[] })
  | null => {
  switch (stage) {
    case READY_FOR_MERGE_STAGE:
      return markReadyForMerge;
    case MERGED_GATE_STAGE:
      return recordMerge;
    case RETROSPECTIVE_STAGE:
      return startRetrospective;
    case LIBRARIAN_STAGE:
      // WP-18b: the second stage of the retrospective phase. It keeps the task in `retro` — the
      // default `enterStage` would set `active`, which `retro` has no edge to, so every task would
      // escalate one stage short of `done`.
      return startLibrarianCuration;
    default:
      return null;
  }
};

export interface ApplyOptions {
  readonly store: PipelineStore;
  /** The task's own template, compiled: what decides whether an entered stage needs a job. */
  readonly pipeline: CompiledPipeline;
  readonly tx: import('../ports/transaction.js').Transaction;
  readonly stored: StoredTask;
  readonly decision: PipelineDecision;
  readonly context: CommandContext;
  readonly causedByEventId: Id | null;
  readonly logger?: Logger;
}

/**
 * Applies one decision to the task: commands, events, `task_stages` bookkeeping and the follow-up
 * job. Everything it writes goes through the transaction it was handed.
 */
export const applyDecision = async (options: ApplyOptions): Promise<AppliedDecision> => {
  try {
    return await apply(options);
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) {
      throw error;
    }
    return applyEscalation(
      options,
      `the pipeline asked for a transition the task's state machine does not have: ${error.message}`,
      `The pipeline tried to move ${options.stored.task.ticket.key} in a way its state machine does not allow (${error.message}). This is a template that does not match the platform's task states. Fix the template, then hand the task back.`,
    );
  }
};

const applyEscalation = async (
  options: ApplyOptions,
  reason: string,
  blockerBrief: string,
): Promise<AppliedDecision> => {
  const { stored, context, logger } = options;
  try {
    const escalated = escalateTask(stored.task, { reason, blockerBrief }, context);
    // The saved snapshot, not the one that went in: `save` advances `tasks.version`, and the
    // caller may write the task again in this same transaction (WP-15e).
    const saved = await options.store.tasks.save(options.tx, {
      ...stored,
      task: escalated.aggregate,
    });
    return { stored: saved, events: escalated.events, work: null };
  } catch (error) {
    if (!(error instanceof IllegalTransitionError)) {
      throw error;
    }
    // A finished task cannot be escalated, and there is nothing left to record on it. Consuming
    // the event is the only ending that does not park it in the queue for ever.
    logger?.warn(
      { task_id: stored.task.id, state: stored.task.state, reason },
      'a pipeline decision arrived for a task that has already finished; ignoring it',
    );
    return { stored, events: [], work: null };
  }
};

const apply = async (options: ApplyOptions): Promise<AppliedDecision> => {
  const { decision, stored, context, store, tx } = options;
  switch (decision.kind) {
    case 'wait':
      return { stored, events: [], work: null };

    case 'escalate':
      return applyEscalation(options, decision.reason, decision.blockerBrief);

    case 'complete': {
      const finished = completeTask(
        stored.task,
        { outcome: 'completed', totals: await totalsOf(options) },
        context,
      );
      const next = { ...stored, task: finished.aggregate };
      return { stored: await store.tasks.save(tx, next), events: finished.events, work: null };
    }

    case 'return': {
      const returned = returnToStage(
        stored.task,
        {
          fromStage: decision.from,
          toStage: decision.to,
          loop: decision.loop,
          reason: decision.reason,
          escalationBrief: decision.escalationBrief,
        },
        context,
      );
      await store.tasks.recordStageExited(tx, {
        taskId: stored.task.id,
        stage: decision.from,
        attempt: stored.task.stageAttempts[decision.from] ?? 1,
        outcome: 'returned',
        returnReason: decision.reason,
      });
      if (returned.aggregate.state !== 'returned') {
        // `returnToStage` escalated instead: the loop is spent (BD-008). The counter stays where
        // it is, which is what makes "counters never exceed their limits" true.
        const next = { ...stored, task: returned.aggregate };
        return { stored: await store.tasks.save(tx, next), events: returned.events, work: null };
      }
      const entered = await enter(
        { ...options, stored: { ...stored, task: returned.aggregate } },
        decision.to,
      );
      return {
        stored: entered.stored,
        events: [...returned.events, ...entered.events],
        work: entered.work,
      };
    }

    case 'enter':
      return enter(options, decision.stage);
  }
};

/** Enters a stage, choosing the command its id implies and scheduling whatever it needs. */
const enter = async (options: ApplyOptions, stage: Slug): Promise<AppliedDecision> => {
  const { stored, context, store, tx } = options;
  if (stage === DONE_STAGE) {
    const finished = completeTask(
      stored.task,
      { outcome: 'completed', totals: await totalsOf(options) },
      context,
    );
    const next = { ...stored, task: finished.aggregate };
    return { stored: await store.tasks.save(tx, next), events: finished.events, work: null };
  }

  const command = enterCommand(stage);
  const decision =
    command === null
      ? enterStage(
          stored.task,
          {
            stage,
            ...(stored.task.state === 'queued' ? { dequeueReason: 'wip' as const } : {}),
          },
          context,
        )
      : command(stored.task, context);

  const attempt = decision.aggregate.stageAttempts[stage] ?? 1;
  await store.tasks.recordStageEntered(tx, {
    taskId: stored.task.id,
    stage,
    attempt,
    causedByEventId: options.causedByEventId,
  });

  const entered = stageOf(options.pipeline, stage);
  const events = [...decision.events];
  let task = decision.aggregate;

  if (entered?.kind === 'system') {
    // A system stage is bookkeeping: it completes the moment it is entered, in the same
    // transaction, so the pipeline advances on the next dispatch rather than on a job that would
    // have nothing to run.
    const completed = completeSystemStage(task, stage, context);
    task = completed.aggregate;
    events.push(...completed.events);
    await store.tasks.recordStageExited(tx, {
      taskId: stored.task.id,
      stage,
      attempt,
      outcome: 'system',
      returnReason: null,
    });
  }

  const next = { ...stored, task };
  return {
    stored: await store.tasks.save(tx, next),
    events,
    work:
      entered?.kind === 'agent' || entered?.kind === 'gate'
        ? { taskId: stored.task.id, projectId: stored.task.projectId, stage, attempt }
        : null,
  };
};

/**
 * A `system` stage completes the moment it is entered: it is bookkeeping, not work. Emitted as a
 * real `task.stage.completed` so the transition is in the log rather than being a gap in it.
 */
export const completeSystemStage = (
  task: Task,
  stage: Slug,
  context: CommandContext,
): { aggregate: Task; events: readonly DomainEvent[] } =>
  completeStage(task, { stage, artifacts: [] }, context);
