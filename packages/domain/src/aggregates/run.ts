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
 * context pack, the usage and the cost. Every transition is logged, and since WP-275b the lifecycle
 * follows the run's **offer** (TD-031's 2026-11-04 amendment §4):
 *
 * | moment | status | events |
 * |---|---|---|
 * | the row is written with its offer | `created` (persisted) | `run.created`, `run.offered` |
 * | the claim | `created → starting` | `run.claimed` |
 * | the CLI spawn marker | `starting → running` | `run.started` |
 * | a release (WP-281) | `starting → created` | `run.offer.released` |
 * | a withdrawal (WP-276) | `created → cancelled` | `run.finished` (`cancelled`) |
 *
 * So `run.started` states that the platform asked for the run's CLI — WP-150's marker, the one
 * boundary between a run that may have spent and one that cannot — and a run that ends before it
 * (a start failure, a stop, the lease sweep, a cancel) has no `run.started` at all.
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
  RunSavedWork,
  RunStartFailure,
  RunStatus,
  RunTerminalReason,
  Slug,
  TokenUsage,
} from '@platform/contracts';
import { differenceMs } from '../clock.js';
import { IllegalTransitionError, InvariantViolationError } from '../errors.js';
import { type CommandContext, type Decision, eventRecorder, FIRST_STREAM_SEQ } from '../events.js';

/** The transition table of technical/02, as data. */
export const RUN_TRANSITIONS = {
  /**
   * `created` is **persisted** since WP-274 (the row is written with its offer) and the run enters
   * the log there, at `run.created` ({@link recordRunCreated}). Its two edges are the claim
   * (`starting`) and the offer's withdrawal (`cancelled`, WP-276: a stage left before any claimant
   * took the run) — TD-031's 2026-11-04 amendment §4.
   */
  created: ['starting', 'cancelled'],
  /**
   * The claim held, the CLI not yet asked for. Every ending a run can reach before its spawn
   * marker is an edge from here — a start failure (`failed`), a stop (`cancelled`, or `failed` for
   * a hand-back), the lease sweep (`failed`), the wall clock (`timed_out`) — and so is a
   * **release** (`created`, WP-281), which undoes the claim only.
   */
  starting: ['running', 'failed', 'cancelled', 'timed_out', 'created'],
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
  /**
   * The pipeline stage this run is an attempt of, or `null` for a run that belongs to none.
   *
   * `runs.task_stage_id` has been nullable since migration 0004 and technical/03:40-42 names the
   * three run kinds that use it — discovery, ask-the-task, librarian/maintenance. The aggregate
   * typed it non-nullable until WP-31, which is why the only stage-less run the platform could
   * express before then had to borrow a one-off task's stage (`onboarding/discovery.ts`).
   */
  readonly stage: Slug | null;
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
  /** Required and nullable — see {@link Run.stage}. */
  readonly stage: Slug | null;
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
 * Builds the run record in memory, in `created`. No event yet: the log starts at
 * {@link recordRunCreated}, in the transaction that writes the row and its offer.
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
  sequence: FIRST_STREAM_SEQ,
});

/**
 * The run's row is written with its offer (WP-275b, TD-031's 2026-11-04 amendment §4): the run
 * enters the log here, **in `created`**, and its status does not change — the claim is what moves
 * it (`claimRun`, `created → starting`).
 *
 * `run.created` carries the run's whole identity — stage, role, mode, attempt, model, effort,
 * prompt version — so the `runs` row can be rebuilt from the log alone. technical/02 opens with
 * "every state change is recorded as an immutable domain event"; this is the record that makes the
 * run real. Recorded once: a run whose stream already holds an event is refused.
 */
export const recordRunCreated = (run: Run, context: CommandContext): RunDecision => {
  if (run.status !== 'created' || run.sequence !== FIRST_STREAM_SEQ) {
    throw new InvariantViolationError(
      'run.created',
      `a run is recorded once, in "created" with an empty stream; this one is "${run.status}" at sequence ${run.sequence}`,
    );
  }
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
    aggregate: { ...run, sequence: recorder.sequence },
    events: recorder.events,
  };
};

const assertOfferable = (run: Run, event: string): void => {
  if (!isActiveRunStatus(run.status)) {
    throw new InvariantViolationError(
      event,
      `only a live run is offered or claimed, this one is "${run.status}"`,
    );
  }
};

/**
 * The run is **offered** (WP-274, TD-031 decision 1): its `run_offers` row is written in the run's
 * creation transaction. **No status change** — the run is `created` and stays so until a claim;
 * the event is the run stream's record that the offer exists.
 */
export const offerRun = (
  run: Run,
  offer: { readonly offerId: Id; readonly kind: 'stage' | 'ask' },
  context: CommandContext,
): RunDecision => {
  assertOfferable(run, 'run.offered');
  const recorder = recorderFor(run, context);
  recorder.emit('run.offered', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    offer_id: offer.offerId,
    kind: offer.kind,
    stage: run.stage,
    attempt: run.attempt,
  });
  return { aggregate: { ...run, sequence: recorder.sequence }, events: recorder.events };
};

/**
 * One claim took the run's offer (WP-274, TD-031 decision 2) — at `epoch`, which every claim of an
 * offer increments — and the run is **`created → starting`** (WP-275b, TD-031's 2026-11-04
 * amendment §4). The claim itself is the repository's one SQL statement, which moves the row's
 * status with the lease; this records what it answered.
 */
export const claimRun = (
  run: Run,
  claim: {
    readonly offerId: Id;
    readonly claimantKind: 'server' | 'worker';
    readonly workerId: Id | null;
    readonly epoch: number;
  },
  context: CommandContext,
): RunDecision => {
  assertOfferable(run, 'run.claimed');
  if (!Number.isInteger(claim.epoch) || claim.epoch < 1) {
    throw new InvariantViolationError(
      'run.claimed',
      `a claim's epoch is at least 1, not ${claim.epoch}`,
    );
  }
  assertRunTransition(run.status, 'starting');
  const recorder = recorderFor(run, context);
  recorder.emit('run.claimed', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    offer_id: claim.offerId,
    claimant_kind: claim.claimantKind,
    worker_id: claim.workerId,
    lease_epoch: claim.epoch,
  });
  return {
    aggregate: { ...run, status: 'starting', sequence: recorder.sequence },
    events: recorder.events,
  };
};

/**
 * **A claim is handed back unspent** (WP-281, TD-031 decision 6 and its 2026-11-04 amendment §4):
 * the run is **`starting → created`** — only before its CLI spawn marker, which the caller's
 * conditional write checks; a `running` run is refused here too, because a started run ends through
 * `finish`. Records `run.offer.released`; `run.claimed` stands beside it, and nothing is charged.
 */
export const releaseRunClaim = (
  run: Run,
  release: {
    readonly offerId: Id;
    readonly workerId: Id | null;
    readonly epoch: number;
    readonly reason:
      | 'usage_limited'
      | 'image_missing'
      | 'provision_failed'
      | 'shutdown'
      | 'credential_unavailable';
  },
  context: CommandContext,
): RunDecision => {
  if (run.status !== 'starting') {
    throw new IllegalTransitionError('Run', run.status, 'created');
  }
  if (!Number.isInteger(release.epoch) || release.epoch < 1) {
    throw new InvariantViolationError(
      'run.offer.released',
      `a released claim's epoch is at least 1, not ${release.epoch}`,
    );
  }
  const recorder = recorderFor(run, context);
  recorder.emit('run.offer.released', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    offer_id: release.offerId,
    worker_id: release.workerId,
    lease_epoch: release.epoch,
    reason: release.reason,
  });
  return {
    aggregate: { ...run, status: 'created', sequence: recorder.sequence },
    events: recorder.events,
  };
};

/**
 * **The offer no claimant took is withdrawn** (WP-276, TD-031 decision 3): a task transition left the
 * run's stage entry while its offer was still `open`. Only a `created` run — never claimed — can be
 * withdrawn: a claimed one is stopped through its holder (a `cancel` run command) instead. Records
 * `run.offer.withdrawn` and then the run's ending, `created → cancelled` (`run.finished`), with the
 * measured zero the caller hands in — nothing ran, so nothing was spent (WP-150's rule) — and the
 * start-failure record that says how far it got.
 */
export const withdrawRunOffer = (
  run: Run,
  input: {
    readonly offerId: Id;
    readonly reason: string;
    readonly usage: TokenUsage;
    readonly cost: RunCost;
    readonly startFailure: RunStartFailure;
  },
  context: CommandContext,
): RunDecision => {
  if (run.status !== 'created') {
    throw new IllegalTransitionError('Run', run.status, 'cancelled');
  }
  const recorder = recorderFor(run, context);
  recorder.emit('run.offer.withdrawn', {
    project_id: run.projectId,
    task_id: run.taskId,
    run_id: run.id,
    offer_id: input.offerId,
    reason: input.reason,
  });
  const finished = finishRun(
    { ...run, sequence: recorder.sequence },
    {
      status: 'cancelled',
      terminalReason: 'cancelled',
      usage: input.usage,
      modelUsage: [],
      cost: input.cost,
      numTurns: 0,
      startFailure: input.startFailure,
    },
    context,
  );
  return { aggregate: finished.aggregate, events: [...recorder.events, ...finished.events] };
};

/**
 * The platform asked for the run's CLI: `starting → running`, and the catalogue's `run.started` is
 * emitted — in the transaction that writes `runs.cli_spawn_requested_at` and `runs.started_at`
 * (`recordCliSpawn`, WP-275b), never before.
 */
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
  /** `null` when nothing measured the run's spend — never `{ usd: 0 }` for that (WP-119, rule 16). */
  readonly cost: RunCost | null;
  readonly numTurns: number;
  /**
   * What the platform did with the run's unfinished work (PROGRESS backlog 467), carried onto
   * `run.finished.saved_work` as given; absent when it attempted no export.
   */
  readonly savedWork?: RunSavedWork;
  /**
   * Why a run **stopped before its CLI was asked to start** went no further (WP-154 (b′), PROGRESS
   * backlog 502), carried onto `run.finished.start_failure` as given; absent for every other ending.
   */
  readonly startFailure?: RunStartFailure;
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
    ...(input.savedWork === undefined ? {} : { saved_work: input.savedWork }),
    ...(input.startFailure === undefined ? {} : { start_failure: input.startFailure }),
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
  /**
   * Present exactly when the run **never started** (PROGRESS backlog 453): carried onto
   * `run.failed.start_failure` as given — the caller redacted and bounded it.
   */
  readonly startFailure?: RunStartFailure;
  /** {@link FinishRunInput.savedWork}, onto `run.failed.saved_work` (PROGRESS backlog 467). */
  readonly savedWork?: RunSavedWork;
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
    ...(input.startFailure === undefined ? {} : { start_failure: input.startFailure }),
    ...(input.savedWork === undefined ? {} : { saved_work: input.savedWork }),
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

/**
 * **Steering is a `Task` command, and it is in `task.ts`** — `steerRun` there (WP-27).
 *
 * It emits `run.steered`, so this file is where a reader looks for it, and the reason it is not
 * here is worth the redirection. A run's `stream_seq` is held **in memory by the stage executor
 * for the whole run**: `createRun`, `recordRunCreated`, `claimRun` and `markRunning` advance one `Run` aggregate, and
 * the executor appends `run.finished` from that same object minutes later. A second writer on the
 * run's stream therefore does not race — it *corrupts*: the steer takes sequence 3, the executor
 * appends its terminal event at the sequence it still believes in, and the `events_enforce_stream_seq`
 * trigger rejects the whole transaction. Measured, before it was moved: `stream run/<id> is at
 * sequence 4, cannot append 3`, which failed the `stage.execute` job into pg-boss's retry and
 * started the stage a second time.
 *
 * The rule the existing code was already written to, stated: **a foreign writer may append to a
 * run's stream only when it has taken the run's *ending* from the executor** — which is what
 * `cancelRunCommand` does (`RunRepository.finish` is conditional, and the executor then writes
 * nothing). A steer takes no ending, so it belongs on the stream that *is* re-read per transaction:
 * the task's. `recordArtifact` is the same decision one aggregate over, with the same one-line
 * reason in its own docblock.
 */
