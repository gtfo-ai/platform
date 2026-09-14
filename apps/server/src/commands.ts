/**
 * The task and run command surface, composed for `apps/server` — technical/08 § "Tasks"/"Runs"
 * (WP-15i; steer, take-over and hand-back added by WP-27).
 *
 * The commands themselves are use cases in the application ring; what this file supplies is the
 * five collaborators they cannot build for themselves — the unit of work, the pipeline store, the
 * queue, the redactor and the register of live runs (WP-27) — and the **interface** the routes see.
 * That interface is fourteen methods
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
 * API **without** workers composes `jobs: null` and — this is what `runtime.ts` actually builds — a
 * live-run register that is **empty** rather than absent: `createLiveRuns()` is made once per
 * process, outside the worker branch, because the pipeline and the command surface must share one
 * instance and only the pipeline fills it. Pausing, cancelling, answering and deciding all work
 * there; the five commands that have to start a stage refuse by name rather than moving a task to a
 * stage nothing will run; a **steer** refuses by name rather than reporting a turn nobody heard;
 * and a **take-over** performs — it pauses the task and says `no_live_run`, which is what taking
 * over work that is already on the branch looks like.
 *
 * `liveRuns: null` and an empty register are the same answer to both, which is why the field keeps
 * its `null` arm for a composition root that has no pipeline at all. That is an equality rather
 * than a guess: `human-commands.test.ts` drives the steer's refusal and the take-over's success
 * over both compositions (standing rules 3 and 68). The sentence this paragraph replaced said the
 * API role composes `liveRuns: null`, which `runtime.ts` has never done, and said a take-over
 * refuses, which it has never done either.
 *
 * ## The redactor is the platform's pattern rules, and nothing else
 *
 * TD-012 has two steps: the exact values a run was given, and the platform's patterns. A command
 * arrives on an HTTP request rather than from inside a run, so there is no run-scoped credential to
 * redact against (Q55) — `patternRedactor()` alone is the honest composition, and it is the same
 * one `createIntegrationProber` passes as its `platformRedactor`.
 */
import { randomUUID } from 'node:crypto';
import type { HumanCommandDependencies, Jobs, LiveRuns, Logger } from '@platform/application';
import {
  answerTaskQuestion,
  cancelRunCommand,
  cancelTaskCommand,
  decideTaskApproval,
  handBackTaskCommand,
  PIPELINE_ACTOR,
  pauseTaskCommand,
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
import { SHIPPED_TEMPLATES } from '@platform/domain';
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
  cancel(input: { readonly taskId: string; readonly userId: string }): Promise<void>;
  retryStage(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly stage: string;
  }): Promise<void>;
  returnToStage(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly stage: string;
    readonly reason: string;
  }): Promise<void>;
  rework(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly stage: string;
    readonly instructions: string;
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
  cancelRun(input: {
    readonly runId: string;
    readonly userId: string;
  }): Promise<{ readonly taskId: string }>;
  steerRun(input: {
    readonly runId: string;
    readonly userId: string;
    readonly role: UserRole;
    readonly message: string;
    readonly authorName: string;
  }): Promise<{ readonly taskId: string }>;
  takeOver(input: {
    readonly taskId: string;
    readonly userId: string;
    readonly authorName: string;
    readonly tarball: boolean;
    readonly reason?: string;
  }): Promise<{
    readonly taskId: string;
    readonly branch: string;
    readonly sessionId: string | null;
    readonly exported: boolean;
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
  /**
   * The register of runs **this process** is executing (WP-27), or `null` when it executes none.
   *
   * The same instance the pipeline's runner was wrapped with, which is why the composition root
   * builds it rather than this function: steering and taking over reach into a live session, and a
   * second register would be a second, empty answer to "is that run here". `runtime.ts` passes a
   * real register on every role and lets the API-only one stay **empty**; the `null` arm is for a
   * root with no pipeline, and the module note has the measurement that the two are the same answer.
   */
  readonly liveRuns: LiveRuns | null;
  readonly logger: Logger;
}

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
    liveRuns: options.liveRuns,
    eventStore: options.eventing.store,
    redactor: redactionAdapters.patternRedactor(),
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
    cancel: async (input) =>
      cancelTaskCommand(deps, { taskId: id(input.taskId), userId: id(input.userId) }),
    retryStage: async (input) =>
      retryStageCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        stage: slug(input.stage),
      }),
    returnToStage: async (input) =>
      returnToStageCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        stage: slug(input.stage),
        reason: input.reason,
      }),
    rework: async (input) =>
      reworkStageCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        stage: slug(input.stage),
        instructions: input.instructions,
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
      cancelRunCommand(deps, { runId: id(input.runId), userId: id(input.userId) }),
    steerRun: async (input) =>
      steerRunCommand(deps, {
        runId: id(input.runId),
        userId: id(input.userId),
        role: input.role,
        message: input.message,
        authorName: input.authorName,
      }),
    takeOver: async (input) =>
      takeOverTaskCommand(deps, {
        taskId: id(input.taskId),
        userId: id(input.userId),
        authorName: input.authorName,
        tarball: input.tarball,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
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
