/**
 * The eleven task and run **commands** the SPA has been calling since WP-20 — technical/08 §
 * "Tasks" and § "Runs" (WP-15i).
 *
 *   POST /api/tasks/:task_id/pause | resume | cancel
 *   POST /api/tasks/:task_id/retry-stage | return-to-stage | rework | feedback
 *   POST /api/tasks/:task_id/questions/:question_id/answer
 *   POST /api/tasks/:task_id/approvals/:approval_id/decide
 *   POST /api/runs/:run_id/retry | cancel
 *
 * Every one of them is the same six steps, which is why {@link command} exists rather than eleven
 * near-copies: read the key, refuse a replay, call the **application** command, record the human
 * action, and answer where the aggregate now stands. What differs per route is the contract, the
 * capability and the one call in the middle.
 *
 * ## Six decisions that are the row's, not this file's
 *
 * **The guard asks about the role; the aggregate asks about the state.** `requirePermission` is
 * given no `subject`, so a caller who *may* pause gets past it whatever the task's state is, and a
 * task that cannot be paused answers **409** naming the transition. The alternative — handing the
 * state to `can()` — would answer 403 for a state problem, and "you may not do that" and "not to
 * this, not now" are different sentences. `packages/domain/src/permissions.ts` still carries the
 * state rules; they are what the *domain* commands enforce.
 *
 * **The `Idempotency-Key` is required exactly where a repeat would create a second thing.** The
 * seven the client already marks idempotent — answer, decide, retry-stage, return-to-stage, rework,
 * feedback and run retry — each create one (an answer, a decision, a new attempt, a feedback
 * record), so the header is required and its replay performs nothing twice. The other four (pause,
 * resume, task cancel, run cancel) are **state assertions**: a second pause is `paused → paused`,
 * which technical/02's table does not have, so the aggregate already refuses the repeat and the
 * header is optional. It is still honoured when sent, because a client that sends one should get
 * the reuse check.
 *
 * **A refusal is translated here rather than globally.** The aggregate raises an
 * `IllegalTransitionError` and the use cases raise six more; {@link performing} turns each into the
 * status it is *to a caller who chose the transition*, and `errors.ts` leaves the same classes as
 * `500 internal_error` everywhere else, because on a route that reads they are this build's bug and
 * not the caller's request.
 *
 * **A refused command writes no `human_actions` row.** The row is written after the effect commits,
 * so a 409 leaves nothing behind — "who did what" is a log of what happened, not of what was
 * attempted. (The audit of a *refusal* is the request log, which carries the route, the actor and
 * the status.)
 *
 * **The guards run at `preValidation`.** Fastify validates the body before `preHandler`, and every
 * route here takes one, so an anonymous caller would be told the route's shape before being
 * refused. `routes/kb.ts` and `routes/onboarding.ts` moved for the same reason; `scope.test.ts`
 * reads this position too, so a route that slips back is caught.
 *
 * **Free text is the client's, bounded by the contract and redacted by the command.** All five
 * fields — a question's answer, an approval's reason, a return's reason, rework instructions and
 * feedback text — are untrusted (BD-022): `packages/contracts` caps each at
 * `MAX_COMMAND_TEXT_CHARS` and the application command applies TD-012 at the one place it stores
 * each of them (`pipeline/commands.ts`'s `redactor`). What is
 * recorded here, in `human_actions.params`, is the *shape* of the request — the stage, the decision,
 * the scope, the key — and **not** the free text, so the audit row cannot become a second copy of
 * an unredacted sentence.
 */

import type { RunStatus, TaskState, UserRole } from '@platform/contracts';
import {
  answerQuestionRequestSchema,
  apiErrorSchema,
  cancelRunRequestSchema,
  cancelTaskRequestSchema,
  decideApprovalRequestSchema,
  type JsonObject,
  pauseTaskRequestSchema,
  resumeTaskRequestSchema,
  retryRunRequestSchema,
  retryStageRequestSchema,
  returnToStageRequestSchema,
  reworkRequestSchema,
  runCommandResponseSchema,
  submitFeedbackRequestSchema,
  submitFeedbackResponseSchema,
  taskCommandResponseSchema,
} from '@platform/contracts';
import type { PermissionAction } from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import type { TaskCommands } from '../commands.js';
import { commandRefusal, HttpError, NotFoundError } from '../errors.js';
import { idempotentReplay, readIdempotencyKey, requireIdempotencyKey } from './idempotency.js';
import { scopedProject, scopeToProject } from './scope.js';

/**
 * Everything these routes read or write outside the application ring, as seven functions.
 *
 * Injected rather than imported, so this module **names no database at all** — the argument
 * `requirePermission`'s `projectRole` makes one layer down, and the reason eleven routes can be
 * driven by `routes/commands.test.ts` against plain functions: the guard order, the key policy, the
 * replay, the audit row and every refusal are decisions of this file, and a decision that needs a
 * PostgreSQL container to exercise is a decision no fast tier asserts.
 */
export interface CommandQueries {
  readonly taskProjectId: (taskId: string) => Promise<string | null>;
  readonly runProjectId: (runId: string) => Promise<string | null>;
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  readonly taskPosition: (
    taskId: string,
  ) => Promise<{ readonly state: TaskState; readonly currentStage: string | null } | null>;
  readonly runPosition: (runId: string) => Promise<{
    readonly status: RunStatus;
    readonly taskId: string;
    readonly taskState: TaskState;
  } | null>;
  /**
   * The previous attempt under an `Idempotency-Key`, for {@link idempotentReplay}.
   *
   * Keyed by the **caller** as well as by the command and the key: a key belongs to whoever issued
   * it, and the argument for that scope is in `./idempotency.ts`.
   */
  readonly previousAttempt: (query: {
    readonly userId: string;
    readonly action: string;
    readonly key: string;
  }) => Promise<{ readonly bodyDigest: string | null; readonly params: JsonObject } | null>;
  readonly recordAction: (input: {
    readonly userId: string;
    readonly action: string;
    readonly params: JsonObject;
    readonly taskId?: string | null;
  }) => Promise<void>;
}

export interface CommandRoutesOptions {
  readonly queries: CommandQueries;
  /**
   * The commands, or `null` on a process that composed no pipeline.
   *
   * `null` answers `503` by name rather than 404, like `knowledge` and `onboarding`: the path
   * exists and this process cannot serve it, which is a different thing from a wrong URL.
   */
  readonly commands: TaskCommands | null;
}

/**
 * Calls the application command, translating a **refusal** into the answer it is to this caller.
 *
 * This call is what scopes {@link commandRefusal} to the command surface: a state machine with no
 * such edge, a spent loop or a run that is not live mean "you asked for something the resource's
 * state does not allow" *here*, and mean "this build has a bug" on a route that reads. `toApiError`
 * therefore answers 500 for the same error classes and only these routes translate them — that
 * function's note carries the measurement (`PolicyViolationError` is also what a malformed shipped
 * template raises).
 *
 * Anything else is rethrown untouched, including the `HttpError`s this module raises itself.
 */
const performing = async <T>(perform: () => Promise<T>): Promise<T> => {
  try {
    return await perform();
  } catch (error) {
    const refusal = commandRefusal(error);
    if (refusal === null) {
      throw error;
    }
    throw refusal;
  }
};

const taskParamsSchema = z.strictObject({ task_id: z.uuid() });
const questionParamsSchema = z.strictObject({ task_id: z.uuid(), question_id: z.uuid() });
const approvalParamsSchema = z.strictObject({ task_id: z.uuid(), approval_id: z.uuid() });
const runParamsSchema = z.strictObject({ run_id: z.uuid() });

/** Whether a repeat under a used key would create a second thing (see the module note). */
type KeyPolicy = 'required' | 'optional';

export const registerCommandRoutes = async (
  app: FastifyInstance,
  options: CommandRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };

  /**
   * The project a task or a run belongs to, resolved before the guard decides.
   *
   * `lenient` because these hooks run at `preValidation` and therefore see an **unvalidated** path
   * segment: a non-uuid is left unresolved, the guard falls back to the organisation role (the
   * caller is still refused if they may not act), and the 400 arrives from the validator a moment
   * later. The same shape `routes/onboarding.ts`'s `projectOf` uses, and the reason a malformed id
   * never reaches a query.
   */
  const scope = scopeToProject({
    param: 'task_id',
    what: 'task',
    projectOf: options.queries.taskProjectId,
    lenient: true,
  });
  const scopeRun = scopeToProject({
    param: 'run_id',
    what: 'run',
    projectOf: options.queries.runProjectId,
    lenient: true,
  });

  const commands = (): TaskCommands => {
    if (options.commands === null) {
      throw new HttpError(
        503,
        'commands_unavailable',
        'this process composed no pipeline, so it cannot act on a task: it serves reads only. Ask an instance that runs the workers',
      );
    }
    return options.commands;
  };

  const actorOf = (request: FastifyRequest): { userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`, which refuses an anonymous caller first; kept
      // because the audit row's user id is not optional and a 500 would be the wrong answer.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };

  const positionOf = async (taskId: string) => {
    const position = await options.queries.taskPosition(taskId);
    if (position === null) {
      throw new NotFoundError(`task ${taskId}`);
    }
    return {
      task_id: taskId,
      state: position.state,
      current_stage: position.currentStage,
    };
  };

  const runPositionOf = async (runId: string) => {
    const position = await options.queries.runPosition(runId);
    if (position === null) {
      throw new NotFoundError(`run ${runId}`);
    }
    return {
      run_id: runId,
      task_id: position.taskId,
      status: position.status,
      task_state: position.taskState,
    };
  };

  /**
   * The six steps every command shares.
   *
   * `perform` is called only when this request is not a replay, and the `human_actions` row is
   * written only when `perform` returned — so a refusal writes nothing and a replay performs
   * nothing.
   */
  const command = async <T, TAnswer>(input: {
    readonly request: FastifyRequest;
    readonly action: string;
    readonly key: KeyPolicy;
    /** What the digest is taken over: the body plus whatever the path contributes. */
    readonly subject: unknown;
    /** The shape of the request, for the audit row. Never the free text (see the module note). */
    readonly params: JsonObject;
    /** What the command produced, for the audit row — the one thing a replay cannot recompute. */
    readonly auditResult?: (result: T) => JsonObject;
    /**
     * The task the audit row names — `human_actions.task_id`, the table's only index.
     *
     * A **function** for the two run commands, which learn the task from what the command returned:
     * the route has a run id and the row would otherwise be the one kind of `human_actions` row
     * that cannot be found by the index every reader of the table will use.
     */
    readonly taskId?: string | ((result: T) => string);
    readonly perform: () => Promise<T>;
    readonly answer: (outcome: {
      readonly performed: boolean;
      readonly result: T | null;
      /** What the replayed attempt recorded, for an answer this request cannot recompute. */
      readonly previous: JsonObject | null;
    }) => Promise<TAnswer>;
  }): Promise<TAnswer> => {
    // Before the replay, not after it: the key is scoped to the caller, so a lookup with no actor
    // would read another person's attempt (`./idempotency.ts`).
    const actor = actorOf(input.request);
    const key =
      input.key === 'required'
        ? requireIdempotencyKey(input.request)
        : readIdempotencyKey(input.request);
    const replay = await idempotentReplay(options.queries.previousAttempt, {
      userId: actor.userId,
      action: input.action,
      key,
      request: input.subject,
    });
    if (replay.replayed) {
      return input.answer({ performed: false, result: null, previous: replay.previous });
    }
    const result = await performing(input.perform);
    const taskId = typeof input.taskId === 'function' ? input.taskId(result) : input.taskId;
    await options.queries.recordAction({
      userId: actor.userId,
      action: input.action,
      params: {
        ...input.params,
        ...(input.auditResult === undefined ? {} : input.auditResult(result)),
        ...(key === null ? {} : { idempotency_key: key }),
        ...(replay.digest === null ? {} : { body_digest: replay.digest }),
      },
      ...(taskId === undefined ? {} : { taskId }),
    });
    return input.answer({ performed: true, result, previous: null });
  };

  /** The feedback id a replayed attempt recorded, or a refusal: it never answers a placeholder. */
  const feedbackIdOf = (previous: JsonObject | null): string => {
    const recorded = previous?.feedback_id;
    if (typeof recorded !== 'string') {
      // A row written by a build before this field existed. Refusing is the honest answer: the
      // command was performed and this process cannot say what it produced.
      throw new HttpError(
        409,
        'idempotency_key_reused',
        'this Idempotency-Key has already recorded feedback, and the attempt that did predates the id being audited; use a new key',
      );
    }
    return recorded;
  };

  /** One task command: the five things that differ between them, and nothing else. */
  const taskCommand = <TBody extends z.ZodType>(route: {
    readonly path: string;
    readonly action: PermissionAction;
    readonly name: string;
    readonly key: KeyPolicy;
    readonly body: TBody;
    readonly summary: string;
    readonly description: string;
    readonly params: (body: z.output<TBody>) => JsonObject;
    readonly perform: (input: {
      readonly deps: TaskCommands;
      readonly body: z.output<TBody>;
      readonly taskId: string;
      readonly userId: string;
    }) => Promise<void>;
  }): void => {
    typed.post(
      route.path,
      {
        preValidation: [scope, requirePermission(guard, route.action, { project: scopedProject })],
        schema: {
          summary: route.summary,
          description: route.description,
          tags: ['tasks'],
          params: taskParamsSchema,
          body: route.body,
          response: {
            200: taskCommandResponseSchema,
            400: apiErrorSchema,
            409: apiErrorSchema,
            503: apiErrorSchema,
          },
        },
      },
      async (request) => {
        const taskId = request.params.task_id;
        const body = request.body as z.output<TBody>;
        return command({
          request,
          action: route.name,
          key: route.key,
          subject: { task_id: taskId, body },
          params: { task_id: taskId, ...route.params(body) },
          taskId,
          perform: async () => {
            const deps = commands();
            const { userId } = actorOf(request);
            await route.perform({ deps, body, taskId, userId });
          },
          answer: async ({ performed }) => ({ ...(await positionOf(taskId)), performed }),
        });
      },
    );
  };

  taskCommand({
    path: '/api/tasks/:task_id/pause',
    action: 'task.pause',
    name: 'task.pause',
    key: 'optional',
    body: pauseTaskRequestSchema,
    summary: 'Pause the task',
    description:
      'The pipeline stops advancing it: a run already in flight is recorded when it ends, and its stage is **not** completed. Stopping the session itself is `POST /api/runs/:run_id/cancel`. A task that is already paused, done or cancelled answers 409 naming the transition. `reason` is recorded in the audit row, not in the event: `task.paused` carries the *kind* of pause (`manual`).',
    params: () => ({}),
    perform: async ({ deps, taskId, userId }) => deps.pause({ taskId, userId }),
  });

  taskCommand({
    path: '/api/tasks/:task_id/resume',
    action: 'task.resume',
    name: 'task.resume',
    key: 'optional',
    body: resumeTaskRequestSchema,
    summary: 'Resume the task at the stage it stopped at',
    description:
      'Re-enters the current stage and enqueues it; no iteration round is spent, because the task stood still rather than going round. A state the task cannot leave for that stage — a task paused at `ready_for_merge`, say — answers 409 naming the transition, and the way out is `return-to-stage`.',
    params: () => ({}),
    perform: async ({ deps, taskId, userId }) => deps.resume({ taskId, userId }),
  });

  taskCommand({
    path: '/api/tasks/:task_id/cancel',
    action: 'task.cancel',
    name: 'task.cancel',
    key: 'optional',
    body: cancelTaskRequestSchema,
    summary: 'Cancel the task',
    description:
      'Terminal: `task.cancelled` carries the totals the runs actually produced. A task that has already finished answers 409.',
    params: () => ({}),
    perform: async ({ deps, taskId, userId }) => deps.cancel({ taskId, userId }),
  });

  taskCommand({
    path: '/api/tasks/:task_id/retry-stage',
    action: 'task.retry_stage',
    name: 'task.retry_stage',
    key: 'required',
    body: retryStageRequestSchema,
    summary: 'Run the current stage again, as a new attempt',
    description:
      'The stage must be the one the task is at: sending it somewhere else is `return-to-stage`, which counts a round and records a reason. The attempt counter moves, which supersedes any run still in flight for the old attempt.',
    params: (body) => ({ stage: body.stage }),
    perform: async ({ deps, body, taskId, userId }) =>
      deps.retryStage({ taskId, userId, stage: body.stage }),
  });

  taskCommand({
    path: '/api/tasks/:task_id/return-to-stage',
    action: 'task.return_to_stage',
    name: 'task.return_to_stage',
    key: 'required',
    body: returnToStageRequestSchema,
    summary: 'Send the task back to an earlier stage with a reason',
    description:
      'Spends one of BD-008’s human rounds; when they are spent the command is refused (409) rather than the task being escalated — no HTTP request parks a task for a human. The reason reaches the stage the task returns to, so it is redacted where it is stored (TD-012).',
    params: (body) => ({ stage: body.stage }),
    perform: async ({ deps, body, taskId, userId }) =>
      deps.returnToStage({ taskId, userId, stage: body.stage, reason: body.reason }),
  });

  taskCommand({
    path: '/api/tasks/:task_id/rework',
    action: 'task.rework',
    name: 'task.rework',
    key: 'required',
    body: reworkRequestSchema,
    summary: 'Reject the approach and restart from a stage',
    description:
      'product/04’s "human rejection = reset, not patching": the instructions travel as the return’s reason and the **agent-to-agent** iteration counters are reset, while the human rounds are not. Closing the old merge request is not done here.',
    params: (body) => ({ stage: body.stage }),
    perform: async ({ deps, body, taskId, userId }) =>
      deps.rework({ taskId, userId, stage: body.stage, instructions: body.instructions }),
  });

  typed.post(
    '/api/tasks/:task_id/feedback',
    {
      preValidation: [
        scope,
        requirePermission(guard, 'task.feedback.create', { project: scopedProject }),
      ],
      schema: {
        summary: 'Record feedback about this task, a stage or an artifact',
        description:
          'An opinion, not a transition: the task does not move. The text is untrusted (BD-022) and is redacted where it is stored; it is persisted as its `feedback.received` event, which is what the feedback intake agent reads.',
        tags: ['tasks'],
        params: taskParamsSchema,
        body: submitFeedbackRequestSchema,
        response: {
          200: submitFeedbackResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const taskId = request.params.task_id;
      const body = request.body;
      return command({
        request,
        action: 'task.feedback',
        key: 'required',
        subject: { task_id: taskId, body },
        params: {
          task_id: taskId,
          scope: body.scope,
          ...(body.stage === undefined ? {} : { stage: body.stage }),
          ...(body.rating === undefined ? {} : { rating: body.rating }),
        },
        auditResult: (result) => ({ feedback_id: result.feedbackId }),
        taskId,
        perform: async () => {
          const { userId } = actorOf(request);
          return commands().submitFeedback({
            taskId,
            userId,
            scope: body.scope,
            text: body.text,
            channel: 'ui',
            ...(body.rating === undefined ? {} : { rating: body.rating }),
            ...(body.stage === undefined ? {} : { stage: body.stage }),
            ...(body.artifact_id === undefined ? {} : { artifactId: body.artifact_id }),
          });
        },
        answer: async ({ performed, result, previous }) => ({
          // On a replay the id comes from the attempt this request repeats: the audit row records
          // what the command made, which is the only place a retry can read it from.
          feedback_id: result?.feedbackId ?? feedbackIdOf(previous),
          task_id: taskId,
          performed,
        }),
      });
    },
  );

  typed.post(
    '/api/tasks/:task_id/questions/:question_id/answer',
    {
      preValidation: [
        scope,
        requirePermission(guard, 'task.answer_question', { project: scopedProject }),
      ],
      schema: {
        summary: 'Answer a question a stage asked',
        description:
          'First answer wins (technical/02): a question that is not open answers 409 naming the transition, whichever channel answered it first. The task resumes on the event this writes, once every blocking question is answered.',
        tags: ['tasks'],
        params: questionParamsSchema,
        body: answerQuestionRequestSchema,
        response: {
          200: taskCommandResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const { task_id: taskId, question_id: questionId } = request.params;
      const body = request.body;
      return command({
        request,
        action: 'task.question.answer',
        key: 'required',
        subject: { question_id: questionId, body },
        params: { task_id: taskId, question_id: questionId },
        taskId,
        perform: async () => {
          const { userId } = actorOf(request);
          await commands().answerQuestion({
            questionId,
            answer: body.answer,
            userId,
            // The role the guard actually applied — the project membership where there is one,
            // the organisation role otherwise. The aggregate asks `can()` again with it.
            role: request.effectiveRole ?? 'viewer',
            channel: 'ui',
          });
        },
        answer: async ({ performed }) => ({ ...(await positionOf(taskId)), performed }),
      });
    },
  );

  typed.post(
    '/api/tasks/:task_id/approvals/:approval_id/decide',
    {
      // `task.approve_plan` is the coarse gate (maintainer, technical/08’s own entry). Which
      // permission really applies depends on the approval’s **kind**, and the aggregate decides
      // that through `APPROVAL_ACTIONS` — so a budget approval (WP-28) flows through this same
      // route and is checked as `task.approve_budget` rather than needing a second endpoint.
      preValidation: [
        scope,
        requirePermission(guard, 'task.approve_plan', { project: scopedProject }),
      ],
      schema: {
        summary: 'Approve or reject a gate the pipeline is waiting on',
        description:
          'BD-006’s plan approval today; the budget approval of WP-28 flows through the same route, and the approval’s kind decides which capability the aggregate requires. An approval that has already been decided answers 409.',
        tags: ['tasks'],
        params: approvalParamsSchema,
        body: decideApprovalRequestSchema,
        response: {
          200: taskCommandResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const { task_id: taskId, approval_id: approvalId } = request.params;
      const body = request.body;
      return command({
        request,
        action: 'task.approval.decide',
        key: 'required',
        subject: { approval_id: approvalId, body },
        params: { task_id: taskId, approval_id: approvalId, decision: body.decision },
        taskId,
        perform: async () => {
          const { userId } = actorOf(request);
          await commands().decideApproval({
            approvalId,
            decision: body.decision === 'approve' ? 'approved' : 'rejected',
            userId,
            role: request.effectiveRole ?? 'viewer',
            ...(body.reason === undefined ? {} : { reason: body.reason }),
          });
        },
        answer: async ({ performed }) => ({ ...(await positionOf(taskId)), performed }),
      });
    },
  );

  typed.post(
    '/api/runs/:run_id/retry',
    {
      preValidation: [scopeRun, requirePermission(guard, 'run.retry', { project: scopedProject })],
      schema: {
        summary: 'Run this run’s stage again, optionally on another model',
        description:
          'Creates a **new attempt** of the stage rather than a second run of the same one: technical/02 allows a task one active run. A run that has not ended yet is refused (cancel it first), and so is one whose stage the task has already left. `budget_usd` is refused: raising a run’s cap is the budget approval of BD-006, which WP-28 owns.',
        tags: ['runs'],
        params: runParamsSchema,
        body: retryRunRequestSchema,
        response: {
          200: runCommandResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const runId = request.params.run_id;
      const body = request.body;
      if (body.budget_usd !== undefined) {
        throw new HttpError(
          409,
          'budget_override_unsupported',
          'this build cannot raise a run’s budget from a retry: a cap that a caller may lift is BD-006’s budget approval, which is WP-28’s work package. Retry without `budget_usd`, or raise the project’s stage budget in its configuration',
        );
      }
      return command({
        request,
        action: 'run.retry',
        key: 'required',
        subject: { run_id: runId, body },
        params: {
          run_id: runId,
          ...(body.model === undefined ? {} : { model: body.model }),
          ...(body.effort === undefined ? {} : { effort: body.effort }),
        },
        // What the retry produced is where the task comes from: the path names a run.
        taskId: (result) => result.taskId,
        perform: async () => {
          const { userId } = actorOf(request);
          return commands().retryRun({
            runId,
            userId,
            ...(body.model === undefined ? {} : { model: body.model }),
            ...(body.effort === undefined ? {} : { effort: body.effort }),
          });
        },
        answer: async ({ performed }) => ({ ...(await runPositionOf(runId)), performed }),
      });
    },
  );

  typed.post(
    '/api/runs/:run_id/cancel',
    {
      preValidation: [scopeRun, requirePermission(guard, 'run.cancel', { project: scopedProject })],
      schema: {
        summary: 'Stop this attempt',
        description:
          'Ends the run as a **record** — the row becomes `cancelled`, `run.finished` is appended and the task is paused so the pipeline does not act on an attempt nobody will finish. It does **not** interrupt the model’s session: reaching a live run from another process is the transport Q52 leaves unbuilt, so the session ends on its own and its outcome is then discarded. A run that has already ended answers 409.',
        tags: ['runs'],
        params: runParamsSchema,
        body: cancelRunRequestSchema,
        response: {
          200: runCommandResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const runId = request.params.run_id;
      const body = request.body;
      return command({
        request,
        action: 'run.cancel',
        key: 'optional',
        subject: { run_id: runId, body },
        params: { run_id: runId },
        taskId: (result) => result.taskId,
        perform: async () => {
          const { userId } = actorOf(request);
          return commands().cancelRun({ runId, userId });
        },
        answer: async ({ performed }) => ({ ...(await runPositionOf(runId)), performed }),
      });
    },
  );
};
