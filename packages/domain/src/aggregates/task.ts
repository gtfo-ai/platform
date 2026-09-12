/**
 * The Task aggregate — technical/02 § "Aggregates and entities" → Task, and product/04's pipeline.
 *
 * A task is 1:1 with a ticket (`normal` mode) or references one without acting outward
 * (`shadow`). It owns the pipeline state machine, the current stage, per-stage attempt counters
 * and the iteration counters of every bounded loop (BD-008).
 *
 * Shape of the code: the aggregate is an immutable record and every command is a pure function
 * `(task, input, context) → { aggregate, events }`. Nothing here reads a clock, generates an id
 * or touches the outside world — those arrive in the `CommandContext`.
 *
 * Which events each command emits follows the "Producer" column of technical/02's catalogue, so
 * `task.question.answered` (producer: Question) and `task.approval.decided` (producer: Approval)
 * are *not* here even though their names begin with `task.`.
 */
import type {
  ApprovalRecord,
  ArtifactRef,
  Id,
  QuestionRecord,
  Slug,
  TaskMode,
  TaskState,
  TaskTotals,
  TicketRef,
} from '@platform/contracts';
import { InvariantViolationError } from '../errors.js';
import { type CommandContext, type Decision, eventRecorder, FIRST_STREAM_SEQ } from '../events.js';
import {
  evaluateIteration,
  type IterationCounters,
  type IterationLimits,
  type IterationLoop,
  incrementIteration,
  resolveIterationLimits,
} from '../policies/iteration-limits.js';
import {
  assertTaskTransition,
  isRunnableTaskState,
  isTerminalTaskState,
} from './task-state-machine.js';

export interface Task {
  readonly id: Id;
  readonly projectId: Id;
  readonly ticket: TicketRef;
  /** The template snapshot's id; a slug because projects may define their own (technical/12). */
  readonly template: Slug;
  readonly mode: TaskMode;
  readonly state: TaskState;
  readonly currentStage: Slug | null;
  /** How many times each stage has been entered — the `attempt` of `task.stage.entered`. */
  readonly stageAttempts: Readonly<Record<string, number>>;
  readonly iterationCounters: IterationCounters;
  /** Frozen at task start together with the rest of the effective config (technical/12). */
  readonly limits: IterationLimits;
  /** Next `stream_seq` for this aggregate's events. */
  readonly sequence: number;
}

export type TaskDecision = Decision<Task>;

/** Reasons the scheduler queues or dequeues a task (`task.queued` / `task.dequeued`). */
export type QueueReason = 'wip' | 'budget' | 'dependency' | 'manual';

/** Why a task is paused (`task.paused`). */
export type PauseReason = 'budget' | 'manual' | 'taken_over';

const recorderFor = (task: Task, context: CommandContext) =>
  eventRecorder({ streamType: 'task', streamId: task.id }, task.sequence, {
    ...context,
    correlationId: context.correlationId ?? task.id,
  });

const withState = (task: Task, state: TaskState): Task => {
  assertTaskTransition(task.state, state);
  return { ...task, state };
};

const enteredAttempt = (task: Task, stage: Slug): number => (task.stageAttempts[stage] ?? 0) + 1;

/** Stages whose entry is bookkeeping for a state change rather than an agent run. */
export const READY_FOR_MERGE_STAGE = 'ready_for_merge' as const;
export const MERGED_GATE_STAGE = 'merged_gate' as const;
export const RETROSPECTIVE_STAGE = 'retrospective' as const;
export const LIBRARIAN_STAGE = 'librarian' as const;

// ── creation ─────────────────────────────────────────────────────────────────

export interface CreateTaskInput {
  readonly id: Id;
  readonly projectId: Id;
  readonly ticket: TicketRef;
  readonly template: Slug;
  readonly mode: TaskMode;
  /** Cost estimate from project history, shown in the workpad (product/18). */
  readonly estimateUsd?: number;
  /** Effective iteration limits; BD-008 defaults when the caller has no configuration yet. */
  readonly limits?: IterationLimits;
}

/**
 * Intake created the task. It starts `queued`: the WIP policy decides whether it may become
 * active straight away (product/04 S0, BD-010).
 */
export const createTask = (input: CreateTaskInput, context: CommandContext): TaskDecision => {
  const task: Task = {
    id: input.id,
    projectId: input.projectId,
    ticket: input.ticket,
    template: input.template,
    mode: input.mode,
    state: 'queued',
    currentStage: null,
    stageAttempts: {},
    iterationCounters: {},
    limits: input.limits ?? resolveIterationLimits(),
    sequence: FIRST_STREAM_SEQ,
  };
  const recorder = recorderFor(task, context);
  recorder.emit('task.created', {
    project_id: task.projectId,
    task_id: task.id,
    ticket: task.ticket,
    template: task.template,
    mode: task.mode,
    estimate_usd: input.estimateUsd ?? null,
  });
  return { aggregate: { ...task, sequence: recorder.sequence }, events: recorder.events };
};

// ── scheduling ───────────────────────────────────────────────────────────────

/**
 * The scheduler parked the task behind a limit (BD-010). The state machine does not move: a
 * queued task is already `queued`; the event records *why* it is still waiting.
 */
export const queueTask = (
  task: Task,
  input: { readonly reason: QueueReason },
  context: CommandContext,
): TaskDecision => {
  if (task.state !== 'queued') {
    throw new InvariantViolationError(
      'task.queue',
      `only a queued task can be re-queued, this one is "${task.state}"`,
    );
  }
  const recorder = recorderFor(task, context);
  recorder.emit('task.queued', {
    project_id: task.projectId,
    task_id: task.id,
    reason: input.reason,
  });
  return { aggregate: { ...task, sequence: recorder.sequence }, events: recorder.events };
};

// ── stages ───────────────────────────────────────────────────────────────────

export interface EnterStageInput {
  readonly stage: Slug;
  /** Set when the task leaves the queue, so the scheduler's `task.dequeued` is recorded. */
  readonly dequeueReason?: QueueReason;
  /** Free text for `task.resumed`, emitted automatically when the task was waiting or paused. */
  readonly resumeReason?: string;
}

/** States from which entering a stage also means the task resumed (technical/02's diagram). */
const RESUMED_FROM: ReadonlySet<TaskState> = new Set<TaskState>([
  'waiting_answers',
  'waiting_approval',
  'paused',
  'needs_human',
]);

/**
 * The single way a task becomes `active` at a stage: from the queue, from a return, or out of a
 * wait. Emits the bookkeeping events the transition implies before `task.stage.entered`.
 */
export const enterStage = (
  task: Task,
  input: EnterStageInput,
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, 'active');
  const recorder = recorderFor(task, context);
  if (input.dequeueReason !== undefined) {
    recorder.emit('task.dequeued', {
      project_id: task.projectId,
      task_id: task.id,
      reason: input.dequeueReason,
    });
  }
  if (RESUMED_FROM.has(task.state)) {
    recorder.emit('task.resumed', {
      project_id: task.projectId,
      task_id: task.id,
      reason: input.resumeReason ?? null,
    });
  }
  const attempt = enteredAttempt(task, input.stage);
  recorder.emit('task.stage.entered', {
    project_id: task.projectId,
    task_id: task.id,
    stage: input.stage,
    attempt,
  });
  return {
    aggregate: {
      ...next,
      currentStage: input.stage,
      stageAttempts: { ...task.stageAttempts, [input.stage]: attempt },
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

export interface CompleteStageInput {
  readonly stage: Slug;
  readonly artifacts: readonly ArtifactRef[];
  readonly verdict?: string;
}

/**
 * A stage produced its artifacts. The task stays `active`; the pipeline interpreter (WP-15) picks
 * the next stage from the template snapshot.
 */
export const completeStage = (
  task: Task,
  input: CompleteStageInput,
  context: CommandContext,
): TaskDecision => {
  // Any state the pipeline is still moving through, not just `active`: the retrospective completes
  // from `retro` and the merged gate from `merged` (product/04's task states are not one per
  // stage). What a stage may not complete from is a stop a human owns.
  if (!isRunnableTaskState(task.state)) {
    throw new InvariantViolationError(
      'task.stage.complete',
      `a stage can only complete while the task is running, this one is "${task.state}"`,
    );
  }
  if (task.currentStage !== input.stage) {
    throw new InvariantViolationError(
      'task.stage.complete',
      `stage "${input.stage}" is not the current stage ("${task.currentStage ?? 'none'}")`,
    );
  }
  const recorder = recorderFor(task, context);
  recorder.emit('task.stage.completed', {
    project_id: task.projectId,
    task_id: task.id,
    stage: input.stage,
    artifacts: [...input.artifacts],
    verdict: input.verdict ?? null,
  });
  return { aggregate: { ...task, sequence: recorder.sequence }, events: recorder.events };
};

export interface ReturnToStageInput {
  readonly fromStage: Slug;
  readonly toStage: Slug;
  /** Which bounded loop this return belongs to (BD-008). */
  readonly loop: IterationLoop;
  readonly reason: string;
  readonly feedbackRef?: Id;
  /**
   * What a human must do if the loop is exhausted. Every escalation carries a blocker brief
   * (product/04), so it is required up front rather than invented at escalation time.
   */
  readonly escalationBrief: string;
}

/**
 * A return — "a transition backwards with a reason and structured feedback. Returns are normal."
 *
 * Enforces technical/02's invariant "iteration counters never exceed their limits without a
 * `task.escalated` event": when the loop is spent the task escalates to `needs_human` and the
 * counter is left where it is, so the counter can never pass the limit at all.
 */
export const returnToStage = (
  task: Task,
  input: ReturnToStageInput,
  context: CommandContext,
): TaskDecision => {
  const iteration = evaluateIteration(task.iterationCounters, input.loop, task.limits);
  if (!iteration.allowed) {
    return escalateTask(
      task,
      {
        reason: `${input.loop} iteration limit of ${iteration.limit} reached: ${input.reason}`,
        blockerBrief: input.escalationBrief,
      },
      context,
    );
  }
  const next = withState(task, 'returned');
  const recorder = recorderFor(task, context);
  recorder.emit('task.stage.returned', {
    project_id: task.projectId,
    task_id: task.id,
    from_stage: input.fromStage,
    to_stage: input.toStage,
    reason: input.reason,
    feedback_ref: input.feedbackRef ?? null,
    iteration: iteration.next,
  });
  return {
    aggregate: {
      ...next,
      iterationCounters: incrementIteration(task.iterationCounters, input.loop),
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

export interface ResumeStageInput {
  readonly stage: Slug;
  /** The bounded loop this resumption spends a round of (BD-008). */
  readonly loop: IterationLoop;
  readonly reason: string;
  readonly escalationBrief: string;
}

/**
 * Re-enter the stage the task was waiting at, spending a round of a bounded loop.
 *
 * A question round is a loop like any other — BD-008 bounds "refinement question rounds" at 2 —
 * but it is **not** a `returnToStage`: `waiting_answers → returned` is not a legal transition (the
 * task never went backwards, it stood still), and emitting `task.stage.returned` from stage X to
 * stage X would put a return in the log that never happened. So this is its own command, and it
 * enforces the same invariant `returnToStage` does: when the loop is spent the counter stays where
 * it is and the task escalates, so a counter can never pass its limit.
 */
export const resumeStage = (
  task: Task,
  input: ResumeStageInput,
  context: CommandContext,
): TaskDecision => {
  const iteration = evaluateIteration(task.iterationCounters, input.loop, task.limits);
  if (!iteration.allowed) {
    return escalateTask(
      task,
      {
        reason: `${input.loop} iteration limit of ${iteration.limit} reached: ${input.reason}`,
        blockerBrief: input.escalationBrief,
      },
      context,
    );
  }
  const decision = enterStage(task, { stage: input.stage, resumeReason: input.reason }, context);
  return {
    aggregate: {
      ...decision.aggregate,
      iterationCounters: incrementIteration(task.iterationCounters, input.loop),
    },
    events: decision.events,
  };
};

// ── waits ────────────────────────────────────────────────────────────────────

/**
 * A stage asked a human something (product/04 S1). Only a *blocking* question stops the task:
 * "Non-blocking assumptions are stated explicitly and proceed."
 */
export const askQuestion = (
  task: Task,
  input: { readonly question: QuestionRecord },
  context: CommandContext,
): TaskDecision => {
  if (task.state !== 'active') {
    throw new InvariantViolationError(
      'task.question.ask',
      `a question comes from a running stage; this task is "${task.state}"`,
    );
  }
  const next = input.question.blocking ? withState(task, 'waiting_answers') : task;
  const recorder = recorderFor(task, context);
  recorder.emit('task.question.asked', {
    project_id: task.projectId,
    task_id: task.id,
    question: input.question,
  });
  return { aggregate: { ...next, sequence: recorder.sequence }, events: recorder.events };
};

/** A gate needs a maintainer's decision (BD-006): plan, budget, knowledge or rework. */
export const requestApproval = (
  task: Task,
  input: { readonly approval: ApprovalRecord },
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, 'waiting_approval');
  const recorder = recorderFor(task, context);
  recorder.emit('task.approval.requested', {
    project_id: task.projectId,
    task_id: task.id,
    approval: input.approval,
  });
  return { aggregate: { ...next, sequence: recorder.sequence }, events: recorder.events };
};

// ── pause, escalate, take over ───────────────────────────────────────────────

export const pauseTask = (
  task: Task,
  input: { readonly reason: PauseReason },
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, 'paused');
  const recorder = recorderFor(task, context);
  recorder.emit('task.paused', {
    project_id: task.projectId,
    task_id: task.id,
    reason: input.reason,
  });
  return { aggregate: { ...next, sequence: recorder.sequence }, events: recorder.events };
};

/** Park the task in `Needs human` with a blocker brief (product/04, BD-008). */
export const escalateTask = (
  task: Task,
  input: { readonly reason: string; readonly blockerBrief: string },
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, 'needs_human');
  const recorder = recorderFor(task, context);
  recorder.emit('task.escalated', {
    project_id: task.projectId,
    task_id: task.id,
    reason: input.reason,
    blocker_brief: input.blockerBrief,
  });
  return { aggregate: { ...next, sequence: recorder.sequence }, events: recorder.events };
};

/** A human took the task over (product/19 §19): the pipeline pauses and the workspace is exported. */
export const takeOverTask = (
  task: Task,
  input: { readonly branch: string; readonly stage: Slug; readonly sessionId?: string },
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, 'paused');
  const recorder = recorderFor(task, context);
  recorder.emit('task.taken_over', {
    project_id: task.projectId,
    task_id: task.id,
    branch: input.branch,
    session_id: input.sessionId ?? null,
    stage: input.stage,
  });
  return { aggregate: { ...next, sequence: recorder.sequence }, events: recorder.events };
};

/**
 * The human handed the task back at a chosen stage. A human decision resets the agent-to-agent
 * iteration counters (product/04, Paperclip) — `human_rounds` survives.
 */
export const handBackTask = (
  task: Task,
  input: { readonly branch: string; readonly stage: Slug; readonly summary: string },
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, 'active');
  const recorder = recorderFor(task, context);
  recorder.emit('task.handed_back', {
    project_id: task.projectId,
    task_id: task.id,
    branch: input.branch,
    stage: input.stage,
    summary: input.summary,
  });
  const attempt = enteredAttempt(task, input.stage);
  recorder.emit('task.stage.entered', {
    project_id: task.projectId,
    task_id: task.id,
    stage: input.stage,
    attempt,
  });
  return {
    aggregate: {
      ...next,
      currentStage: input.stage,
      stageAttempts: { ...task.stageAttempts, [input.stage]: attempt },
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

/**
 * A stage produced an artifact.
 *
 * No state change: the artifact belongs to the Artifact aggregate, but `events.stream_type` has no
 * `artifact` member (technical/03) — an artifact's history *is* its task's — so `artifact.created`
 * is emitted on the task's stream and therefore has to come through the task's own recorder, or
 * its `stream_seq` would collide with the next event the task emits.
 */
export const recordArtifact = (
  task: Task,
  input: { readonly artifact: ArtifactRef; readonly producedByRunId: Id },
  context: CommandContext,
): TaskDecision => {
  const recorder = recorderFor(task, context);
  recorder.emit('artifact.created', {
    project_id: task.projectId,
    task_id: task.id,
    artifact: input.artifact,
    produced_by_run_id: input.producedByRunId,
  });
  return { aggregate: { ...task, sequence: recorder.sequence }, events: recorder.events };
};

// ── the tail of the pipeline ─────────────────────────────────────────────────

const enterTerminalStage = (
  task: Task,
  stage: Slug,
  state: TaskState,
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, state);
  const recorder = recorderFor(task, context);
  const attempt = enteredAttempt(task, stage);
  recorder.emit('task.stage.entered', {
    project_id: task.projectId,
    task_id: task.id,
    stage,
    attempt,
  });
  return {
    aggregate: {
      ...next,
      currentStage: stage,
      stageAttempts: { ...task.stageAttempts, [stage]: attempt },
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

/** MR marked ready; nothing runs while the task waits for a human (product/04 S7). */
export const markReadyForMerge = (task: Task, context: CommandContext): TaskDecision =>
  enterTerminalStage(task, READY_FOR_MERGE_STAGE, 'ready_for_merge', context);

/** `mr.merged` arrived; the merged gate records the merge (product/04 S8). */
export const recordMerge = (task: Task, context: CommandContext): TaskDecision =>
  enterTerminalStage(task, MERGED_GATE_STAGE, 'merged', context);

/** The retrospective stage (product/04 S9). */
export const startRetrospective = (task: Task, context: CommandContext): TaskDecision =>
  enterTerminalStage(task, RETROSPECTIVE_STAGE, 'retro', context);

/**
 * The Librarian stage, which curates what the retrospective proposed (technical/07, WP-18b).
 *
 * It keeps the task in `retro` rather than returning it to `active`: the merge has happened and no
 * work can follow it, so the two stages of the retrospective phase share one state and the state
 * machine carries the self edge that says so. Written as its own command rather than falling to
 * `enterStage` because that one sets `active`, which `retro` has no edge to — the task would
 * escalate one stage short of `done`.
 */
export const startLibrarianCuration = (task: Task, context: CommandContext): TaskDecision =>
  enterTerminalStage(task, LIBRARIAN_STAGE, 'retro', context);

export const completeTask = (
  task: Task,
  input: { readonly outcome: string; readonly totals: TaskTotals },
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, 'done');
  const recorder = recorderFor(task, context);
  recorder.emit('task.completed', {
    project_id: task.projectId,
    task_id: task.id,
    outcome: input.outcome,
    totals: input.totals,
  });
  return { aggregate: { ...next, sequence: recorder.sequence }, events: recorder.events };
};

export const cancelTask = (
  task: Task,
  input: { readonly outcome: string; readonly totals: TaskTotals },
  context: CommandContext,
): TaskDecision => {
  const next = withState(task, 'cancelled');
  const recorder = recorderFor(task, context);
  recorder.emit('task.cancelled', {
    project_id: task.projectId,
    task_id: task.id,
    outcome: input.outcome,
    totals: input.totals,
  });
  return { aggregate: { ...next, sequence: recorder.sequence }, events: recorder.events };
};

// ── invariants ───────────────────────────────────────────────────────────────

export const isTaskFinished = (task: Task): boolean => isTerminalTaskState(task.state);

/**
 * technical/02: "Shadow tasks never produce `integration.action.performed` for mutating actions."
 * The executor asks before every outbound action; `shadow` mode answers no.
 */
export const assertMutatingActionAllowed = (task: Task, action: string): void => {
  if (task.mode === 'shadow') {
    throw new InvariantViolationError(
      'shadow.no_outbound_mutation',
      `task ${task.id} runs in shadow mode; "${action}" would act on an external system`,
    );
  }
};
