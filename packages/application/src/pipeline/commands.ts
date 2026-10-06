/**
 * The commands a human (or a timer) issues against a running task.
 *
 * technical/02: "Interfaces and handlers issue commands; aggregates validate and emit events." The
 * saga listens to `task.question.answered` and `task.approval.decided`; **these** are what produce
 * them. They exist as use cases rather than as handler code for two reasons: the API (technical/08
 * `POST /api/tasks/:id/questions/:qid/answer`), the ticket-comment adapter and the Slack action
 * handler all issue the same command from three different transports, and each one has to write the
 * aggregate and its event in the same transaction.
 *
 * Every one of them is a **mutation**, so it fails closed: an answer to a question that is not open
 * is an `IllegalTransitionError` from the aggregate, and a permission the role does not carry is a
 * `PermissionDeniedError` from `can()`. Neither is caught here.
 */
import type {
  AnswerChannel,
  DomainEvent,
  Effort,
  Id,
  IsoDateTime,
  RunStatus,
  Slug,
  TokenUsage,
  UserRole,
} from '@platform/contracts';
import { agentRoleSchema, effortSchema, runModeSchema } from '@platform/contracts';
import type {
  CommandContext,
  FeedbackScope,
  IterationLoop,
  PipelineDecision,
  Run,
} from '@platform/domain';
import {
  answerQuestion,
  assertRunTransition,
  cancelTask,
  canTransitionTask,
  compilePipeline,
  decideApproval,
  evaluateIteration,
  expireApproval,
  expireQuestion,
  finishRun,
  handBackTask,
  IllegalTransitionError,
  InvariantViolationError,
  isActiveRunStatus,
  isBefore,
  isTaskFinished,
  MERGED_GATE_STAGE,
  markReadyForMerge,
  pauseTask,
  READY_FOR_MERGE_STAGE,
  recordFeedback,
  resetAgentIterations,
  stageOf,
  steerRun,
  takeOverTask,
  taskBranchName,
} from '@platform/domain';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import type { RunTakeOverExport } from '../ports/runner.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import {
  enqueueOutbound,
  enqueueReadyHeadCheck,
  enqueueStage,
  type PipelineOutboundData,
  type ReadyHeadCheckData,
} from './jobs.js';
import { type RunCommandWakeUp, runCommandsTopic } from './run-commands.js';
import type { StageExecutionJob } from './stage-executor.js';
import type {
  LockedRun,
  PipelineStore,
  RunCommandInstruction,
  StoredRun,
  StoredTask,
} from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';
import {
  type ApplyOptions,
  applyDecision,
  CANCELLED_OUTCOME,
  closeCurrentStageRow,
  ESCALATED_OUTCOME,
} from './transitions.js';

export interface TaskCommandDependencies {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly context: (correlationId: Id) => CommandContext;
  /**
   * TD-012 over the free text a command stores. Required: an absent redactor is no redactor
   * (standing rule 31).
   *
   * It sits on **this** interface rather than on {@link HumanCommandDependencies} because the two
   * commands that predate WP-15i store free text too: a question's `answer` reaches
   * `questions.answer`, the `task.question.answered` payload and — through the stage's next prompt —
   * a model, and an approval's `reason` reaches `approvals.reason` and `task.approval.decided`.
   * **Nine fields in all**: those two, the return reason, the rework instructions, the feedback
   * text, WP-27's hand-back summary and steer message, and the pause and take-over reasons that go
   * nowhere but the audit row ({@link auditedReason}). Each is redacted at the one command that
   * *decides* it rather than at each of the transports that can carry it (HTTP, a ticket comment, a
   * Slack action) — including the last two, which this ring redacts and hands back rather than
   * storing itself.
   */
  readonly redactor: SecretRedactor;
}

export class UnknownAggregateError extends Error {
  override readonly name = 'UnknownAggregateError';
}

/**
 * "First answer wins" (technical/02): the aggregate refuses a second answer, so two channels
 * racing produce one answer and one error rather than two answers.
 *
 * The answer is redacted here (TD-012) for the reason `redactor`'s own note gives, and this is the
 * field with the longest reach of the five: it is stored on the question, published in
 * `task.question.answered`, and read back into the **prompt** of the stage that asked — so a
 * credential a person pastes into an answer box would otherwise be handed to a model and to every
 * transcript of that run.
 */
export const answerTaskQuestion = async (
  deps: TaskCommandDependencies,
  input: {
    readonly questionId: Id;
    readonly answer: string;
    readonly userId: Id;
    readonly role: UserRole;
    readonly channel: AnswerChannel;
  },
): Promise<void> => {
  await deps.unitOfWork.transaction(async (scope) => {
    const question = await deps.store.questions.load(scope.tx, input.questionId);
    if (question === null) {
      throw new UnknownAggregateError(`question ${input.questionId} does not exist`);
    }
    const decision = answerQuestion(
      question,
      {
        answer: deps.redactor.redactText(input.answer).value,
        userId: input.userId,
        role: input.role,
        channel: input.channel,
      },
      deps.context(question.taskId),
    );
    await deps.store.questions.save(scope.tx, decision.aggregate);
    await scope.events.append(decision.events);
  });
};

/**
 * What a deadline timer found when it fired (WP-56) — the three answers re-validation can give.
 *
 * - `expired`: the deadline had passed and the aggregate was still waiting, so it expired now;
 * - `not_due`: the aggregate is still waiting and its deadline is **later** than this process's
 *   clock — a timer that fired early (the queue's clock is the database's, the deadline is this
 *   process's), which the caller re-arms at `dueAt` rather than acting on;
 * - `settled`: there is nothing to do — answered, decided, handed back, deleted, or a row written
 *   before WP-56 with no deadline at all. The normal case for a timer nobody can cancel (TD-004).
 */
export type DeadlineOutcome =
  | { readonly kind: 'expired' }
  /** A reminder kind counted its one reminder (WP-84, `reminders.ts`). */
  | { readonly kind: 'reminded' }
  | { readonly kind: 'not_due'; readonly dueAt: IsoDateTime }
  | { readonly kind: 'settled' };

const SETTLED: DeadlineOutcome = { kind: 'settled' };

/**
 * A task that is `done` or `cancelled` owes nobody an answer (WP-56 round 2): a question or an
 * approval it left open is not expired, because an expiry on a finished task would append an event
 * about a wait that ended with the task, and there is nobody the escalation could reach.
 */
const taskIsFinished = async (
  deps: TaskCommandDependencies,
  tx: Transaction,
  taskId: Id,
): Promise<boolean> => {
  const stored = await deps.store.tasks.load(tx, taskId);
  return stored === null || isTaskFinished(stored.task);
};
const EXPIRED: DeadlineOutcome = { kind: 'expired' };

/**
 * The `deadline.sweep` timer fired for a question (TD-004, WP-56). The saga escalates on the event
 * this emits.
 *
 * **This is the whole of the re-validation**, and it asks two questions rather than the one it used
 * to: *is the question still open* — the timer cannot be cancelled, so it fires for questions that
 * were answered meanwhile — and *has its deadline passed on this process's clock*. The second is
 * new: the job's `startAfter` is honoured by the queue's clock, so a timer can fire a moment before
 * the deadline the row stores, and expiring then would expire a question at 15:59:59 that BD-006
 * gave until 16:00. The boundary is **inclusive**: at the stored instant exactly, the deadline has
 * passed — otherwise a timer armed *at* the deadline would find it "not yet" for ever.
 */
export const expireTaskQuestion = async (
  deps: TaskCommandDependencies,
  questionId: Id,
): Promise<DeadlineOutcome> =>
  deps.unitOfWork.transaction(async (scope) => {
    const question = await deps.store.questions.load(scope.tx, questionId);
    if (question === null || question.status !== 'open' || question.deadlineAt === null) {
      return SETTLED;
    }
    if (await taskIsFinished(deps, scope.tx, question.taskId)) {
      return SETTLED;
    }
    const context = deps.context(question.taskId);
    if (isBefore(context.clock.now(), question.deadlineAt)) {
      return { kind: 'not_due', dueAt: question.deadlineAt };
    }
    const decision = expireQuestion(question, context);
    await deps.store.questions.save(scope.tx, decision.aggregate);
    await scope.events.append(decision.events);
    return EXPIRED;
  });

/**
 * BD-006: only a mapped maintainer decides, which `decideApproval` enforces through `can()`.
 *
 * The reason is stored on the approval and published in `task.approval.decided`, so it is redacted
 * here like every other piece of free text a command writes (see `redactor`).
 */
export const decideTaskApproval = async (
  deps: TaskCommandDependencies,
  input: {
    readonly approvalId: Id;
    readonly decision: 'approved' | 'rejected';
    readonly userId: Id;
    readonly role: UserRole;
    readonly reason?: string;
  },
): Promise<void> => {
  await deps.unitOfWork.transaction(async (scope) => {
    const stored = await deps.store.approvals.load(scope.tx, input.approvalId);
    if (stored === null) {
      throw new UnknownAggregateError(`approval ${input.approvalId} does not exist`);
    }
    const decision = decideApproval(
      stored.approval,
      {
        decision: input.decision,
        userId: input.userId,
        role: input.role,
        ...(input.reason === undefined
          ? {}
          : { reason: deps.redactor.redactText(input.reason).value }),
      },
      deps.context(stored.approval.taskId),
    );
    await deps.store.approvals.save(scope.tx, { ...stored, approval: decision.aggregate });
    await scope.events.append(decision.events);
  });
};

/**
 * The `deadline.sweep` timer fired for an approval (WP-56, BD-006's Q95 amendment). The saga's
 * `approvalHandler` escalates on the `expired` decision this emits.
 *
 * Re-validates exactly as {@link expireTaskQuestion} does: a decided approval is `settled`, and one
 * whose deadline this process's clock has not reached is `not_due`. Until WP-56 this function had
 * **no caller at all**, production or test (PROGRESS backlog 76).
 */
export const expireTaskApproval = async (
  deps: TaskCommandDependencies,
  approvalId: Id,
): Promise<DeadlineOutcome> =>
  deps.unitOfWork.transaction(async (scope) => {
    const stored = await deps.store.approvals.load(scope.tx, approvalId);
    if (
      stored === null ||
      stored.approval.status !== 'pending' ||
      stored.approval.deadlineAt === null
    ) {
      return SETTLED;
    }
    if (await taskIsFinished(deps, scope.tx, stored.approval.taskId)) {
      return SETTLED;
    }
    const context = deps.context(stored.approval.taskId);
    if (isBefore(context.clock.now(), stored.approval.deadlineAt)) {
      return { kind: 'not_due', dueAt: stored.approval.deadlineAt };
    }
    const decision = expireApproval(stored.approval, context);
    await deps.store.approvals.save(scope.tx, { ...stored, approval: decision.aggregate });
    await scope.events.append(decision.events);
    return EXPIRED;
  });

// ── The human command surface (WP-15i) ───────────────────────────────────────

/**
 * What the nine commands `POST /api/tasks/:id/…` and `POST /api/runs/:id/…` need, beyond what the
 * two above do.
 *
 * The two commands that existed before this row keep their names (`answerTaskQuestion`,
 * `decideTaskApproval`) because three transports already call them; everything added here carries a
 * `…Command` suffix so a grep for the HTTP surface finds one list.
 *
 * ## Four properties every one of them has
 *
 * **The aggregate decides.** Each loads the task (or the run), hands the move to a domain function,
 * and lets the refusal out: `IllegalTransitionError` for a state machine that has no such edge,
 * `InvariantViolationError` for a command whose subject does not exist. Nothing here inspects a
 * state and decides for itself what is allowed — that is the table in `task-state-machine.ts`, and
 * a second copy would be a second answer.
 *
 * **No HTTP request escalates a task.** Two paths could, and both are closed deliberately. A write
 * that loses every race throws {@link TaskConflictExhaustedError} to the caller (a `409`) instead of
 * calling `escalateTaskAfterConflict` the way the pipeline's own jobs do — the caller is a person
 * who can press the button again, where a job has nobody to tell. And a bounded loop that is spent
 * is refused **before** `returnToStage` is called, because that function's own ending for a spent
 * loop is `needs_human`: BD-008's ceiling still holds (the counter never passes its limit and the
 * task never goes round again), and the human is told rather than the task being parked on their
 * behalf.
 *
 * **A stage that has to run is enqueued after the commit**, never inside it: `Jobs.enqueue` does not
 * join the transaction (TD-004), and every job re-validates when it fires. A process with no queue
 * refuses these commands by name ({@link CommandsUnavailableError}) rather than moving a task to a
 * stage nothing will run — the argument `startProjectDiscovery` makes for the same shape.
 *
 * **Free text is redacted where it is stored.** A reason, a set of rework instructions and a piece
 * of feedback are untrusted human text (BD-022) on their way into `task_stages.return_reason`, a
 * `task.stage.returned` payload and a `feedback.received` payload. They go through the composed
 * redactor (TD-012) here, at the one place that writes them, rather than at each transport — as do
 * the two fields the commands **above** store, a question's answer and an approval's reason, which
 * is why `redactor` is a field of {@link TaskCommandDependencies} and not of this interface. The
 * two that are stored by **no** table this ring writes — a pause's reason and a take-over's — are
 * redacted here too and *returned* for the transport's `human_actions` row ({@link auditedReason}),
 * because where the words are kept is the transport's business and whether they are safe to keep is
 * not.
 */
export interface HumanCommandDependencies extends TaskCommandDependencies {
  /** `null` on a process that runs no workers; the commands that need a stage refuse by name. */
  readonly jobs: Jobs | null;
  /**
   * Where a run's next `stream_seq` comes from when the run is ended from **another process**.
   *
   * The stage executor holds the `Run` aggregate it created and knows the sequence; a cancelling
   * request has only the row, and `runs` stores no sequence. `nextStreamSequence` is the same
   * question `intake-reconcile.ts` asks for the same reason, and the `events` table is its one
   * authority (standing rule 9).
   */
  readonly eventStore: EventStore;
  /**
   * The task cap a task with no override of its own is held to — `ProjectSettings.taskBudgetUsd`,
   * what {@link raiseTaskBudgetCommand} compares a raise against (WP-131 review round 1). Required,
   * so a composition cannot leave the comparison to a constant the task cap does not read (a
   * harness at a 20 USD cap was refused a raise to 50 against a hard-coded 50 — measured).
   */
  readonly defaultTaskCapUsd: number;
  readonly logger?: Logger;
}

/** A command that needs a queue, on a process that composed none. */
export class CommandsUnavailableError extends Error {
  override readonly name = 'CommandsUnavailableError';
}

/** The command names a stage the task is not at. Refused rather than guessed at. */
export class StageNotCurrentError extends Error {
  override readonly name = 'StageNotCurrentError';
  readonly requested: Slug;
  readonly current: Slug | null;

  constructor(requested: Slug, current: Slug | null) {
    super(
      `this task is at "${current ?? 'no stage'}", not at "${requested}": retrying a stage the task ` +
        'has left is a return, which is a different command',
    );
    this.requested = requested;
    this.current = current;
  }
}

/** The bounded loop a human-initiated return spends is already at its limit (BD-008). */
export class IterationLimitReachedError extends Error {
  override readonly name = 'IterationLimitReachedError';
  readonly loop: IterationLoop;
  readonly limit: number;

  constructor(loop: IterationLoop, limit: number) {
    super(
      `this task has been round the "${loop}" loop ${limit} times, which is its limit (BD-008); ` +
        'the platform will not send it back again. Cancel it, or take it over and finish it by hand',
    );
    this.loop = loop;
    this.limit = limit;
  }
}

/**
 * The command named a stage this task's template does not run (WP-27).
 *
 * Refused rather than entered, because entering a stage the compiled pipeline does not name
 * produces a task that is `active` at a stage **nothing will ever run**: `applyDecision`'s `enter`
 * schedules work only for a stage whose `kind` is `agent` or `gate`, and an unknown id has no kind
 * at all. A disabled stage is refused for the same reason from the other direction — the
 * interpreter walks *past* it, so a task parked there would be waiting for a stage the project
 * switched off.
 */
export class StageNotInTemplateError extends Error {
  override readonly name = 'StageNotInTemplateError';
  readonly stage: Slug;

  constructor(stage: Slug, template: Slug, available: readonly Slug[]) {
    super(
      `template "${template}" has no enabled stage "${stage}", so this task cannot be sent there; ` +
        `it runs: ${available.join(', ')}`,
    );
    this.stage = stage;
  }
}

/** The run is not in a status this command can act on; the Run state machine said so. */
export class RunNotLiveError extends Error {
  override readonly name = 'RunNotLiveError';
  readonly runId: Id;
  readonly status: RunStatus;

  constructor(runId: Id, status: RunStatus, what: string) {
    super(`run ${runId} is "${status}", so it cannot be ${what}`);
    this.runId = runId;
    this.status = status;
  }
}

/** technical/08 — *"`POST /api/runs/:id/steer` limited to 1 message per 5 s per user"*, verbatim. */
export const STEER_MIN_INTERVAL_MS = 5_000;

/**
 * The steer window refused this one: the same person had a steer recorded within
 * {@link STEER_MIN_INTERVAL_MS} (technical/08). The HTTP answer is `429 rate_limited`.
 *
 * Raised from inside the recording transaction, after the run and the role were checked, so a steer
 * refused for any other reason says that reason rather than this one — and a refused steer records
 * nothing, so it never takes a slot (WP-73's refund, now a property of the row rather than of a
 * per-process map).
 */
export class SteerWindowClosedError extends Error {
  override readonly name = 'SteerWindowClosedError';

  constructor() {
    super(
      `steering is limited to one message every ${STEER_MIN_INTERVAL_MS / 1_000} seconds per person (technical/08); your last message was accepted moments ago, try again in a moment`,
    );
  }
}

/**
 * The bounded loop a **human** return spends.
 *
 * BD-008's "human MR rounds" — the same counter a batch of merge-request comments spends — because
 * both are a person sending the task backwards, and giving the button its own unbounded channel
 * would make the ceiling reachable only by the agents. `resumeStage` and `retryStageCommand` spend
 * nothing: re-entering the stage the task is already at costs a run, not a round.
 */
export const HUMAN_RETURN_LOOP: IterationLoop = 'human_rounds';

const humanContext = (deps: HumanCommandDependencies, taskId: Id, userId: Id): CommandContext => ({
  ...deps.context(taskId),
  // The person, not the pipeline: `human_actions` records the command and the event log records who
  // caused the state change, and the two have to name the same user.
  actor: { kind: 'user', user_id: userId },
});

const loadTaskOrThrow = async (
  deps: HumanCommandDependencies,
  tx: Transaction,
  taskId: Id,
): Promise<StoredTask> => {
  const stored = await deps.store.tasks.load(tx, taskId);
  if (stored === null) {
    throw new UnknownAggregateError(`task ${taskId} does not exist`);
  }
  return stored;
};

const requireJobs = (deps: HumanCommandDependencies): Jobs => {
  if (deps.jobs === null) {
    throw new CommandsUnavailableError(
      'this process runs no job workers, so it cannot start a stage: the task would be moved and nothing would run it. Ask an instance that runs the workers',
    );
  }
  return deps.jobs;
};

/**
 * The work a command left for after the commit: a stage job (with the overrides that belong to this
 * attempt), or — for a human's way into `ready_for_merge` (WP-79) — the `ready_head_check` wake-up.
 */
type ScheduledWork =
  | {
      readonly job: StageExecutionJob;
      readonly overrides?: { readonly model?: string; readonly effort?: Effort };
    }
  | { readonly readyCheck: ReadyHeadCheckData };

/**
 * One transaction, on {@link retryOnTaskConflict}'s bound, with the follow-up enqueued after it.
 *
 * The retry re-runs the whole unit, so whatever it read it reads again — which is the property a
 * retry inside one transaction could not give. When the bound is spent the error reaches the
 * caller; see the module note on why it is not an escalation.
 */
const writeTask = async <T>(
  deps: HumanCommandDependencies,
  input: { readonly taskId: Id; readonly userId: Id; readonly what: string },
  unit: (
    scope: TransactionScope,
    stored: StoredTask,
    context: CommandContext,
  ) => Promise<{ readonly result: T; readonly work: ScheduledWork | null }>,
): Promise<T> => {
  const outcome = await retryOnTaskConflict(
    {
      taskId: input.taskId,
      what: input.what,
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    },
    async () =>
      deps.unitOfWork.transaction(async (scope) => {
        const stored = await loadTaskOrThrow(deps, scope.tx, input.taskId);
        return unit(scope, stored, humanContext(deps, stored.task.id, input.userId));
      }),
  );
  const work = outcome.work;
  if (work !== null && 'readyCheck' in work) {
    await enqueueReadyHeadCheck(requireJobs(deps), work.readyCheck);
  } else if (work !== null) {
    const enqueued = await enqueueStage(requireJobs(deps), {
      ...work.job,
      ...(work.overrides === undefined ? {} : { overrides: work.overrides }),
    });
    if (enqueued.status === 'coalesced') {
      // Stated, not silent (backlog 494): another job for the task holds the queue's one waiting
      // slot. When it fires for an older attempt it forwards the wake-up to this one
      // (`supersededBy`, `./jobs.ts`); for this attempt, it is this wake-up already.
      deps.logger?.warn(
        { task_id: work.job.taskId, stage: work.job.stage, attempt: work.job.attempt },
        'the stage job a human command enqueued was coalesced onto one already waiting for the task',
      );
    }
  }
  return outcome.result;
};

/**
 * **The one way a human command enters a stage** (WP-79 review round 1) — and for
 * `ready_for_merge` it does not enter it at all.
 *
 * Every other stage is entered through {@link applyHumanDecision} as before. Ready is judged by the
 * branch head (PROGRESS backlog 267): the aggregate is asked whether the move is legal — a dry run
 * of `markReadyForMerge`, discarded, so a refused edge is still the command's 409 — nothing is
 * written, and the `ready_head_check` duty is left for after the commit (`ready-head.ts`), which
 * re-enters `rebase_gate` for the head the gates judged (WP-105, backlogs 274 and 337) and `ci_gate`
 * otherwise, so Ready is entered only by the rebase gate's settlement. Resume, retry-stage,
 * retry-run and hand-back all come through here; {@link applyHumanDecisionRecorded} refuses a Ready
 * entry that did not, so a new command that forgets is a 500 in its first test rather than a side
 * door.
 */
const humanEnter = async (
  deps: HumanCommandDependencies,
  scope: TransactionScope,
  stored: StoredTask,
  context: CommandContext,
  entry: {
    readonly stage: Slug;
    readonly via: ReadyHeadCheckData['via'];
    readonly userId: Id;
    readonly cause: string | null;
  },
): Promise<ScheduledWork | null> => {
  if (entry.stage === READY_FOR_MERGE_STAGE) {
    markReadyForMerge(stored.task, context);
    return { readyCheck: readyHeadCheckFor(stored, entry) };
  }
  const job = await applyHumanDecision(deps, scope, stored, context, {
    kind: 'enter',
    stage: entry.stage,
  });
  return job === null ? null : { job };
};

/**
 * Applies a decision the **human** made, through the same path the interpreter's own decisions take.
 *
 * `applyDecision` is what knows that entering `ready_for_merge` is a different task command from
 * entering `implementation`, that a system stage completes the moment it is entered, and what
 * `task_stages` bookkeeping each move owes. Re-implementing any of it here would be a second answer
 * to the same question (standing rule 9), so the command builds the decision and this applies it.
 *
 * `onIllegalTransition: 'throw'` is the one difference from the saga's use of it: a human pressing a
 * button that the task's state has no edge for gets a `409`, where the pipeline asking for one is a
 * broken template and escalates.
 */
const applyHumanDecision = async (
  deps: HumanCommandDependencies,
  scope: TransactionScope,
  stored: StoredTask,
  context: CommandContext,
  decision: PipelineDecision,
): Promise<StageExecutionJob | null> =>
  (await applyHumanDecisionRecorded(deps, scope, stored, context, decision)).work;

/** {@link applyHumanDecision}, answering the events it appended as well — the rework's cause id. */
const applyHumanDecisionRecorded = async (
  deps: HumanCommandDependencies,
  scope: TransactionScope,
  stored: StoredTask,
  context: CommandContext,
  decision: PipelineDecision,
  extra: Pick<ApplyOptions, 'returnFromEscalation' | 'stageOutcome'> = {},
): Promise<{
  readonly work: StageExecutionJob | null;
  readonly events: readonly { readonly id: string; readonly type: string }[];
}> => {
  if (decision.kind === 'enter' && decision.stage === READY_FOR_MERGE_STAGE) {
    // WP-79 review round 1: the census of human ways into Ready, enforced here rather than listed.
    // A human command enters Ready only through `humanEnter`, which never gets this far with it.
    throw new InvariantViolationError(
      'human entry into ready_for_merge',
      `a human command tried to enter ready_for_merge for task ${stored.task.id} directly; it must go through the ready_head_check duty (humanEnter)`,
    );
  }
  const applied = await applyDecision({
    store: deps.store,
    pipeline: compilePipeline(stored.task.template, stored.template, stored.pipelineDial),
    tx: scope.tx,
    stored,
    decision,
    context,
    // No event caused this: a person did. `task_stages.caused_by_event_id` is null for the row a
    // human command writes, which is how the audit tells the two apart.
    causedByEventId: null,
    onIllegalTransition: 'throw',
    ...extra,
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  if (applied.events.length > 0) {
    await scope.events.append(applied.events);
  }
  return { work: applied.work, events: applied.events };
};

/** The stage the task is at, or a refusal naming the fact that it is at none. */
const currentStageOrThrow = (stored: StoredTask, what: string): Slug => {
  const stage = stored.task.currentStage;
  if (stage === null) {
    throw new InvariantViolationError(
      what,
      `task ${stored.task.id} is "${stored.task.state}" and has entered no stage, so there is nothing to ${what}`,
    );
  }
  return stage;
};

/** What a command whose free text has no home but the audit row gives back to its transport. */
export interface AuditedReason {
  /** The human's own words, redacted (TD-012), or `null` when they sent none. */
  readonly reason: string | null;
}

/**
 * The one piece of free text this module **returns** instead of storing (WP-27's fix round).
 *
 * `pause` and `take over` are the two commands whose reason has nowhere else to go: `task.paused`
 * carries the *kind* of pause and `task.taken_over` the branch, the stage and the session, so
 * neither event has a field for a sentence and inventing one would change a published payload for
 * one caller. The `human_actions` row the transport writes is therefore the only place the words
 * land — which is what `/pause`'s own description has claimed since WP-15i while its route recorded
 * nothing, and what `/take-over` accepted through a strict schema and dropped on the floor.
 *
 * It is redacted **here** rather than at the transport for the reason every other field is (see
 * `redactor`): a stored copy of untrusted human text is TD-012's business, the redactor lives in
 * this ring, and an HTTP route that redacted its own audit row would be a second site to keep
 * right. The route records what this returned; it never reads the body for the row.
 */
const auditedReason = (
  deps: TaskCommandDependencies,
  reason: string | undefined,
): AuditedReason => ({
  reason: reason === undefined ? null : deps.redactor.redactText(reason).value,
});

/**
 * `POST /api/tasks/:task_id/pause` — product/03's "pause task".
 *
 * `reason: 'manual'` is the *kind* of pause the event carries (`PauseReason`); the human's own words
 * are handed back to the transport for the `human_actions` row, redacted — see
 * {@link auditedReason} for why that is the only home they have and why the redaction is here.
 *
 * A run already in flight is **not** stopped — a pause is about the task, not the session — but it
 * can no longer advance the task: the stage executor records the run and stops, because
 * `isRunnableTaskState` is false for a paused task. Stopping the session itself is
 * `POST /api/runs/:run_id/cancel`, which reaches the process holding it since WP-101 (TD-028
 * decision 11), and that is why both commands exist.
 */
export const pauseTaskCommand = async (
  deps: HumanCommandDependencies,
  input: { readonly taskId: Id; readonly userId: Id; readonly reason?: string },
): Promise<AuditedReason> => {
  // Before the transaction, because it is not part of it: nothing here is stored by this command,
  // and a redaction that ran inside the write would hold a connection for a pure string pass.
  const audited = auditedReason(deps, input.reason);
  await writeTask(
    deps,
    { taskId: input.taskId, userId: input.userId, what: 'pausing the task' },
    async (scope, stored, context) => {
      const decision = pauseTask(stored.task, { reason: 'manual' }, context);
      await deps.store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
      await scope.events.append(decision.events);
      return { result: undefined, work: null };
    },
  );
  return audited;
};

/**
 * The cap a raise must exceed: the override in force, or the task cap's default when there is none.
 * Refused as a 409 by the route (`TaskBudgetNotRaisedError`), because "not above the cap" is a fact
 * about the task's state rather than a malformed request.
 */
export class TaskBudgetNotRaisedError extends Error {
  override readonly name = 'TaskBudgetNotRaisedError';
  readonly currentCapUsd: number;
  readonly requestedCapUsd: number;

  constructor(requestedCapUsd: number, currentCapUsd: number) {
    super(
      `this task's cap is ${currentCapUsd} USD, and ${requestedCapUsd} USD is not above it: a ` +
        "task's cap can only be raised",
    );
    this.currentCapUsd = currentCapUsd;
    this.requestedCapUsd = requestedCapUsd;
  }
}

/**
 * A raise on a task that its **own** cap did not pause (WP-131 review round 2): running, paused by a
 * person, or paused by another cap. A 409 at the route, naming which.
 */
export class TaskNotPausedByItsCapError extends Error {
  override readonly name = 'TaskNotPausedByItsCapError';

  constructor(taskId: Id, state: string, pausedBy: string | null) {
    super(
      state !== 'paused'
        ? `task ${taskId} is ${state}: its cap is raised only while its own cap has paused it`
        : pausedBy === null
          ? `task ${taskId} was not paused by its own cap, so raising it would resume nothing`
          : `task ${taskId} was paused by the ${pausedBy} cap, which is raised where it is set, not here`,
    );
  }
}

/**
 * `POST /api/tasks/:task_id/budget` — **raise** this task's cap (WP-131 review round 1, the
 * orchestrator's ruling on PROGRESS backlog 402's exit).
 *
 * A task the cap paused — on spend, or on a run nobody measured that the cap **holds** at its
 * reservation (`../cost/pending.ts`) — waits for a human to raise the cap, and until this command
 * nothing could: `ProjectSettings.taskBudgetUsd` is the constant `DEFAULT_TASK_BUDGET_USD`, with no
 * key, API or screen. The override is stored on the task (`tasks.budget_cap_usd`, one narrow writer)
 * and read by the task cap in place of the default. It never lowers a cap and never "releases" a
 * hold: the hold is a bound on money nobody measured, and the human's answer to it is a bigger cap,
 * named as theirs in `human_actions`.
 *
 * The comparison's default is the composition's `defaultTaskCapUsd` — the cap the task cap reads
 * when a task has no override. It moves no state: the task is resumed by the resume command.
 */
export const raiseTaskBudgetCommand = async (
  deps: HumanCommandDependencies,
  input: { readonly taskId: Id; readonly userId: Id; readonly capUsd: number },
): Promise<{ readonly capUsd: number; readonly previousCapUsd: number }> =>
  deps.unitOfWork.transaction(async (scope) => {
    const stored = await loadTaskOrThrow(deps, scope.tx, input.taskId);
    // WP-131 review round 2: only a task **its own cap** paused. A project's, an organisation's or
    // a feature's cap pausing the task is raised where that cap is set; raising this one for it
    // would loosen a safety cap for good (nothing lowers it) and resume into the same pause.
    const pausedBy =
      stored.task.state === 'paused'
        ? await deps.store.tasks.pausedBudgetScope(scope.tx, input.taskId)
        : null;
    if (pausedBy !== 'task') {
      throw new TaskNotPausedByItsCapError(input.taskId, stored.task.state, pausedBy);
    }
    const written = await deps.store.tasks.raiseBudgetCap(scope.tx, {
      taskId: input.taskId,
      capUsd: input.capUsd,
      defaultCapUsd: deps.defaultTaskCapUsd,
    });
    if (!written.raised) {
      throw new TaskBudgetNotRaisedError(input.capUsd, written.previousCapUsd);
    }
    return { capUsd: input.capUsd, previousCapUsd: written.previousCapUsd };
  });

/**
 * `POST /api/tasks/:task_id/resume` — re-enter the stage the task stopped at.
 *
 * It spends **no** iteration round: the task stood still, it did not go round. That is the same
 * reading `resumeStage` is written to (a question round is spent by the *question*, not by the
 * resumption), and it is why a paused task can always be resumed while a spent loop cannot be
 * re-entered by `return-to-stage`.
 *
 * The state machine is what refuses the rest: `paused → active` exists, and so, since WP-73
 * (PROGRESS backlog 244), does `paused → ready_for_merge`. A move the table does not have is a
 * `409` naming the transition rather than a silent no-op. (`paused → returned` is **not** an edge,
 * so `return-to-stage` is no way out of a pause.)
 *
 * **A task paused at `ready_for_merge` is not moved here** (WP-79, PROGRESS backlog 267). A pause
 * at Ready may be a take-over, and the human may have pushed: so the command asks the aggregate
 * whether the move is legal (a dry run of `markReadyForMerge`, discarded — the same 409 as before),
 * writes nothing, and hands the decision to the `ready_head_check` duty after the commit, which
 * compares the branch's live head with the head the gates judged and re-enters `rebase_gate` (the
 * same head, WP-105) or `ci_gate` (any other, WP-79) — `ready-head.ts`. The task therefore reads
 * `paused` until the duty runs.
 */
export const resumeTaskCommand = async (
  deps: HumanCommandDependencies,
  input: { readonly taskId: Id; readonly userId: Id },
): Promise<void> => {
  requireJobs(deps);
  return writeTask(
    deps,
    { ...input, what: 'resuming the task' },
    async (scope, stored, context) => {
      const stage = currentStageOrThrow(stored, 'resume');
      const work = await humanEnter(deps, scope, stored, context, {
        stage,
        via: 'resume',
        userId: input.userId,
        cause: null,
      });
      return { result: undefined, work };
    },
  );
};

/**
 * The wake-up a human's way into `ready_for_merge` leaves for the `ready_head_check` duty (WP-79):
 * the state and stage the command saw, which the duty re-validates against, and the person.
 */
const readyHeadCheckFor = (
  stored: StoredTask,
  input: {
    readonly via: ReadyHeadCheckData['via'];
    readonly userId: Id;
    readonly cause: string | null;
  },
): ReadyHeadCheckData => ({
  duty: 'ready_head_check',
  project_id: stored.task.projectId,
  task_id: stored.task.id,
  via: input.via,
  expected_state: stored.task.state,
  expected_stage: stored.task.currentStage ?? READY_FOR_MERGE_STAGE,
  user_id: input.userId,
  cause_event_id: input.cause,
});

/**
 * `POST /api/tasks/:task_id/cancel` — the human ends the task (product/04: cancellable at any point).
 *
 * The totals are read from the runs, not from the request: `task.cancelled` carries what the task
 * actually spent, and a cancelled task is the one place a reader wants that number most.
 */
export const cancelTaskCommand = async (
  deps: HumanCommandDependencies,
  input: { readonly taskId: Id; readonly userId: Id },
): Promise<void> =>
  writeTask(deps, { ...input, what: 'cancelling the task' }, async (scope, stored, context) => {
    const totals = await deps.store.runs.totalsFor(scope.tx, stored.task.id);
    const decision = cancelTask(
      stored.task,
      {
        outcome: 'cancelled by a human',
        totals: {
          cost_usd: totals.costUsd,
          is_estimate: totals.isEstimate,
          // WP-131 (backlog 403): what `cost_usd` excludes, so a reader of the total is told.
          unmeasured_runs: totals.unmeasuredRuns,
          runs: totals.runs,
          wall_ms: totals.wallMs,
        },
      },
      context,
    );
    await deps.store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
    // The attempt the task was at can never resume now, paused or not (WP-46, backlog 212).
    await closeCurrentStageRow(
      deps.store,
      scope.tx,
      stored.task,
      CANCELLED_OUTCOME,
      'the task was cancelled by a human',
    );
    await scope.events.append(decision.events);
    return { result: undefined, work: null };
  });

/**
 * What `retry-stage` did, so the person who pressed it is told (PROGRESS backlog 494).
 *
 * `attempt` is the attempt the stage was entered at — `null` at `ready_for_merge`, which the request
 * does not enter (the `ready_head_check` duty does, WP-79). `stoppedRun` is the stage's run that was
 * still in flight when the retry landed, and how it is being stopped: `commandId` names the `cancel`
 * recorded for the process holding its lease, `null` when no process held it and the record was
 * ended here. `null` when no run of the stage was live.
 */
export interface RetryStageOutcome {
  readonly attempt: number | null;
  readonly stoppedRun: { readonly runId: Id; readonly commandId: Id | null } | null;
}

/**
 * `POST /api/tasks/:task_id/retry-stage` — run the current stage again, as a new attempt.
 *
 * A **retry**, so the stage must be the one the task is at: sending it somewhere else is
 * `return-to-stage`, which counts a round and records a reason on the stage it leaves.
 *
 * **A run of the stage still in flight is stopped, in the same transaction** (PROGRESS backlog 494).
 * The attempt counter moving was all this did before, and the docblock said that *superseded* the
 * old run. It did not: the executor's `revalidate` skips a *job* whose attempt has passed, but the
 * old run was already past that check, so it ran on, completed the stage on the task's new attempt,
 * and the new attempt's job — queued behind it, because `stage.execute` is `stately` per task —
 * found the task at the next stage and did nothing. The person was answered 200; no second run
 * started (first local test, 2026-10-06). Now the live run is stopped through the run cancel's own
 * path (TD-028 decision 11): a `cancel` row for the process holding its lease, which interrupts the
 * session and ends the run `cancelled` with what it measured — or, with no live lease, the record
 * ended here. The task is **not** paused, unlike a run cancel: the retry is the person's next
 * instruction. The executor's recording transaction asks `isCurrentStageAttempt` and records a
 * superseded run without completing anything, and the new attempt's job runs once the old one has
 * ended — so a new attempt is never queued behind a run whose result would have won.
 */
export const retryStageCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly taskId: Id;
    readonly userId: Id;
    readonly stage: Slug;
    /** The stop's `run_commands` id when one is recorded; see {@link steerRunCommand}'s. */
    readonly stopCommandId?: Id;
  },
): Promise<RetryStageOutcome> => {
  requireJobs(deps);
  return writeTask(deps, { ...input, what: 'retrying a stage' }, async (scope, stored, context) => {
    if (stored.task.currentStage !== input.stage) {
      throw new StageNotCurrentError(input.stage, stored.task.currentStage);
    }
    // Before the task row is written: `runs` then `tasks`, the order the run's ending takes. The
    // stage's run only — an ask beside it is not the attempt being retried.
    const live = await deps.store.runCommands.lockLiveRunOf(scope.tx, stored.task.id, {
      forUpdate: true,
      stage: input.stage,
    });
    const stoppedRun =
      live === null ? null : await stopRunForRetry(deps, scope, live, context, input);
    // At `ready_for_merge` this is the ready-head check, not an entry (WP-79 review round 1).
    const work = await humanEnter(deps, scope, stored, context, {
      stage: input.stage,
      via: 'retry_stage',
      userId: input.userId,
      cause: null,
    });
    const attempt = work !== null && 'job' in work ? work.job.attempt : null;
    return { result: { attempt, stoppedRun }, work };
  });
};

/**
 * {@link retryStageCommand}'s stop: the run cancel's two branches (TD-028 decision 11) without its
 * pause. With a live lease the stop is **recorded** for the holder, which ends the run itself with
 * the cost it measured; with none, nothing is driving the session, so the record is ended here.
 */
const stopRunForRetry = async (
  deps: HumanCommandDependencies,
  scope: TransactionScope,
  live: LockedRun,
  context: CommandContext,
  input: { readonly userId: Id; readonly stopCommandId?: Id },
): Promise<{ readonly runId: Id; readonly commandId: Id | null }> => {
  assertRunTransition(live.status, 'cancelled');
  if (leaseIsLive(live, context.clock.now())) {
    const commandId = input.stopCommandId ?? context.ids.next();
    await recordRunCommand(deps, scope, live, {
      id: commandId,
      actorUserId: input.userId,
      instruction: { kind: 'cancel' },
    });
    return { runId: live.runId, commandId };
  }
  const run = await deps.store.runs.load(scope.tx, live.runId);
  if (run === null) {
    throw new UnknownAggregateError(`run ${live.runId} does not exist`);
  }
  await scope.events.append(await endRunRecordInPlace(deps, scope, run, context));
  return { runId: live.runId, commandId: null };
};

/** What a human return leaves behind for the stage it goes back to, and for a spent loop. */
const returnBrief = (stored: StoredTask, to: Slug): string =>
  `A person sent ${stored.task.ticket.key} back to "${to}" as many times as the ` +
  `${HUMAN_RETURN_LOOP} limit allows. Read what they asked for, then either finish it by hand or ` +
  'cancel the task.';

/**
 * The return named a stage this task has not been through **at or before** the one it is at
 * (PROGRESS backlog 483). A 409 at the route, `stage_not_reached`.
 */
export class StageNotReachedError extends Error {
  override readonly name = 'StageNotReachedError';
  readonly stage: Slug;

  constructor(stage: Slug, current: Slug) {
    super(
      `this task has not been through "${stage}" on its way to "${current}", so it cannot be sent ` +
        'back there: a return goes to a stage the task has already run, at or before the one it is at',
    );
    this.stage = stage;
  }
}

/**
 * **Where a human return may go** (PROGRESS backlog 483): a stage the task's own compiled template
 * runs and has enabled ({@link StageNotInTemplateError}), that the task has **entered** at least
 * once, and that sits **at or before** the stage it is at in the template's order
 * ({@link StageNotReachedError}).
 *
 * Until backlog 483 `return-to-stage` and `rework` checked none of it — the product's own wording
 * (user guide: *"sends the task back to an earlier stage"*) was a promise the command did not keep,
 * and a stage id the template does not run left the task `active` at a stage nothing would ever
 * run, which is the defect `StageNotInTemplateError` was written for the hand-back. It matters more
 * once an **escalated** task can be returned, because the person choosing the stage is reading a
 * blocker brief, not the template. The current stage itself is admitted — a return to it, or a
 * rework of it, is a new attempt with the person's words, which `retry-stage` does not carry — and
 * so is any earlier stage the task ran, whichever loop brought it there.
 */
const assertReturnTarget = (stored: StoredTask, from: Slug, to: Slug): void => {
  const pipeline = compilePipeline(stored.task.template, stored.template, stored.pipelineDial);
  const enabled = pipeline.stages.filter((entry) => entry.enabled);
  const target = enabled.findIndex((entry) => entry.id === to);
  if (target === -1) {
    throw new StageNotInTemplateError(
      to,
      stored.task.template,
      enabled.map((entry) => entry.id),
    );
  }
  const current = pipeline.stages.findIndex((entry) => entry.id === from);
  const targetPosition = pipeline.stages.findIndex((entry) => entry.id === to);
  if (stored.task.stageAttempts[to] === undefined || (current !== -1 && targetPosition > current)) {
    throw new StageNotReachedError(to, from);
  }
};

/**
 * What applies a human return to an **escalated** task differently (PROGRESS backlog 483):
 * through `returnEscalatedTask` — out of `needs_human` and back in one aggregate decision — and
 * with the parked attempt's row closed `escalated` rather than `returned`, because that attempt
 * ended in the escalation, not in a verdict a person is now acting on: a Checks-panel item reading
 * the row must not call a gate the platform could not decide a *failure*. Empty for every other
 * state, so a return from `active` or `ready_for_merge` is applied exactly as before.
 */
const escalationReturn = (
  stored: StoredTask,
): Pick<ApplyOptions, 'returnFromEscalation' | 'stageOutcome'> =>
  stored.task.state === 'needs_human'
    ? { returnFromEscalation: true, stageOutcome: ESCALATED_OUTCOME }
    : {};

/** Refuses before the aggregate can escalate; see the module note on why that is the ending here. */
const assertLoopHasRoom = (stored: StoredTask): void => {
  const iteration = evaluateIteration(
    stored.task.iterationCounters,
    HUMAN_RETURN_LOOP,
    stored.task.limits,
  );
  if (!iteration.allowed) {
    throw new IterationLimitReachedError(HUMAN_RETURN_LOOP, iteration.limit);
  }
};

/**
 * `POST /api/tasks/:task_id/return-to-stage` — product/03's "force return to a stage with a note".
 *
 * The note is required by the contract and is what the next run is given: it reaches
 * `task_stages.return_reason`, the `task.stage.returned` event and, through
 * `StageRunRequest.returnFeedback`, the prompt. So it is redacted here (TD-012) — the one place it
 * is written — rather than at the transport that happened to carry it.
 *
 * **From `needs_human` too** (PROGRESS backlog 483): the person handling an escalation is the one
 * who knows which earlier stage should run again, so the same command, under the same rules — the
 * target ({@link assertReturnTarget}), a human round spent (BD-008), the reason redacted and handed
 * to the target stage — leaves the escalation and goes back in one aggregate decision
 * (`returnEscalatedTask`; {@link escalationReturn}). The parked stage's job, if one is still
 * queued, is superseded the way every return supersedes it: the task is no longer at that stage
 * and attempt, and the stage executor's re-validation skips it.
 */
export const returnToStageCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly taskId: Id;
    readonly userId: Id;
    readonly stage: Slug;
    readonly reason: string;
  },
): Promise<void> => {
  requireJobs(deps);
  return writeTask(
    deps,
    { ...input, what: 'returning the task to a stage' },
    async (scope, stored, context) => {
      const from = currentStageOrThrow(stored, 'return');
      assertReturnTarget(stored, from, input.stage);
      assertLoopHasRoom(stored);
      const applied = await applyHumanDecisionRecorded(
        deps,
        scope,
        stored,
        context,
        {
          kind: 'return',
          from,
          to: input.stage,
          loop: HUMAN_RETURN_LOOP,
          reason: deps.redactor.redactText(input.reason).value,
          escalationBrief: returnBrief(stored, input.stage),
        },
        escalationReturn(stored),
      );
      return { result: undefined, work: applied.work === null ? null : { job: applied.work } };
    },
  );
};

/**
 * `POST /api/tasks/:task_id/rework` — product/04's "human rejection = reset, not patching".
 *
 * Two things separate it from `return-to-stage`, and both come from that sentence. The instructions
 * are what the stage is told to do *differently*, so they travel as the return's reason; and the
 * **agent-to-agent counters are reset** (`resetAgentIterations`, product/04's Paperclip rule), so a
 * task that has spent its code-review rounds gets them back when a person changes the approach.
 * `human_rounds` survives the reset — otherwise a person could loop for ever by construction — and
 * this command spends one of them, which is what bounds it.
 *
 * **The other half of that sentence** — *"the old MR is closed, a fresh branch is created"* —
 * since WP-59 (PROGRESS backlog 51, **Q92** answered per its recommendation: a new branch per
 * rework, the old merge request closed, its closing comment naming the new branch):
 *
 *  - **in this transaction**, the task lets go of the merge request and takes a **new branch**:
 *    `tasks.mr_ref` becomes `null` and `tasks.branch` becomes {@link reworkBranchName}. Letting go
 *    is what makes the close safe — the provider's `mr.closed` webhook for that merge request then
 *    finds no task (`findByMergeRequest`), where it would otherwise escalate this task to
 *    `needs_human` as product/04 S7's *"MR close/decline"*; and the next Developer run checks out a
 *    branch that does not exist yet, which the workspace creates from the default branch
 *    (`git checkout "$B" || git checkout -b "$B"`), so nothing is patched on top of the rejected
 *    work;
 *  - **after the commit**, a `close_superseded_mr` `pipeline.outbound` duty comments on the old
 *    merge request naming the new branch and closes it (`superseded-mr.ts`) — never from here,
 *    because nothing reaches a provider from a transaction (WP-15d).
 *
 * A task with no merge request enqueues no duty; one with neither a merge request nor a branch keeps
 * `branch: null`, which is already "fresh". The enqueue is **after** the commit and outside it, so a
 * process that dies between the two loses the wake-up — `afterCommit`'s at-most-once residual.
 * **It is recovered, not merely stated** (WP-59 review round 1, PROGRESS backlog 178): the same
 * transaction writes a `superseded_merge_requests` row naming the merge request it let go of, the
 * duty settles that row at every ending it reaches, and the recovery pass re-drives one that is
 * still unsettled after a pass interval — once, then ends it loudly (`recovery/superseded-mr.ts`).
 */
export const reworkStageCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly taskId: Id;
    readonly userId: Id;
    readonly stage: Slug;
    readonly instructions: string;
  },
): Promise<void> => {
  const jobs = requireJobs(deps);
  const superseded = await writeTask(
    deps,
    { ...input, what: 'reworking a stage' },
    async (scope, stored, context) => {
      const from = currentStageOrThrow(stored, 'rework');
      assertReturnTarget(stored, from, input.stage);
      assertLoopHasRoom(stored);
      const fresh = stored.mr === null && stored.branch === null ? null : reworkBranchName(stored);
      const reset: StoredTask = {
        ...stored,
        // WP-59 (Q92): let go of the rejected merge request and take a new branch — see above.
        branch: fresh,
        mr: null,
        task: {
          ...stored.task,
          iterationCounters: resetAgentIterations(stored.task.iterationCounters),
        },
      };
      const applied = await applyHumanDecisionRecorded(
        deps,
        scope,
        reset,
        context,
        {
          kind: 'return',
          from,
          to: input.stage,
          loop: HUMAN_RETURN_LOOP,
          reason: deps.redactor.redactText(input.instructions).value,
          escalationBrief: returnBrief(stored, input.stage),
        },
        // From `needs_human` too (backlog 483), where the return is preceded by `task.resumed`.
        escalationReturn(stored),
      );
      // The return, by type rather than by position: out of an escalation the first event is the
      // `task.resumed` that precedes it (backlog 483), and the cause of the close is the return.
      const cause = applied.events.find((event) => event.type === 'task.stage.returned')?.id;
      if (stored.mr !== null) {
        // `mr_ref` left `save`'s columns at WP-138, so the let-go is its own narrow write, in
        // this transaction beside the new branch the save above wrote.
        await deps.store.tasks.releaseMergeRequest(scope.tx, stored.task.id, stored.mr.iid);
      }
      if (stored.mr !== null && cause !== undefined) {
        // PROGRESS backlog 178: the name of the merge request this commit lets go of, in this
        // commit — so a close wake-up lost after it can be found and re-driven by the recovery pass.
        await deps.store.tasks.recordSupersededMergeRequest(scope.tx, {
          taskId: stored.task.id,
          projectId: stored.task.projectId,
          mr: stored.mr,
          newBranch: fresh,
          causeEventId: cause as Id,
          supersededAt: context.clock.now() as IsoDateTime,
        });
      }
      const close: PipelineOutboundData | null =
        stored.mr === null || cause === undefined
          ? null
          : {
              duty: 'close_superseded_mr',
              project_id: stored.task.projectId,
              task_id: stored.task.id,
              cause_event_id: cause,
              iid: stored.mr.iid,
              mr_url: stored.mr.url,
              ...(stored.mr.project_path == null
                ? {}
                : { mr_project_path: stored.mr.project_path }),
              ...(fresh === null ? {} : { new_branch: fresh }),
            };
      return {
        result: close,
        work: applied.work === null ? null : { job: applied.work },
      };
    },
  );
  if (superseded !== null) {
    await enqueueOutbound(jobs, superseded);
  }
};

/**
 * The branch a reworked task continues on — Q92's *"a new branch per rework"* (WP-59).
 *
 * `taskBranchName` of the ticket key with `-r<n>` appended, where `n` is derived from
 * `human_rounds` — which a rework spends and never resets — so two reworks can never name one
 * branch: the first rework on a task no human has returned makes `…-r2`, because the rejected work
 * was the first. **The numbers skip, and that is chosen** (WP-59 review round 1): a plain
 * return-to-stage spends `human_rounds` too, so a task returned once and then reworked goes to
 * `…-r3`. Counting reworks alone would need a count the aggregate does not keep, and deriving it
 * from the current branch's suffix would reuse `-r2` when the agent had reported a branch of its
 * own in between — a collision with the branch of a closed merge request, which is the patching
 * this exists to prevent. Unique beats consecutive. A ticket key with no character a branch may carry has no `agentic/` branch at all
 * (`taskBranchName` refuses it), and the task then continues on `null`, the default branch, which
 * is as fresh as a branch gets.
 */
export const reworkBranchName = (stored: StoredTask): string | null => {
  const attempt = (stored.task.iterationCounters[HUMAN_RETURN_LOOP] ?? 0) + 2;
  try {
    return `${taskBranchName(stored.task.ticket.key)}-r${attempt}`;
  } catch (error) {
    if (error instanceof InvariantViolationError) {
      return null;
    }
    throw error;
  }
};

/**
 * `POST /api/tasks/:task_id/feedback` — product/10's 👍/👎 plus text, scoped to a stage or a project.
 *
 * It writes no task row: feedback is its own aggregate and the task is not moved by an opinion. The
 * text is redacted here for the reason the module note gives, and the record is persisted **as its
 * event**. There is no `feedback` table yet: technical/03 fixes the row shape and says the table is
 * created by the work package that first persists feedback, and the honest reading is that the
 * append-only log already is that persistence — `feedback.received` is what WP-24's intake agent
 * reads, and nothing in this build queries feedback by any other key. A projection is filed as
 * discovered work rather than invented here from a row shape that no longer matches the published
 * record.
 */
export const submitFeedbackCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly taskId: Id;
    readonly userId: Id;
    readonly scope: FeedbackScope;
    readonly text: string;
    readonly rating?: number;
    readonly stage?: Slug;
    readonly artifactId?: Id;
    readonly channel: AnswerChannel;
  },
): Promise<{ readonly feedbackId: Id }> =>
  writeTask(deps, { ...input, what: 'recording feedback' }, async (scope, stored, context) => {
    const decision = recordFeedback(
      {
        id: context.ids.next(),
        projectId: stored.task.projectId,
        taskId: stored.task.id,
        authorUserId: input.userId,
        scope: input.scope,
        stage: input.stage ?? null,
        artifactId: input.artifactId ?? null,
        text: deps.redactor.redactText(input.text).value,
        rating: input.rating ?? null,
        sourceChannel: input.channel,
      },
      context,
    );
    await scope.events.append(decision.events);
    return { result: { feedbackId: decision.aggregate.id }, work: null };
  });

/** Zero usage, for a run nobody measured. Shaped like the executor's own constant. */
const NO_USAGE: TokenUsage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
};

/**
 * A `StoredRun` as the Run aggregate, at the sequence the log says its stream is at.
 *
 * Every field the aggregate types more narrowly than the row does is **parsed**, not cast: `role`,
 * `mode` and `effort` are text columns, and a value the enum does not have would otherwise reach an
 * event payload and be rejected by the catalogue's schema at append time, which is a 500 for a
 * caller who did nothing wrong.
 */
const toRunAggregate = (stored: StoredRun, sequence: number): Run => {
  if (stored.stage === null) {
    throw new InvariantViolationError(
      'run.stage',
      `run ${stored.id} is linked to no stage attempt, so the platform cannot tell which attempt it belongs to`,
    );
  }
  return {
    id: stored.id,
    taskId: stored.taskId,
    projectId: stored.projectId,
    stage: stored.stage,
    role: agentRoleSchema.parse(stored.role),
    mode: runModeSchema.parse(stored.mode),
    attempt: stored.attempt,
    model: stored.model,
    effort: effortSchema.parse(stored.effort),
    promptVersion: stored.promptVersion,
    status: stored.status,
    startedAt: stored.startedAt,
    lastOutputAt: null,
    endedAt: null,
    terminalReason: stored.terminalReason,
    sequence,
  };
};

/** What a run cancel did — which of TD-028 decision 11's two branches, and what it recorded. */
export interface CancelRunOutcome {
  readonly taskId: Id;
  /**
   * The `run_commands` row the lease holder applies as the session's stop, or `null` when no
   * process held the run and the record was ended in place. The HTTP answer is `202` for the first
   * and `200` for the second.
   */
  readonly commandId: Id | null;
}

/**
 * Whether some process is renewing the run's lease **now**, by this command's clock — the same
 * comparison the lease sweep makes (`../recovery/run-lease.ts`), without its grace: a lease that has
 * lapsed but not yet been swept is one nobody renewed in time, and a cancel is not the place to wait
 * for it.
 */
const leaseIsLive = (run: LockedRun, now: IsoDateTime): boolean =>
  run.leaseOwner !== null &&
  run.leaseExpiresAt !== null &&
  Date.parse(run.leaseExpiresAt) > Date.parse(now);

/**
 * `POST /api/runs/:run_id/cancel` — stop this attempt. **Two branches, and the lease decides which**
 * (TD-028 decision 11, WP-101, PROGRESS backlog 294).
 *
 * ## A live lease: the stop is recorded for the process holding the session
 *
 * When `runs.lease_expires_at` is in the future, a process is driving the session and renewing its
 * lease. The command then does what a take-over does: in one transaction it pauses the task (so the
 * pipeline does not act on an attempt nobody will finish) and records a `cancel` row in
 * `run_commands`, and it wakes the holder with `pg_notify`. The holder applies it as
 * `RunHandle.stop({ reason: 'cancelled' })` (`./run-commands.ts`), the session is interrupted, and
 * the run ends `cancelled` **in its own process, with its measured cost** — the one process that
 * knows what the attempt spent is the one that writes the row, so the ledger is charged once, by the
 * ordinary `run.finished` handler, and not `late`. The run row is **not** touched here: there is one
 * terminal writer in this branch, the holder. The heartbeat's poll is the guarantee and the
 * notification only the latency (decision 9).
 *
 * A holder that dies before applying leaves the row pending; the lease sweep ends the run
 * `lease_expired` and that `finish` closes the row `run_ended`. The run then reads `lease_expired`
 * rather than `cancelled`, which is the truth: no process confirmed the stop.
 *
 * ## No live lease: the record is ended in place, as it always was
 *
 * Absent (a run no process ever leased) or expired: nothing holds the session, so waiting for a
 * holder would wait for nobody. The command wins the row through the conditional `runs.finish` with
 * status `cancelled` and appends `run.finished` itself — the synchronous answer, kept for this branch
 * only. If a process *was* still running the session (a holder partitioned from the database), it
 * finds the row terminal when the session ends, discards its **verdict** (`stage-executor.ts`'s
 * `lostTheRun`) and records its spend through the narrow `runs.recordCost` (WP-47, Q70 (b)) — which
 * is why the cost stored here is `null` rather than a zero (see the call below).
 *
 * ## The arbiter is the row, and it is taken exclusively
 *
 * The run is read under `for update` before the task row is written — `runs` then `tasks`, the
 * order every writer of both takes. Exclusively rather than `for share`, because this branch may go
 * on to `finish` the row it read and two cancels that each held a share lock would deadlock on the
 * upgrade instead of one refusing the other. The lease sweep and the holder's `markApplied` wait for
 * it the same way. `RunRepository.finish` stays conditional on the run being live, so exactly one of
 * this command and the executor wins the in-place branch, and the loser writes nothing.
 *
 * The task is paused only when the state machine has that edge: a task that is already `paused`, or
 * one that has finished, keeps the state it is in rather than making this command fail.
 */
export const cancelRunCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly runId: Id;
    readonly userId: Id;
    /** The `cancel` row's id when one is recorded; see {@link steerRunCommand}'s. */
    readonly commandId?: Id;
  },
): Promise<CancelRunOutcome> => {
  // Read once before the retry, for the task id: `retryOnTaskConflict` names the task in its log
  // line and in the error it raises, and a run id in that field would make both say something
  // untrue. The transaction re-reads and re-decides — this value is only the label.
  const first = await deps.unitOfWork.transaction(async (scope) =>
    deps.store.runs.load(scope.tx, input.runId),
  );
  if (first === null) {
    throw new UnknownAggregateError(`run ${input.runId} does not exist`);
  }
  return retryOnTaskConflict(
    {
      taskId: first.taskId,
      what: 'cancelling a run',
      ...(deps.logger === undefined ? {} : { logger: deps.logger }),
    },
    async () =>
      deps.unitOfWork.transaction(async (scope) => {
        const locked = await deps.store.runCommands.lockRun(scope.tx, input.runId, {
          forUpdate: true,
        });
        const run = locked === null ? null : await deps.store.runs.load(scope.tx, input.runId);
        if (locked === null || run === null) {
          throw new UnknownAggregateError(`run ${input.runId} does not exist`);
        }
        const context = humanContext(deps, run.taskId, input.userId);
        // The Run's own table decides: a terminal run has no edge to `cancelled`, and the error
        // names the transition it refused.
        assertRunTransition(run.status, 'cancelled');
        if (leaseIsLive(locked, context.clock.now())) {
          const commandId = input.commandId ?? context.ids.next();
          await pauseForCancel(deps, scope, run.taskId, context, []);
          await recordRunCommand(deps, scope, locked, {
            id: commandId,
            actorUserId: input.userId,
            instruction: { kind: 'cancel' },
          });
          return { taskId: run.taskId, commandId };
        }
        await endCancelledRunInPlace(deps, scope, run, context);
        return { taskId: run.taskId, commandId: null };
      }),
  );
};

/** Pauses the run's task when the state machine has the edge, and appends `events` with it. */
const pauseForCancel = async (
  deps: HumanCommandDependencies,
  scope: TransactionScope,
  taskId: Id,
  context: CommandContext,
  events: DomainEvent[],
): Promise<void> => {
  const stored = await deps.store.tasks.load(scope.tx, taskId);
  if (stored !== null && canTransitionTask(stored.task.state, 'paused')) {
    const paused = pauseTask(stored.task, { reason: 'manual' }, context);
    await deps.store.tasks.save(scope.tx, { ...stored, task: paused.aggregate });
    events.push(...paused.events);
  }
  await scope.events.append(events);
};

/** {@link cancelRunCommand}'s second branch: no process holds the session, so the row is ended here. */
const endCancelledRunInPlace = async (
  deps: HumanCommandDependencies,
  scope: TransactionScope,
  run: StoredRun,
  context: CommandContext,
): Promise<void> => {
  await pauseForCancel(deps, scope, run.taskId, context, [
    ...(await endRunRecordInPlace(deps, scope, run, context)),
  ]);
};

/**
 * Ends a run **as a record** — `cancelled`, no figure — and answers its `run.finished`, unappended:
 * the run cancel's second branch, and since backlog 494 the retry's ({@link stopRunForRetry}).
 */
const endRunRecordInPlace = async (
  deps: HumanCommandDependencies,
  scope: TransactionScope,
  run: StoredRun,
  context: CommandContext,
): Promise<readonly DomainEvent[]> => {
  const won = await deps.store.runs.finish(scope.tx, {
    runId: run.id,
    status: 'cancelled',
    terminalReason: 'cancelled',
    sessionId: run.sessionId,
    numTurns: run.numTurns,
    usage: run.usage ?? NO_USAGE,
    /**
     * **`null`, not a zero** — WP-47, Q70 (b).
     *
     * Nothing here measured this attempt's spend: if a session is still running somewhere, what it
     * had burned when the human pressed cancel is not a number anybody in this request has. Until
     * WP-47 that was written as `{ usd: 0, is_estimate: true }`, which put a `0` in
     * `runs.usd_estimated` — a measurement, as far as every later reader is concerned, and the one
     * thing that would stop the process that *does* know the number from writing it:
     * `runs.recordCost` refuses a row that already carries a figure. So the honest absence is what
     * is stored, and the money arrives if that process finishes.
     */
    cost: run.cost,
    wallMs: wallMsSince(run.startedAt, context.clock.now()),
  });
  if (!won) {
    throw new RunNotLiveError(run.id, run.status, 'cancelled: it has already ended');
  }
  const aggregate = toRunAggregate(run, await deps.eventStore.nextStreamSequence('run', run.id));
  const decision = finishRun(
    aggregate,
    {
      status: 'cancelled',
      terminalReason: 'cancelled',
      usage: run.usage ?? NO_USAGE,
      modelUsage: [],
      // The row's `null`, carried as it is: `run.finished.cost` is nullable since WP-119 (backlog
      // 334), and the zero this event used to state was the claim the row refuses above.
      cost: run.cost,
      numTurns: run.numTurns,
    },
    context,
  );
  return decision.events;
};

/** Wall time for a run ended from outside the process that started it; `0` when it never started. */
const wallMsSince = (startedAt: IsoDateTime | null, now: IsoDateTime): number =>
  startedAt === null ? 0 : Math.max(0, Date.parse(now) - Date.parse(startedAt));

/**
 * `POST /api/runs/:run_id/retry` — technical/08's "retry (model/effort override)".
 *
 * It creates a **new attempt of the run's stage** rather than a second run of the same attempt:
 * technical/02's invariant is one active run per task, and the attempt counter is what the executor
 * re-validates against. So this is `retry-stage` with an override, and the override lives on the
 * wake-up rather than on the project (`StageExecuteData`).
 *
 * Two refusals, both of them the state deciding rather than this function:
 * a run that has not ended yet cannot be retried (cancel it first — `run.retry`'s own subject rule
 * in `can()` says the same thing), and a run whose stage the task has already left is a
 * {@link StageNotCurrentError}, because re-entering it would be a return.
 */
export const retryRunCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly runId: Id;
    readonly userId: Id;
    readonly model?: string;
    readonly effort?: Effort;
  },
): Promise<{ readonly taskId: Id; readonly stage: Slug }> => {
  requireJobs(deps);
  const run = await deps.unitOfWork.transaction(async (scope) =>
    deps.store.runs.load(scope.tx, input.runId),
  );
  if (run === null) {
    throw new UnknownAggregateError(`run ${input.runId} does not exist`);
  }
  if (isActiveRunStatus(run.status)) {
    throw new RunNotLiveError(run.id, run.status, 'retried while it is still running');
  }
  const stage = run.stage;
  if (stage === null) {
    throw new InvariantViolationError(
      'run.stage',
      `run ${run.id} is linked to no stage attempt, so there is no stage to run again`,
    );
  }
  const overrides = {
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.effort === undefined ? {} : { effort: input.effort }),
  };
  await writeTask(
    deps,
    { taskId: run.taskId, userId: input.userId, what: 'retrying a run' },
    async (scope, stored, context) => {
      if (stored.task.currentStage !== stage) {
        throw new StageNotCurrentError(stage, stored.task.currentStage);
      }
      // A run's stage is never `ready_for_merge` on a shipped template (nothing runs at Ready), but
      // the entry goes through `humanEnter` all the same, so a custom template cannot make it one.
      const work = await humanEnter(deps, scope, stored, context, {
        stage,
        via: 'retry_run',
        userId: input.userId,
        cause: null,
      });
      return {
        result: undefined,
        work:
          work === null || 'readyCheck' in work
            ? work
            : { ...work, ...(Object.keys(overrides).length === 0 ? {} : { overrides }) },
      };
    },
  );
  return { taskId: run.taskId, stage };
};

// ── Steer, take over, hand back (WP-27) ──────────────────────────────────────

/**
 * technical/05 §5: *"3 days default, 14 days for paused/taken-over"*.
 *
 * Here rather than in the workspace adapter because it is the **reason** for the window that
 * decides it: a human is now holding this task, and three days is the window for a workspace nobody
 * is coming back to. The adapter is told an instant, not a policy.
 */
export const TAKEN_OVER_WORKSPACE_KEEP_DAYS = 14;

const DAY_MS = 24 * 60 * 60 * 1_000;

/**
 * How a person is named in a git commit message and in a steer's provenance line.
 *
 * Two things bound it, and neither is decoration. It reaches a **commit message** on the project's
 * own repository (product/19 §19's `wip: hand-over to <user>`), which is published to whoever reads
 * the branch — so the display name is used and never the email address, which is the one field of
 * `Actor` a person did not choose to publish. And it reaches a **model**, through the runner's
 * `UserPromptSubmit` provenance line, which is platform-written text with one interpolation in it:
 * a name is user-supplied (BD-022 makes no exception for a colleague's), so everything outside a
 * conservative alphabet becomes a space and the result is bounded at 64 characters.
 *
 * An empty result is `someone`, because `wip: hand-over to ` is a sentence with a hole in it.
 */
export const actorLabel = (name: string): string => {
  const cleaned = name
    .slice(0, 64)
    .replaceAll(/[^\p{L}\p{N} .@_-]+/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  return cleaned.length === 0 ? 'someone' : cleaned;
};

/**
 * Records a command for a live run and wakes the process holding its lease (WP-85, TD-028
 * decision 9) — in the caller's transaction, after the caller has read the run under
 * `lockRun`/`lockLiveRunOf`'s `for share` lock.
 *
 * The wake-up is `pg_notify` through the transactional broadcast, so it is delivered only if the
 * command commits. A run with **no** lease holder gets no wake-up: nothing is driving it that could
 * apply the row, and the run's ending closes it `run_ended` (`RunRepository.finish`).
 */
const recordRunCommand = async (
  deps: HumanCommandDependencies,
  scope: TransactionScope,
  run: LockedRun,
  command: {
    readonly id: Id;
    readonly actorUserId: Id;
    readonly instruction: RunCommandInstruction;
  },
): Promise<void> => {
  await deps.store.runCommands.insert(scope.tx, {
    id: command.id,
    runId: run.runId,
    taskId: run.taskId,
    actorUserId: command.actorUserId,
    instruction: command.instruction,
  });
  if (run.leaseOwner === null) {
    deps.logger?.info(
      { run_id: run.runId, command_id: command.id, kind: command.instruction.kind },
      'a run command was recorded for a run no process holds the lease of; it stays pending until a holder applies it or the run ends',
    );
    return;
  }
  const wakeUp: RunCommandWakeUp = { lease_owner: run.leaseOwner, run_id: run.runId };
  await scope.broadcast.publish({ topic: runCommandsTopic(run.leaseOwner), payload: wakeUp });
};

/**
 * `POST /api/runs/:run_id/steer` — a user turn for a live session (product/18, WP-27), **recorded,
 * then applied or refused** by the process holding the run (WP-85, TD-028 decision 9).
 *
 * ## Four checks, in the order that makes each one mean something
 *
 * The **row** first: `runs.status` is the platform's record of the run, and a run that has ended is
 * refused with {@link RunNotLiveError} — a 409 naming the status — rather than with a 403 from the
 * aggregate's own state rule. It is asked twice: once before the transaction for the cheap answer,
 * and again **under the `for share` lock** the command is recorded beside, which is the answer that
 * counts — the run's ending takes the row exclusively and then closes every pending command, so a
 * steer recorded here is either closed by that ending or refused here. Then the **role**, inside
 * `steerRun`, which is where `can()` lives. Then the **window**.
 *
 * ## The window is the database's, not a process's (WP-101, PROGRESS backlog 295)
 *
 * technical/08 gives the one number the API has: one steer per five seconds per user. It was a
 * `Map` in each API process, so N processes admitted N steers per window — and since WP-85 every
 * admitted steer is a turn the run pays for. Now the recording transaction first takes a
 * `pg_advisory_xact_lock` on the user and reads that user's `steer` rows inside the interval
 * (`RunCommandRepository.admitSteer`); the row this transaction inserts is what the next one reads,
 * so a second steer through **any** process waits for the first to commit and is then refused
 * {@link SteerWindowClosedError}. No new table: the rows the window counts are the commands it
 * admitted. The lock is taken **before** the run's row lock, the order every steer takes, and the
 * verdict is applied **after** the row and role checks, so a steer refused for another reason says
 * that reason — and records nothing, so it takes no slot (what WP-73's refund did by hand).
 *
 * ## Recorded, not delivered
 *
 * Until WP-85 this pushed the turn into a handle found in **this** process's register, and on the
 * shipped topology the process that serves the API never holds a run, so every steer was refused
 * `run_not_reachable` (PROGRESS backlog 134). Now the command is a `run_commands` row written in the
 * transaction that appends `run.steered`, and the holder applies it (`./run-commands.ts`): the
 * caller is told the command was **accepted**, never that the model heard it, and the run screen
 * reads whether it was applied or refused. The `steer` transcript row is still written by the
 * holder's `handle.steer`, so the run screen shows the turn exactly when the session took it.
 *
 * The event is appended with the record rather than on application, and that is the old ordering
 * argument unchanged: a log entry with no delivery is visible where a human looks (the transcript
 * has no `steer` row, the command reads `refused`); a delivery with no log entry is a turn the
 * audit does not have.
 *
 * The message is redacted once, here, and the same redacted bytes go to the row, the event and —
 * through the row — the session and the transcript (TD-012).
 */
export const steerRunCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly runId: Id;
    readonly userId: Id;
    readonly role: UserRole;
    readonly message: string;
    readonly authorName: string;
    /**
     * The `run_commands` id — derived from the `Idempotency-Key` by the composition root, so a replay
     * that got past the key's record collides rather than recording a second turn (migration 0060).
     * A fresh id when absent.
     */
    readonly commandId?: Id;
  },
): Promise<{ readonly taskId: Id; readonly commandId: Id }> => {
  const run = await deps.unitOfWork.transaction(async (scope) =>
    deps.store.runs.load(scope.tx, input.runId),
  );
  if (run === null) {
    throw new UnknownAggregateError(`run ${input.runId} does not exist`);
  }
  if (run.status !== 'running') {
    throw new RunNotLiveError(run.id, run.status, 'steered');
  }
  const message = deps.redactor.redactText(input.message).value;
  const label = actorLabel(input.authorName);
  const commandId = await deps.unitOfWork.transaction(async (scope) => {
    // The user's lock first, then the run's row lock: the order every steer takes (see above).
    const admitted = await deps.store.runCommands.admitSteer(scope.tx, {
      userId: input.userId,
      windowMs: STEER_MIN_INTERVAL_MS,
    });
    const locked = await deps.store.runCommands.lockRun(scope.tx, run.id);
    if (locked === null) {
      throw new UnknownAggregateError(`run ${input.runId} does not exist`);
    }
    if (locked.status !== 'running') {
      throw new RunNotLiveError(run.id, locked.status, 'steered');
    }
    const stored = await loadTaskOrThrow(deps, scope.tx, run.taskId);
    const context = humanContext(deps, stored.task.id, input.userId);
    const decision = steerRun(
      stored.task,
      {
        run: { id: run.id, status: locked.status },
        message,
        authorUserId: input.userId,
        authorRole: input.role,
      },
      context,
    );
    if (!admitted) {
      throw new SteerWindowClosedError();
    }
    // No `tasks.save`: steering moves nothing, so the row is untouched and its version is not
    // spent — the same shape `submitFeedbackCommand` has, and the reason neither needs
    // `retryOnTaskConflict`.
    await scope.events.append(decision.events);
    const id = input.commandId ?? context.ids.next();
    await recordRunCommand(deps, scope, locked, {
      id,
      actorUserId: input.userId,
      instruction: {
        kind: 'steer',
        text: message,
        authorUserId: input.userId,
        authorLabel: label,
      },
    });
    return id;
  });
  return { taskId: run.taskId, commandId };
};

/** What a take-over produced, for the response technical/08 owes the operator. */
export interface TakeOverOutcome extends AuditedReason {
  readonly taskId: Id;
  readonly branch: string;
  /**
   * The session `claude --resume` continues, or `null` when no live run had reported one. Read off
   * the run's `init` transcript entry since WP-85 ({@link LockedRun.sessionId}), because the process
   * answering is not the one holding the handle. Never guessed (standing rule 18).
   */
  readonly sessionId: string | null;
  /** Whether a live run's stop was recorded — its workspace asked, through the holder, to export. */
  readonly exported: boolean;
  /** The run whose stop was recorded, or `null` when the task had no live run. */
  readonly runId: Id | null;
  /**
   * Inherited from {@link AuditedReason}, and it is **not** part of the response: why a person took
   * a task over is theirs to state and the audit row's to keep, and the operator who just typed it
   * does not need it read back. See {@link auditedReason}.
   */
  readonly reason: string | null;
}

/**
 * `POST /api/tasks/:task_id/take-over` — product/19 §19's take-over protocol.
 *
 * ## The order, and what each ordering decision costs
 *
 * **The task is paused and the run's stop is recorded in one transaction; the stop is applied
 * afterwards, by the process holding the run, and is not waited for.** Both halves were chosen
 * against their alternative.
 *
 * Pausing with the record means a failure between the two cannot happen — the pause and the stop
 * commit together — and a stop that is then applied late or refused leaves a paused task beside a
 * run that is still going, which is exactly what `POST /api/tasks/:task_id/pause` already does and
 * what the stage executor already handles: `isRunnableTaskState` is false, so the run is recorded
 * when it ends and its stage is not completed. Stopping first would mean a failure leaves a
 * *killed* run on a task the pipeline still owns, and the pipeline would start the stage again.
 *
 * **The run is found in the database, not in this process** (WP-85, TD-028 decision 9). The task's
 * live run is read under a `for share` lock — before the task row is written, the order every
 * writer of both rows takes (`runs` then `tasks`), so the two cannot deadlock — and its id is
 * recorded on `task.taken_over`; the stop is a `run_commands` row the holder applies
 * (`./run-commands.ts`). Until WP-85 the run was looked up in this process's register, and on the
 * shipped topology that register is always empty, so every take-over recorded `run_id: null` and
 * stopped nothing (PROGRESS backlog 134).
 *
 * Not awaiting the stop means the request answers with the branch and the resume command while the
 * session is still winding down. What the caller is told is therefore `workspace_export:
 * 'requested'`, which is the true tense — and since WP-85 truer still: requested of the holder.
 *
 * ## What the export is, and what it is not
 *
 * The launcher commits the work in progress as `wip: hand-over to <user>` — product/19:84's one
 * permitted `wip:` commit — pushes `agentic/<task>` with the **run's own** credential (never the
 * platform's; the broker minted it for this run), optionally writes a tarball, and extends the
 * volume's retention to fourteen days (technical/05 §5). All of that happens in the process that
 * holds the workspace, driven by {@link RunTakeOverExport} on the stop.
 *
 * It does **not** write the transcript JSONL that technical/05 §6 also names, and since WP-44 that
 * is a decision rather than a gap (Q93: serve, do not copy). The transcript is rendered from
 * `run_messages` on request (`GET /api/runs/:run_id/transcript.jsonl`) and the tarball this stop
 * asks for is served from the shared export volume (`GET /api/runs/:run_id/export.tar`) and swept
 * after the same fourteen days as the workspace — so `blobs` keeps no writer and `workspaces` no row
 * (technical/03 says why).
 */
export const takeOverTaskCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly taskId: Id;
    readonly userId: Id;
    readonly authorName: string;
    readonly tarball: boolean;
    readonly reason?: string;
    /** The stop's `run_commands` id; see {@link steerRunCommand}'s. */
    readonly commandId?: Id;
  },
): Promise<TakeOverOutcome> => {
  const audited = auditedReason(deps, input.reason);
  const outcome = await writeTask(
    deps,
    { taskId: input.taskId, userId: input.userId, what: 'taking the task over' },
    async (scope, stored, context) => {
      const stage = currentStageOrThrow(stored, 'take over');
      // Before the task row is written: `runs` then `tasks`, the order the run's ending takes.
      const live = await deps.store.runCommands.lockLiveRunOf(scope.tx, stored.task.id);
      // The branch the work is on: what the merge request said, or the name BD-025 reserves for
      // this task. Never invented from the run — a task may have been taken over before any push.
      const branch = stored.branch ?? taskBranchName(stored.task.ticket.key);
      const decision = takeOverTask(
        stored.task,
        {
          branch,
          stage,
          ...(live?.sessionId == null ? {} : { sessionId: live.sessionId }),
          // Recorded rather than inferred by the screen (WP-73, backlog 203): `null` exactly when
          // no run was live, so no stop was recorded below.
          runId: live?.runId ?? null,
        },
        context,
      );
      await deps.store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
      await scope.events.append(decision.events);
      if (live !== null) {
        // The stop's {@link RunTakeOverExport}, recorded for the holder to hand to `RunHandle.stop`.
        await recordRunCommand(deps, scope, live, {
          id: input.commandId ?? context.ids.next(),
          actorUserId: input.userId,
          instruction: {
            kind: 'take_over',
            branch,
            commitMessage: `wip: hand-over to ${actorLabel(input.authorName)}`,
            tarball: input.tarball,
            keepUntil: new Date(
              Date.parse(context.clock.now()) + TAKEN_OVER_WORKSPACE_KEEP_DAYS * DAY_MS,
            ).toISOString() as IsoDateTime,
          },
        });
      }
      return {
        result: {
          taskId: stored.task.id,
          branch,
          runId: live?.runId ?? null,
          sessionId: live?.sessionId ?? null,
        },
        work: null,
      };
    },
  );
  return {
    taskId: outcome.taskId,
    branch: outcome.branch,
    sessionId: outcome.sessionId,
    exported: outcome.runId !== null,
    runId: outcome.runId,
    reason: audited.reason,
  };
};

/**
 * `POST /api/tasks/:task_id/hand-back` — the other half of the protocol (product/19 §19).
 *
 * The human pushed to the same branch and chose a stage; the platform re-enters it with a fresh
 * run. Three things are the point:
 *
 * **Any stage the template runs, and no other.** product/19 §19 says the human chooses — so this
 * does not restrict the target to the stage the task was taken over at — and
 * {@link StageNotInTemplateError} is what stops "any" from meaning "any string": a stage the
 * compiled pipeline does not name, or one the project disabled, would leave the task `active` at a
 * stage nothing will run.
 *
 * **The entry goes through `applyDecision`, not through the aggregate.** `handBackTask` emits the
 * event and nothing else; which command a stage id implies — `ready_for_merge` is not `enterStage`
 * — and what `task_stages` owes are `applyDecision`'s to know, and a second copy of that knowledge
 * here would be wrong for exactly the stages a human is most likely to hand back to.
 *
 * **Nothing is reset and nothing is exported.** The iteration counters stand (`handBackTask`'s own
 * note has the argument), and the workspace export the take-over produced is left where it is: a
 * hand-back re-provisions from the **branch**, which is where the human's work now is.
 *
 * **Except into `ready_for_merge`** (WP-79, PROGRESS backlog 267): that target is not entered
 * here at all. The hand-back is recorded and the `ready_head_check` duty re-enters `rebase_gate`
 * for the head the gates judged (WP-105: the target branch and the Code review's confirmation are
 * read again, PROGRESS backlog 337) and `ci_gate` otherwise — see `ready-head.ts`. That covers the
 * take-over at Ready this entry was filed for and the wider door beside it: a hand-back into Ready
 * from an `active` task, which `active → ready_for_merge` let skip both gates.
 */
export const handBackTaskCommand = async (
  deps: HumanCommandDependencies,
  input: {
    readonly taskId: Id;
    readonly userId: Id;
    readonly stage: Slug;
    readonly summary: string;
  },
): Promise<void> => {
  requireJobs(deps);
  return writeTask(
    deps,
    { ...input, what: 'handing the task back' },
    async (scope, stored, context) => {
      /**
       * **Not past a pending approval** (WP-62 review round 1). Hand-back is a `member` command and
       * an approval is a maintainer's (`task.approve_plan`), so a hand-back from
       * `waiting_approval` into a later stage would carry a plan — one touching a risk class
       * included — into implementation with nobody having approved it. The approval is decided
       * with its own command; the hand-back is for a task a human holds or the platform parked.
       */
      if (stored.task.state === 'waiting_approval') {
        throw new IllegalTransitionError('task', stored.task.state, `${input.stage} (hand-back)`);
      }
      /**
       * **Not into the merge** (WP-73 review round 1). Entering `merged_gate` records a merge, and
       * the only thing that may say a merge happened is the provider's `mr.merged`. The aggregate
       * already refuses it from a pause at any other stage; from a pause at `ready_for_merge` it
       * would be an edge, so the command refuses the target by name.
       */
      if (input.stage === MERGED_GATE_STAGE) {
        throw new IllegalTransitionError('task', stored.task.state, `${input.stage} (hand-back)`);
      }
      const pipeline = compilePipeline(stored.task.template, stored.template, stored.pipelineDial);
      const target = stageOf(pipeline, input.stage);
      if (target === null || !target.enabled) {
        throw new StageNotInTemplateError(
          input.stage,
          stored.task.template,
          pipeline.stages.filter((entry) => entry.enabled).map((entry) => entry.id),
        );
      }
      const branch = stored.branch ?? taskBranchName(stored.task.ticket.key);
      const decision = handBackTask(
        stored.task,
        {
          branch,
          stage: input.stage,
          // The human's own words, on their way into `task.handed_back` and the workpad (TD-012).
          summary: deps.redactor.redactText(input.summary).value,
        },
        context,
      );
      // Appended before the entry's own events, because that is the order they happened in and
      // `stream_seq` is chained through `decision.aggregate`: the hand-back, then the stage.
      // Into `ready_for_merge` this appends the hand-back and leaves the ready-head check for after
      // the commit (WP-79, backlog 267: the human pushed, so Ready is entered only for the head the
      // gates judged — `humanEnter`); the check re-validates against the state the command saw.
      await scope.events.append(decision.events);
      const work = await humanEnter(deps, scope, { ...stored, task: decision.aggregate }, context, {
        stage: input.stage,
        via: 'hand_back',
        userId: input.userId,
        cause: decision.events[0]?.id ?? null,
      });
      return { result: undefined, work };
    },
  );
};
