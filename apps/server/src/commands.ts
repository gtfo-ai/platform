/**
 * The task and run command surface, composed for `apps/server` — technical/08 § "Tasks"/"Runs"
 * (WP-15i).
 *
 * The commands themselves are use cases in the application ring; what this file supplies is the
 * four collaborators they cannot build for themselves — the unit of work, the pipeline store, the
 * queue and the redactor — and the **interface** the routes see. That interface is eleven methods
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
 * API **without** workers composes them with `jobs: null`: pausing, cancelling, answering and
 * deciding all work there, and the four commands that have to start a stage refuse by name rather
 * than moving a task to a stage nothing will run.
 *
 * ## The redactor is the platform's pattern rules, and nothing else
 *
 * TD-012 has two steps: the exact values a run was given, and the platform's patterns. A command
 * arrives on an HTTP request rather than from inside a run, so there is no run-scoped credential to
 * redact against (Q55) — `patternRedactor()` alone is the honest composition, and it is the same
 * one `createIntegrationProber` passes as its `platformRedactor`.
 */
import { randomUUID } from 'node:crypto';
import type { HumanCommandDependencies, Jobs, Logger } from '@platform/application';
import {
  answerTaskQuestion,
  cancelRunCommand,
  cancelTaskCommand,
  decideTaskApproval,
  PIPELINE_ACTOR,
  pauseTaskCommand,
  resumeTaskCommand,
  retryRunCommand,
  retryStageCommand,
  returnToStageCommand,
  reworkStageCommand,
  submitFeedbackCommand,
} from '@platform/application';
import type { AnswerChannel, Effort, Id, IsoDateTime, Slug, UserRole } from '@platform/contracts';
import { SHIPPED_TEMPLATES } from '@platform/domain';
import {
  type eventing as eventingAdapters,
  pipeline as pipelineAdapters,
  redaction as redactionAdapters,
} from '@platform/infrastructure';

/** The eleven commands of technical/08, as the routes see them. */
export interface TaskCommands {
  pause(input: { readonly taskId: string; readonly userId: string }): Promise<void>;
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
}

export interface TaskCommandOptions {
  readonly eventing: ReturnType<typeof eventingAdapters.createEventing>;
  /** `null` on a process that runs no workers; see the module note. */
  readonly jobs: Jobs | null;
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
    eventStore: options.eventing.store,
    redactor: redactionAdapters.patternRedactor(),
    logger: options.logger,
  };

  return {
    pause: async (input) =>
      pauseTaskCommand(deps, { taskId: id(input.taskId), userId: id(input.userId) }),
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
  };
};
