/**
 * The task and run command surface, composed for `apps/server` — technical/08 § "Tasks"/"Runs"
 * (WP-15i; steer, take-over and hand-back added by WP-27).
 *
 * The commands themselves are use cases in the application ring; what this file supplies is the
 * four collaborators they cannot build for themselves — the unit of work, the pipeline store, the
 * queue and the redactor — and the **interface** the routes see. That interface is fourteen methods
 * rather than the dependency bundle, for the reason `KnowledgeCommands` and `OnboardingCommands`
 * next door are shaped the same way: a route module that names a `UnitOfWork` cannot be driven
 * without one, and the decisions in `routes/commands.ts` (the key policy, the replay, the audit row,
 * the guards) are worth a fast tier of their own. It is also the one place the branded id types are
 * applied, so eleven route handlers do not each carry a cast.
 *
 * ## `null` is a role, not a failure
 *
 * A process that composed no eventing has no commands, and the routes answer `503` naming the
 * missing piece rather than 404 — the shape `routes/kb.ts` established. A process that serves the
 * API **without** workers composes — this is what `runtime.ts` actually builds — an **enqueue-only**
 * job client (WP-72; until then `jobs: null`), and every command works there, the five that start a
 * stage included — the worker beside it takes the stage job. A composition root with no job client
 * at all (`jobs: null`) still refuses the five by name rather than moving a task to a stage nothing
 * will run.
 *
 * ## Steer and take-over reach a run through the database (WP-85)
 *
 * Until WP-85 this surface held the process's live-run register, and on the shipped topology the
 * process that serves the API never holds a run, so every steer was refused `run_not_reachable` and
 * every take-over recorded `run_id: null` (PROGRESS backlog 134). TD-028 decision 9 replaced the
 * register lookup: the command records a `run_commands` row beside its event and wakes the run's
 * lease holder with `pg_notify`, and the holder applies it (`pipeline/run-commands.ts`, composed in
 * `pipeline.ts`). So this surface needs no register at all, and the two commands answer the same on
 * every role: *accepted*, then applied or refused on the run screen.
 *
 * ## The redactor is the platform's pattern rules, and nothing else
 *
 * TD-012 has two steps: the exact values a run was given, and the platform's patterns. A command
 * arrives on an HTTP request rather than from inside a run, so there is no run-scoped credential to
 * redact against (Q55) — `patternRedactor()` alone is the honest composition, and it is the same
 * one `createIntegrationProber` passes as its `platformRedactor`.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { HumanCommandDependencies, Jobs, Logger } from '@platform/application';
import {
  answerTaskQuestion,
  cancelRunCommand,
  cancelTaskCommand,
  decideTaskApproval,
  handBackTaskCommand,
  PIPELINE_ACTOR,
  pauseTaskCommand,
  raiseTaskBudgetCommand,
  resumeTaskCommand,
  retryRunCommand,
  retryStageCommand,
  returnToStageCommand,
  reworkStageCommand,
  steerRunCommand,
  submitFeedbackCommand,
  takeOverTaskCommand,
} from '@platform/application';
import type { AnswerChannel, Effort, Id, IsoDateTime, Slug, UserRole } from '@platform/contracts';
import { DEFAULT_TASK_BUDGET_USD, SHIPPED_TEMPLATES } from '@platform/domain';
import {
  type eventing as eventingAdapters,
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
} from '@platform/infrastructure';

/** The fourteen commands of technical/08, as the routes see them. */
export interface TaskCommands {
  /**
   * Answers with the person's own words, redacted, because the `human_actions` row is the only
   * place a pause's reason is kept (`pipeline/commands.ts`'s `auditedReason`). The route records
   * what came back; it never reads the body for the row.
   */
  pause(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly reason?: string;
  }): Promise<{ readonly reason: string | null }>;
  resume(input: { readonly taskId: string; readonly userId: string }): Promise<void>;
  /**
   * Raises the task's own cap (WP-131 review round 1): answers the cap it was raised to and the one
   * it replaced, for the audit row. A figure not above the cap in force is refused (409).
   */
  raiseBudget(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly capUsd: number;
  }): Promise<{ readonly capUsd: number; readonly previousCapUsd: number }>;
  cancel(input: { readonly taskId: string; readonly userId: string }): Promise<void>;
  /**
   * Answers the attempt entered and the stage's run it stopped, if one was in flight (PROGRESS
   * backlog 494); the stop's `run_commands` id is derived from the `Idempotency-Key`.
   */
  retryStage(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly stage: string;
    readonly idempotencyKey: string | null;
  }): Promise<{
    readonly attempt: number | null;
    readonly stoppedRun: { readonly runId: string; readonly commandId: string | null } | null;
  }>;
  returnToStage(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly stage: string;
    readonly reason: string;
    /** WP-152: the request's `attach_gate_feedback`, absent for the default. */
    readonly attachGateFeedback?: boolean;
  }): Promise<void>;
  rework(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly stage: string;
    readonly instructions: string;
    /** WP-152: the request's `attach_gate_feedback`, absent for the default. */
    readonly attachGateFeedback?: boolean;
  }): Promise<void>;
  submitFeedback(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly scope: 'task' | 'stage' | 'artifact' | 'project';
    readonly text: string;
    readonly channel: AnswerChannel;
    readonly rating?: number;
    readonly stage?: string;
    readonly artifactId?: string;
  }): Promise<{ readonly feedbackId: string }>;
  answerQuestion(input: {
    readonly questionId: string;
    readonly answer: string;
    readonly userId: string;
    readonly role: UserRole;
    readonly channel: AnswerChannel;
  }): Promise<void>;
  decideApproval(input: {
    readonly approvalId: string;
    readonly decision: 'approved' | 'rejected';
    readonly userId: string;
    readonly role: UserRole;
    readonly reason?: string;
  }): Promise<void>;
  retryRun(input: {
    readonly runId: string;
    readonly userId: string;
    readonly model?: string;
    readonly effort?: Effort;
  }): Promise<{ readonly taskId: string; readonly stage: string }>;
  /**
   * TD-028 decision 11 (WP-101): with a live lease, **records** the stop for the process holding the
   * session and answers its `run_commands` id; with none, ends the record in place and answers
   * `commandId: null`.
   */
  cancelRun(input: {
    readonly runId: string;
    readonly userId: string;
    /** The request's `Idempotency-Key`: the recorded stop's id is derived from it. */
    readonly idempotencyKey: string | null;
  }): Promise<{ readonly taskId: string; readonly commandId: string | null }>;
  /**
   * **Records** the turn for the process holding the run and answers the `run_commands` id (WP-85,
   * TD-028 decision 9) — never a claim that the session took it.
   */
  steerRun(input: {
    readonly runId: string;
    readonly userId: string;
    readonly role: UserRole;
    readonly message: string;
    readonly authorName: string;
    /** The request's `Idempotency-Key`: the command's id is derived from it ({@link runCommandIdFor}). */
    readonly idempotencyKey: string | null;
  }): Promise<{ readonly taskId: string; readonly commandId: string }>;
  takeOver(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly authorName: string;
    readonly tarball: boolean;
    readonly reason?: string;
    readonly idempotencyKey: string | null;
  }): Promise<{
    readonly taskId: string;
    readonly branch: string;
    readonly sessionId: string | null;
    readonly exported: boolean;
    /** The run whose stop was recorded, or `null` when the task had no live run (WP-85). */
    readonly runId: string | null;
    /** Redacted, for the audit row, like `pause`'s: it is not part of the response. */
    readonly reason: string | null;
  }>;
  handBack(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly stage: string;
    readonly summary: string;
  }): Promise<void>;
}

export interface TaskCommandOptions {
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /** `null` on a process that runs no workers; see the module note. */
  readonly jobs: Jobs | null;
  readonly logger: Logger;
}

/**
 * A `run_commands` id derived from `(user, action, Idempotency-Key)` — migration 0060's *"id is
 * derived from the key"*.
 *
 * The key's own record (`command_idempotency`, `routes/idempotency.ts`) is what refuses a replay;
 * this is the second line, so a replay that somehow got past it collides on the primary key instead
 * of recording a second turn the run would pay for. The scope is the key's own — `(user, action,
 * key)` — so two people's identical keys, or one person's key on two commands, are two ids. A
 * version-8 UUID (RFC 9562's "custom" layout) over the first 128 bits of a SHA-256: the column is a
 * `uuid` and `idSchema` checks the version and variant nibbles.
 */
export const runCommandIdFor = (userId: string, action: string, key: string): Id => {
  const hex = createHash('sha256').update(`${userId}\0${action}\0${key}`).digest('hex');
  const variant = ((Number.parseInt(hex.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}` as Id;
};

/** The branded ids the application ring speaks, applied once (see the module note). */
const id = (value: string): Id => value as Id;
const slug = (value: string): Slug => value as Slug;

export const createTaskCommands = (options: TaskCommandOptions): TaskCommands => {
  const deps: HumanCommandDependencies = {
    unitOfWork: options.eventing.unitOfWork,
    store: pipelineAdapters.createPostgresPipelineStore({ templates: SHIPPED_TEMPLATES }),
    /**
     * The default actor is the pipeline's; every command replaces it with the person who issued it.
     *
     * Stated here rather than left implicit because it is the one field of the context a caller
     * must not forget: an event written with `PIPELINE_ACTOR` for a human command would make the
     * audit say the platform did what a person did.
     */
    context: (correlationId: Id) => ({
      ids: { next: (): Id => randomUUID() as Id },
      actor: PIPELINE_ACTOR,
      clock: { now: (): IsoDateTime => new Date().toISOString() as IsoDateTime },
      correlationId,
      causeEventId: null,
    }),
    jobs: options.jobs,
    eventStore: options.eventing.store,
    redactor: redactionAdapters.patternRedactor(),
    // What the production settings port answers for every project (`defaultProjectSettings`,
    // `packages/application/src/pipeline/settings.ts`): the task cap has no configuration key in
    // this build, so its default is the one figure a raise is compared against (WP-131).
    defaultTaskCapUsd: DEFAULT_TASK_BUDGET_USD,
    logger: options.logger,
  };

  return {
    pause: async (input) =>
      pauseTaskCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    resume: async (input) =>
      resumeTaskCommand(deps, { taskId: id(input.taskId), userId: id(input.userId) }),
    raiseBudget: async (input) =>
      raiseTaskBudgetCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        capUsd: input.capUsd,
      }),
    cancel: async (input) =>
      cancelTaskCommand(deps, { taskId: id(input.taskId), userId: id(input.userId) }),
    retryStage: async (input) =>
      retryStageCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        stage: slug(input.stage),
        ...(input.idempotencyKey === null
          ? {}
          : {
              stopCommandId: runCommandIdFor(
                input.userId,
                'task.retry_stage',
                input.idempotencyKey,
              ),
            }),
      }),
    returnToStage: async (input) =>
      returnToStageCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        stage: slug(input.stage),
        reason: input.reason,
        ...(input.attachGateFeedback === undefined
          ? {}
          : { attachGateFeedback: input.attachGateFeedback }),
      }),
    rework: async (input) =>
      reworkStageCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        stage: slug(input.stage),
        instructions: input.instructions,
        ...(input.attachGateFeedback === undefined
          ? {}
          : { attachGateFeedback: input.attachGateFeedback }),
      }),
    submitFeedback: async (input) =>
      submitFeedbackCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        scope: input.scope,
        text: input.text,
        channel: input.channel,
        ...(input.rating === undefined ? {} : { rating: input.rating }),
        ...(input.stage === undefined ? {} : { stage: slug(input.stage) }),
        ...(input.artifactId === undefined ? {} : { artifactId: id(input.artifactId) }),
      }),
    answerQuestion: async (input) =>
      answerTaskQuestion(deps, {
        questionId: id(input.questionId),
        answer: input.answer,
        userId: id(input.userId),
        role: input.role,
        channel: input.channel,
      }),
    decideApproval: async (input) =>
      decideTaskApproval(deps, {
        approvalId: id(input.approvalId),
        decision: input.decision,
        userId: id(input.userId),
        role: input.role,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
      }),
    retryRun: async (input) =>
      retryRunCommand(deps, {
        runId: id(input.runId),
        userId: id(input.userId),
        ...(input.model === undefined ? {} : { model: input.model }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
      }),
    cancelRun: async (input) =>
      cancelRunCommand(deps, {
        runId: id(input.runId),
        userId: id(input.userId),
        ...(input.idempotencyKey === null
          ? {}
          : { commandId: runCommandIdFor(input.userId, 'run.cancel', input.idempotencyKey) }),
      }),
    steerRun: async (input) =>
      steerRunCommand(deps, {
        runId: id(input.runId),
        userId: id(input.userId),
        role: input.role,
        message: input.message,
        authorName: input.authorName,
        ...(input.idempotencyKey === null
          ? {}
          : { commandId: runCommandIdFor(input.userId, 'run.steer', input.idempotencyKey) }),
      }),
    takeOver: async (input) =>
      takeOverTaskCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        authorName: input.authorName,
        tarball: input.tarball,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        ...(input.idempotencyKey === null
          ? {}
          : { commandId: runCommandIdFor(input.userId, 'task.take_over', input.idempotencyKey) }),
      }),
    handBack: async (input) =>
      handBackTaskCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        stage: slug(input.stage),
        summary: input.summary,
      }),
  };
};
