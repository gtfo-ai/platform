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
  InvariantViolationError,
  isActiveRunStatus,
  pauseTask,
  recordFeedback,
  resetAgentIterations,
} from '@platform/domain';
import type { EventStore } from '../ports/event-store.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import type { Jobs } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { enqueueStage } from './jobs.js';
import type { StageExecutionJob } from './stage-executor.js';
import type { PipelineStore, StoredRun, StoredTask } from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';
import { applyDecision } from './transitions.js';

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
   * Five fields in all, with the return reason, the rework instructions and the feedback text, and
   * each is redacted at the one command that writes it rather than at each of the transports that
   * can carry it (HTTP, a ticket comment, a Slack action).
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

/** The `question.timeout` timer fired (TD-004). The saga escalates on the event this emits. */
export const expireTaskQuestion = async (
  deps: TaskCommandDependencies,
  questionId: Id,
): Promise<void> => {
  await deps.unitOfWork.transaction(async (scope) => {
    const question = await deps.store.questions.load(scope.tx, questionId);
    if (question === null || question.status !== 'open') {
      // The timer cannot be cancelled (TD-004), so it fires for questions that were answered in
      // the meantime. Finding nothing to do is the normal case, not an error.
      return;
    }
    const decision = expireQuestion(question, deps.context(question.taskId));
    await deps.store.questions.save(scope.tx, decision.aggregate);
    await scope.events.append(decision.events);
  });
};

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

export const expireTaskApproval = async (
  deps: TaskCommandDependencies,
  approvalId: Id,
): Promise<void> => {
  await deps.unitOfWork.transaction(async (scope) => {
    const stored = await deps.store.approvals.load(scope.tx, approvalId);
    if (stored === null || stored.approval.status !== 'pending') {
      return;
    }
    const decision = expireApproval(stored.approval, deps.context(stored.approval.taskId));
    await deps.store.approvals.save(scope.tx, { ...stored, approval: decision.aggregate });
    await scope.events.append(decision.events);
  });
};

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
 * is why `redactor` is a field of {@link TaskCommandDependencies} and not of this interface.
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

/** The work a command left for after the commit, with the overrides that belong to this attempt. */
interface ScheduledWork {
  readonly job: StageExecutionJob;
  readonly overrides?: { readonly model?: string; readonly effort?: Effort };
}

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
  if (outcome.work !== null) {
    await enqueueStage(requireJobs(deps), {
      ...outcome.work.job,
      ...(outcome.work.overrides === undefined ? {} : { overrides: outcome.work.overrides }),
    });
  }
  return outcome.result;
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
): Promise<StageExecutionJob | null> => {
  const applied = await applyDecision({
    store: deps.store,
    pipeline: compilePipeline(stored.task.template, stored.template),
    tx: scope.tx,
    stored,
    decision,
    context,
    // No event caused this: a person did. `task_stages.caused_by_event_id` is null for the row a
    // human command writes, which is how the audit tells the two apart.
    causedByEventId: null,
    onIllegalTransition: 'throw',
    ...(deps.logger === undefined ? {} : { logger: deps.logger }),
  });
  if (applied.events.length > 0) {
    await scope.events.append(applied.events);
  }
  return applied.work;
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

/**
 * `POST /api/tasks/:task_id/pause` — product/03's "pause task".
 *
 * `reason: 'manual'` is the *kind* of pause the event carries (`PauseReason`); the human's own words
 * go in the `human_actions` row the transport writes, because `task.paused` has no field for them
 * and inventing one would change a published payload for one caller.
 *
 * A run already in flight is **not** stopped — nothing in this build can reach a live session from
 * another process (Q52) — but it can no longer advance the task: the stage executor records the run
 * and stops, because `isRunnableTaskState` is false for a paused task. Stopping the session itself
 * is `POST /api/runs/:run_id/cancel`, which is why both commands exist.
 */
export const pauseTaskCommand = async (
  deps: HumanCommandDependencies,
  input: { readonly taskId: Id; readonly userId: Id },
): Promise<void> =>
  writeTask(deps, { ...input, what: 'pausing the task' }, async (scope, stored, context) => {
    const decision = pauseTask(stored.task, { reason: 'manual' }, context);
    await deps.store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
    await scope.events.append(decision.events);
    return { result: undefined, work: null };
  });

/**
 * `POST /api/tasks/:task_id/resume` — re-enter the stage the task stopped at.
 *
 * It spends **no** iteration round: the task stood still, it did not go round. That is the same
 * reading `resumeStage` is written to (a question round is spent by the *question*, not by the
 * resumption), and it is why a paused task can always be resumed while a spent loop cannot be
 * re-entered by `return-to-stage`.
 *
 * The state machine is what refuses the rest: `paused → active` exists, and a task paused at
 * `ready_for_merge` has no edge back to that stage, so resuming it is a `409` naming the transition
 * rather than a silent no-op. Returning it to an earlier stage is the way out, and it is a different
 * command.
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
      const work = await applyHumanDecision(deps, scope, stored, context, { kind: 'enter', stage });
      return { result: undefined, work: work === null ? null : { job: work } };
    },
  );
};

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
          runs: totals.runs,
          wall_ms: totals.wallMs,
        },
      },
      context,
    );
    await deps.store.tasks.save(scope.tx, { ...stored, task: decision.aggregate });
    await scope.events.append(decision.events);
    return { result: undefined, work: null };
  });

/**
 * `POST /api/tasks/:task_id/retry-stage` — run the current stage again, as a new attempt.
 *
 * A **retry**, so the stage must be the one the task is at: sending it somewhere else is
 * `return-to-stage`, which counts a round and records a reason on the stage it leaves. The attempt
 * counter moves, which is what supersedes any run still in flight for the old attempt — the stage
 * executor's `revalidate` skips a job whose attempt has been passed.
 */
export const retryStageCommand = async (
  deps: HumanCommandDependencies,
  input: { readonly taskId: Id; readonly userId: Id; readonly stage: Slug },
): Promise<void> => {
  requireJobs(deps);
  return writeTask(deps, { ...input, what: 'retrying a stage' }, async (scope, stored, context) => {
    if (stored.task.currentStage !== input.stage) {
      throw new StageNotCurrentError(input.stage, stored.task.currentStage);
    }
    const work = await applyHumanDecision(deps, scope, stored, context, {
      kind: 'enter',
      stage: input.stage,
    });
    return { result: undefined, work: work === null ? null : { job: work } };
  });
};

/** What a human return leaves behind for the stage it goes back to, and for a spent loop. */
const returnBrief = (stored: StoredTask, to: Slug): string =>
  `A person sent ${stored.task.ticket.key} back to "${to}" as many times as the ` +
  `${HUMAN_RETURN_LOOP} limit allows. Read what they asked for, then either finish it by hand or ` +
  'cancel the task.';

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
      assertLoopHasRoom(stored);
      const work = await applyHumanDecision(deps, scope, stored, context, {
        kind: 'return',
        from,
        to: input.stage,
        loop: HUMAN_RETURN_LOOP,
        reason: deps.redactor.redactText(input.reason).value,
        escalationBrief: returnBrief(stored, input.stage),
      });
      return { result: undefined, work: work === null ? null : { job: work } };
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
 * **What it does not do**, because it is outbound and this row owns no provider call: product/04
 * also says the old merge request is closed and a fresh branch created. Neither happens here. The
 * task keeps the merge request it has, and the shape that would close it is the `pipeline.outbound`
 * duty of WP-15d rather than anything in this transaction. It is in `PROGRESS.md` under discovered
 * work rather than half-done here.
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
  requireJobs(deps);
  return writeTask(
    deps,
    { ...input, what: 'reworking a stage' },
    async (scope, stored, context) => {
      const from = currentStageOrThrow(stored, 'rework');
      assertLoopHasRoom(stored);
      const reset: StoredTask = {
        ...stored,
        task: {
          ...stored.task,
          iterationCounters: resetAgentIterations(stored.task.iterationCounters),
        },
      };
      const work = await applyHumanDecision(deps, scope, reset, context, {
        kind: 'return',
        from,
        to: input.stage,
        loop: HUMAN_RETURN_LOOP,
        reason: deps.redactor.redactText(input.instructions).value,
        escalationBrief: returnBrief(stored, input.stage),
      });
      return { result: undefined, work: work === null ? null : { job: work } };
    },
  );
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

/**
 * `POST /api/runs/:run_id/cancel` — stop this attempt.
 *
 * ## What it can and cannot do, stated at the line
 *
 * It ends the run **as a record**: the row moves to `cancelled`, `run.finished` is appended, and the
 * task is paused so the pipeline does not act on an attempt nobody will finish. What it does **not**
 * do is interrupt the model's session. `RunHandle.stop` exists and belongs to the process that
 * started the run; reaching it from an HTTP request in another process is Q52's out-of-process
 * transport, which is deliberately unbuilt. So a cancelled run may keep spending for as long as its
 * session takes to end, and when it does end its own process finds the row terminal and discards its
 * outcome (`stage-executor.ts`'s `lostTheRun`, which also states what that costs).
 *
 * ## The arbiter is the row, and that is what makes this safe beside a running stage
 *
 * `RunRepository.finish` is conditional on the run still being live, and PostgreSQL re-evaluates
 * that predicate against the row version a concurrent updater committed — so exactly one of this
 * command and the executor wins, the loser writes nothing, and the winner is the only one that
 * appends to the run's stream. The sequence is read after the row is won for the same reason.
 *
 * The task is paused only when the state machine has that edge: a task that is already `paused`, or
 * one that has finished, keeps the state it is in rather than making this command fail.
 */
export const cancelRunCommand = async (
  deps: HumanCommandDependencies,
  input: { readonly runId: Id; readonly userId: Id },
): Promise<{ readonly taskId: Id }> => {
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
        const run = await deps.store.runs.load(scope.tx, input.runId);
        if (run === null) {
          throw new UnknownAggregateError(`run ${input.runId} does not exist`);
        }
        const context = humanContext(deps, run.taskId, input.userId);
        // The Run's own table decides: a terminal run has no edge to `cancelled`, and the error
        // names the transition it refused.
        assertRunTransition(run.status, 'cancelled');
        const won = await deps.store.runs.finish(scope.tx, {
          runId: run.id,
          status: 'cancelled',
          terminalReason: 'cancelled',
          sessionId: run.sessionId,
          numTurns: run.numTurns,
          usage: run.usage ?? NO_USAGE,
          // Nothing measured this attempt's spend: the session is still the other process's, and
          // what it had burned when the human pressed cancel is not a number anybody here has.
          cost: run.cost ?? { usd: 0, is_estimate: true, price_list_id: null },
          wallMs: wallMsSince(run.startedAt, context.clock.now()),
        });
        if (!won) {
          throw new RunNotLiveError(run.id, run.status, 'cancelled: it has already ended');
        }
        const aggregate = toRunAggregate(
          run,
          await deps.eventStore.nextStreamSequence('run', run.id),
        );
        const decision = finishRun(
          aggregate,
          {
            status: 'cancelled',
            terminalReason: 'cancelled',
            usage: run.usage ?? NO_USAGE,
            modelUsage: [],
            cost: run.cost ?? { usd: 0, is_estimate: true, price_list_id: null },
            numTurns: run.numTurns,
          },
          context,
        );
        const events = [...decision.events];

        const stored = await deps.store.tasks.load(scope.tx, run.taskId);
        if (stored !== null && canTransitionTask(stored.task.state, 'paused')) {
          const paused = pauseTask(stored.task, { reason: 'manual' }, context);
          await deps.store.tasks.save(scope.tx, { ...stored, task: paused.aggregate });
          events.push(...paused.events);
        }
        await scope.events.append(events);
        return { taskId: run.taskId };
      }),
  );
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
      const work = await applyHumanDecision(deps, scope, stored, context, { kind: 'enter', stage });
      return {
        result: undefined,
        work:
          work === null
            ? null
            : { job: work, ...(Object.keys(overrides).length === 0 ? {} : { overrides }) },
      };
    },
  );
  return { taskId: run.taskId, stage };
};
