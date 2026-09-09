/**
 * The Run aggregate and its state machine — technical/02.
 *
 * ```
 * created → starting → running → (completed | failed | cancelled | budget_exceeded | timed_out | stalled)
 * ```
 *
 * "`running` emits `run.output` stream events (not stored in the domain log; stored in the
 * transcript store) and heartbeats; `stalled` after no output for `stall_timeout` (default 5 min)."
 *
 * A run is the audit unit (BD-003): it carries the model, the effort, the prompt version, the
 * context pack, the usage and the cost. Every transition is logged: `run.created` when the
 * platform commits to launching (`created → starting`), `run.started` when the session is live,
 * and one of `run.finished` / `run.failed` at the end. `created` itself is a pure in-memory
 * pre-state — a run that is never started never reaches the log, so no *state change* is silent.
 */
import type {
  AgentRole,
  ContextPackRecord,
  Effort,
  Id,
  IsoDateTime,
  ModelUsage,
  RunCost,
  RunMode,
  RunStatus,
  RunTerminalReason,
  Slug,
  TokenUsage,
  UserRole,
} from '@platform/contracts';
import { differenceMs } from '../clock.js';
import { IllegalTransitionError, InvariantViolationError } from '../errors.js';
import { type CommandContext, type Decision, eventRecorder } from '../events.js';
import { assertCan } from '../permissions.js';

/** The transition table of technical/02, as data. */
export const RUN_TRANSITIONS = {
  /**
   * `created` is in memory only — the run enters the log at `run.created`, emitted by the
   * transition below. A run that is never started is discarded, not cancelled, so there is no
   * terminal edge here: nothing outside the process ever heard of it.
   */
  created: ['starting'],
  starting: ['running', 'failed', 'cancelled', 'timed_out'],
  running: ['completed', 'failed', 'cancelled', 'budget_exceeded', 'timed_out', 'stalled'],
  completed: [],
  failed: [],
  cancelled: [],
  budget_exceeded: [],
  timed_out: [],
  stalled: [],
} as const satisfies Record<RunStatus, readonly RunStatus[]>;

/** Statuses that hold a slot against the org's `max_parallel_runs` (BD-010). */
export const ACTIVE_RUN_STATUSES = [
  'created',
  'starting',
  'running',
] as const satisfies readonly RunStatus[];

/** Terminal statuses reported as `run.finished`; the rest report `run.failed`. */
const FINISHED_STATUSES = [
  'completed',
  'cancelled',
  'budget_exceeded',
  'timed_out',
] as const satisfies readonly RunStatus[];

export const isActiveRunStatus = (status: RunStatus): boolean =>
  (ACTIVE_RUN_STATUSES as readonly RunStatus[]).includes(status);

export const canTransitionRun = (from: RunStatus, to: RunStatus): boolean =>
  (RUN_TRANSITIONS[from] as readonly RunStatus[]).includes(to);

export const assertRunTransition = (from: RunStatus, to: RunStatus): void => {
  if (!canTransitionRun(from, to)) {
    throw new IllegalTransitionError('Run', from, to);
  }
};

/** Default stall timeout — technical/02: "`stalled` after no output for `stall_timeout`". */
export const DEFAULT_STALL_TIMEOUT_MS = 5 * 60_000;

export interface Run {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly stage: Slug;
  readonly role: AgentRole;
  readonly mode: RunMode;
  readonly attempt: number;
  readonly model: string;
  readonly effort: Effort;
  readonly promptVersion: string;
  readonly status: RunStatus;
  readonly startedAt: IsoDateTime | null;
  readonly lastOutputAt: IsoDateTime | null;
  readonly endedAt: IsoDateTime | null;
  readonly terminalReason: RunTerminalReason | null;
  readonly sequence: number;
}

export type RunDecision = Decision<Run>;

const recorderFor = (run: Run, context: CommandContext) =>
  eventRecorder({ streamType: 'run', streamId: run.id }, run.sequence, {
    ...context,
    correlationId: context.correlationId ?? run.taskId,
  });

export interface CreateRunInput {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly stage: Slug;
  readonly role: AgentRole;
  readonly mode: RunMode;
  readonly attempt: number;
  readonly model: string;
  readonly effort: Effort;
  readonly promptVersion: string;
}

/**
 * technical/02's invariant "a task has at most one active run at a time". The caller passes the
 * task's runs; this is where the rule lives so every path that starts a run trips over it.
 */
export const assertSingleActiveRun = (runs: readonly Run[], taskId: Id): void => {
  const active = runs.filter((run) => run.taskId === taskId && isActiveRunStatus(run.status));
  if (active.length > 0) {
    throw new InvariantViolationError(
      'task.single_active_run',
      `task ${taskId} already has an active run (${active.map((run) => run.id).join(', ')})`,
    );
  }
};

/**
 * Builds the run record in memory. No event yet: nothing outside this process knows about it, and
 * a run that is never launched never happened. The log starts at `startRun`.
 */
export const createRun = (input: CreateRunInput): Run => ({
  id: input.id,
  taskId: input.taskId,
  projectId: input.projectId,
  stage: input.stage,
  role: input.role,
  mode: input.mode,
  attempt: input.attempt,
  model: input.model,
  effort: input.effort,
  promptVersion: input.promptVersion,
  status: 'created',
  startedAt: null,
  lastOutputAt: null,
  endedAt: null,
  terminalReason: null,
  sequence: 0,
});

/**
 * The platform committed to launching the run: the workspace is being provisioned and the CLI
 * started. `created → starting`, and the run enters the log.
 *
 * `run.created` carries the run's whole identity — stage, role, mode, attempt, model, effort,
 * prompt version — so the `runs` row can be rebuilt from the log alone. technical/02 opens with
 * "every state change is recorded as an immutable domain event"; this is the state change that
 * makes the run real.
 */
export const startRun = (run: Run, context: CommandContext): RunDecision => {
  assertRunTransition(run.status, 'starting');
  const recorder = recorderFor(run, context);
  recorder.emit('run.created', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    stage: run.stage,
    role: run.role,
    mode: run.mode,
    attempt: run.attempt,
    model: run.model,
    effort: run.effort,
    prompt_version: run.promptVersion,
  });
  return {
    aggregate: { ...run, status: 'starting', sequence: recorder.sequence },
    events: recorder.events,
  };
};

/** The session is live: `starting → running`, and the catalogue's `run.started` is emitted. */
export const markRunning = (
  run: Run,
  input: { readonly contextPack: ContextPackRecord },
  context: CommandContext,
): RunDecision => {
  assertRunTransition(run.status, 'running');
  const recorder = recorderFor(run, context);
  const startedAt = recorder.occurredAt;
  recorder.emit('run.started', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    model: run.model,
    effort: run.effort,
    prompt_version: run.promptVersion,
    context_pack: input.contextPack,
  });
  return {
    aggregate: {
      ...run,
      status: 'running',
      startedAt,
      lastOutputAt: startedAt,
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

/**
 * A heartbeat: the runner saw output. Not an event — `run.output` is a transcript stream, "not
 * stored in the domain log" (technical/02) — but it resets the stall clock.
 */
export const recordOutput = (run: Run, at: IsoDateTime): Run => {
  if (run.status !== 'running') {
    throw new InvariantViolationError(
      'run.output',
      `output can only arrive while the run is running, this one is "${run.status}"`,
    );
  }
  return { ...run, lastOutputAt: at };
};

/** Has the run produced nothing for longer than `stallTimeoutMs`? */
export const isStalled = (
  run: Run,
  now: IsoDateTime,
  stallTimeoutMs: number = DEFAULT_STALL_TIMEOUT_MS,
): boolean => {
  if (run.status !== 'running' || run.lastOutputAt === null) {
    return false;
  }
  return differenceMs(run.lastOutputAt, now) >= stallTimeoutMs;
};

export interface FinishRunInput {
  readonly status: (typeof FINISHED_STATUSES)[number];
  readonly terminalReason: RunTerminalReason;
  readonly usage: TokenUsage;
  readonly modelUsage: readonly ModelUsage[];
  readonly cost: RunCost;
  readonly numTurns: number;
}

/** A terminal outcome the platform counts as a completed attempt (`run.finished`). */
export const finishRun = (
  run: Run,
  input: FinishRunInput,
  context: CommandContext,
): RunDecision => {
  assertRunTransition(run.status, input.status);
  const recorder = recorderFor(run, context);
  const endedAt = recorder.occurredAt;
  recorder.emit('run.finished', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    status: input.status,
    terminal_reason: input.terminalReason,
    usage: input.usage,
    model_usage: [...input.modelUsage],
    cost: input.cost,
    num_turns: input.numTurns,
    wall_ms: run.startedAt === null ? 0 : Math.max(0, differenceMs(run.startedAt, endedAt)),
  });
  return {
    aggregate: {
      ...run,
      status: input.status,
      terminalReason: input.terminalReason,
      endedAt,
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

export interface FailRunInput {
  /** `failed` for a crash or an SDK error, `stalled` when the stall timeout fired. */
  readonly status: 'failed' | 'stalled';
  readonly terminalReason: RunTerminalReason;
  readonly error: string;
  readonly usage?: TokenUsage;
  readonly cost?: RunCost;
}

export const failRun = (run: Run, input: FailRunInput, context: CommandContext): RunDecision => {
  assertRunTransition(run.status, input.status);
  const recorder = recorderFor(run, context);
  const endedAt = recorder.occurredAt;
  recorder.emit('run.failed', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    status: input.status,
    terminal_reason: input.terminalReason,
    error: input.error,
    usage: input.usage ?? null,
    cost: input.cost ?? null,
  });
  return {
    aggregate: {
      ...run,
      status: input.status,
      terminalReason: input.terminalReason,
      endedAt,
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

export interface SteerRunInput {
  /** Untrusted human text, forwarded into the session as a user turn (product/18, BD-022). */
  readonly message: string;
  readonly authorUserId: Id;
  readonly authorRole: UserRole;
}

/** Steering pushes a user turn into a live run; audited, and only while the run is running. */
export const steerRun = (run: Run, input: SteerRunInput, context: CommandContext): RunDecision => {
  assertCan(input.authorRole, 'run.steer', { kind: 'run', status: run.status });
  const recorder = recorderFor(run, context);
  recorder.emit('run.steered', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    message: input.message,
    author_user_id: input.authorUserId,
  });
  return { aggregate: { ...run, sequence: recorder.sequence }, events: recorder.events };
};
