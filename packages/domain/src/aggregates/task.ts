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
  RunStatus,
  Slug,
  TaskMode,
  TaskState,
  TaskTotals,
  TicketRef,
  UserRole,
} from '@platform/contracts';
import { InvariantViolationError } from '../errors.js';
import { type CommandContext, type Decision, eventRecorder, FIRST_STREAM_SEQ } from '../events.js';
import { assertCan } from '../permissions.js';
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

/**
 * The branch a task's work lives on — BD-025's `agentic/*` namespace, from the ticket's own key.
 *
 * product/19 §19 writes the resume instruction as `git fetch && git checkout agentic/PROJ-123`, so
 * the key is carried through rather than slugified into something a human would not recognise on
 * their board. The alphabet it is carried into is deliberately **narrower** than the one the
 * workspace port accepts (`workspaceExportRequestSchema.branch` allows `[A-Za-z0-9._\-/]`): every
 * run of anything that is not a letter or a digit becomes a single `-`, and leading and trailing
 * dashes are dropped. Three reasons, and the middle one is what a wider rule gets wrong:
 *
 *  - a ticket key is **provider** text (BD-022) and this value reaches a `git push` refspec;
 *  - git itself refuses a ref containing `..` (git-check-ref-format(1)), so a key with two dots
 *    would produce a branch name this platform accepts and the push rejects — at the one moment a
 *    human is waiting for their work;
 *  - one separator reads as one separator: `PROJ;rm -rf /` becoming `PROJ-rm--rf` is a name nobody
 *    would type the same way twice.
 *
 * It is a **fallback**, not the authority: a task that has already opened a merge request has its
 * real branch on `tasks.branch` (the `ImplementationNotes` the saga read), and the caller prefers
 * that. This answers the other case — a take-over before any branch was pushed — and it answers it
 * with the name the run's own `git push origin agentic/*` allow entry permits.
 *
 * @throws {InvariantViolationError} when nothing of the key survives the alphabet.
 */
export const taskBranchName = (ticketKey: string): string => {
  const cleaned = ticketKey
    .slice(0, 180)
    .replaceAll(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
  if (cleaned.length === 0) {
    throw new InvariantViolationError(
      'task.branch',
      `ticket key ${JSON.stringify(ticketKey.slice(0, 40))} has no character a branch name may carry, so this task has no agentic/ branch`,
    );
  }
  return `agentic/${cleaned}`;
};

/**
 * The lines product/19 §19 tells a person to run to continue the work by hand.
 *
 * Platform text around two stored values, in the **domain** because both readers need the same
 * answer: the take-over command's response and the task read model, which are written by different
 * rings and must not each compose their own version of a shell command.
 *
 * The `claude --resume` line is **absent** when there is no session rather than printed with a
 * placeholder: it is the one command here a reader would paste without checking, and technical/04's
 * own note on importing a platform transcript into a local Claude Code still carries a `[verify:]`
 * marker — so the platform promises the session **id** and not that the transcript is already on
 * that machine.
 */
export const resumeCommands = (branch: string, sessionId: string | null): readonly string[] => [
  `git fetch && git checkout ${branch}`,
  ...(sessionId === null ? [] : [`claude --resume ${sessionId}`]),
];

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
 * The human handed the task back at a chosen stage (product/19 §19).
 *
 * **It emits the event and moves nothing.** Entering the chosen stage is
 * `applyDecision`'s — the caller hands this decision's aggregate to it and the two events chain
 * through one `stream_seq`. It used to do both, and doing both here was wrong for the three stage
 * ids a human is most likely to choose: `ready_for_merge`, `merged` and `retro` are task **states**
 * of their own (product/04), so entering them is `markReadyForMerge` / `recordMerge` /
 * `startRetrospective` and not `enterStage`, and this function's own `withState(task, 'active')`
 * would have parked the task in the wrong state with a `task.stage.entered` to match. It also wrote
 * no `task_stages` row, which is the bookkeeping every other entry does.
 *
 * **It does not reset any iteration counter, and the sentence that used to say it did was wrong in
 * both halves** (WP-27). product/04:86's reset — *"Human rejection = reset, not patching"* — is
 * scoped by its own wording to a human asking for *a fundamentally different approach* (`@agentic
 * rework`, or a merge request closed with a reason), which is `reworkStageCommand`'s rule and is
 * applied there, outside the aggregate. A hand-back is the opposite motion: the person carried the
 * *same* approach forward by hand and is returning it, so the rounds the agents spent on it are
 * rounds that were spent. Giving them back here would also be unbounded by construction — hand back,
 * take over, hand back — where `human_rounds` has a ceiling for exactly that reason.
 *
 * What a spent loop then costs is BD-008's ordinary ending: the next return escalates to
 * `needs_human`, with a person already attached to the task.
 */
export const handBackTask = (
  task: Task,
  input: { readonly branch: string; readonly stage: Slug; readonly summary: string },
  context: CommandContext,
): TaskDecision => {
  const recorder = recorderFor(task, context);
  recorder.emit('task.handed_back', {
    project_id: task.projectId,
    task_id: task.id,
    branch: input.branch,
    stage: input.stage,
    summary: input.summary,
  });
  return { aggregate: { ...task, sequence: recorder.sequence }, events: recorder.events };
};

export interface SteerRunInput {
  /** The run the turn goes into; its **status** is what decides whether steering is allowed. */
  readonly run: { readonly id: Id; readonly status: RunStatus };
  /** Untrusted human text, forwarded into the session as a user turn (product/18, BD-022). */
  readonly message: string;
  readonly authorUserId: Id;
  readonly authorRole: UserRole;
}

/**
 * A human pushed a turn into a live run (product/18's *"Steer"*, WP-27).
 *
 * **It is a `Task` command although it emits `run.steered`**, and the reason is the same one
 * {@link recordArtifact} gives one line down: the event goes on the stream whose sequence is
 * re-read in every transaction. A run's is not — the stage executor holds one `Run` aggregate from
 * `createRun` to `run.finished`, so an event appended to that stream by anybody else makes the
 * executor's own terminal append fail the `events_enforce_stream_seq` trigger and re-run the whole
 * stage (measured; `run.ts` carries the error text). The steer's own reading of the run is its
 * **status**, which it takes as an argument rather than by holding the aggregate.
 *
 * The task itself does not move: steering is a message, not a transition. The state check is the
 * permission subject rule (`can()` allows `run.steer` only while the run is `running`), so a run
 * that has ended refuses here as well as at the HTTP boundary.
 */
export const steerRun = (
  task: Task,
  input: SteerRunInput,
  context: CommandContext,
): TaskDecision => {
  assertCan(input.authorRole, 'run.steer', { kind: 'run', status: input.run.status });
  const recorder = recorderFor(task, context);
  recorder.emit('run.steered', {
    project_id: task.projectId,
    task_id: task.id,
    run_id: input.run.id,
    message: input.message,
    author_user_id: input.authorUserId,
  });
  return { aggregate: { ...task, sequence: recorder.sequence }, events: recorder.events };
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
