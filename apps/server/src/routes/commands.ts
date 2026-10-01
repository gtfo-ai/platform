/**
 * The fourteen task and run **commands** of technical/08 § "Tasks" and § "Runs" — eleven from
 * WP-15i, three from WP-27.
 *
 *   POST /api/tasks/:task_id/pause | resume | cancel
 *   POST /api/tasks/:task_id/retry-stage | return-to-stage | rework | feedback
 *   POST /api/tasks/:task_id/questions/:question_id/answer
 *   POST /api/tasks/:task_id/approvals/:approval_id/decide
 *   POST /api/tasks/:task_id/take-over | hand-back            (WP-27)
 *   POST /api/runs/:run_id/retry | cancel | steer             (steer: WP-27)
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
 * **Free text is the client's, bounded by the contract and redacted by the command.** All nine
 * fields — a question's answer, an approval's reason, a return's reason, rework instructions,
 * feedback text, a hand-back summary, a steer message and the reasons on `pause` and `take-over` —
 * are untrusted (BD-022): `packages/contracts` caps each at `MAX_COMMAND_TEXT_CHARS` (a steer keeps
 * its own 10 000, which is the precedent the others were bounded against) and the application
 * command applies TD-012 at the one place it *decides* each of them (`pipeline/commands.ts`'s
 * `redactor`). What is recorded here, in `human_actions.params`, is the *shape* of the request —
 * the stage, the decision, the scope, the key — plus the **last two** and nothing else, because
 * those two have no other home: `task.paused` carries the *kind* of pause and `task.taken_over` the
 * branch and the session, so a row that dropped them would make two endpoints' own descriptions
 * false — which is exactly what WP-15i's `/pause` shipped ("`reason` is recorded in the audit row"
 * beside `params: () => ({})`) and what WP-27's `/take-over` then copied. They arrive through
 * `auditResult`, already redacted by the
 * command, so the audit row still cannot become a copy of an **un**redacted sentence — which is the
 * property this paragraph has always been about. The other seven are stored by the command itself
 * and are not repeated here.
 *
 * **One rate limit, and it is the only one in this file — and it is not held here.**
 * technical/08:137 — *"`POST /api/runs/:id/steer` limited to 1 message per 5 s per user"* — is the
 * one endpoint the document gives a number to. What it protects is not the platform but the
 * **run**: each steer is a turn the model pays for, and a stuck key would spend a run's budget on
 * repetition. Until WP-101 it was a `Map` in this process, so N processes serving the API admitted N
 * paid turns per window (PROGRESS backlog 295). Now it is shared state: the application command
 * takes a `pg_advisory_xact_lock` on the user and reads that user's `steer` rows inside the
 * interval, in the transaction that records the steer (`steerRunCommand`), and its refusal reaches
 * the caller as the same `429 rate_limited` through `commandRefusal`. A steer refused for another
 * reason records nothing, so it spends no slot — what WP-73's refund (backlog 263) did by hand.
 *
 * **What the window admits is a record, not a delivery** (WP-85, TD-028 decision 9). The process
 * that serves the API is pinned never to hold a run, so an admitted steer is recorded as a
 * `run_commands` row and applied by the process holding the run; until WP-85 every steer that
 * reached the window was refused `409 run_not_reachable` (PROGRESS backlog 134). **A run cancel
 * rides the same row since WP-101** (TD-028 decision 11): with a live lease it is recorded for the
 * holder and answers `202`, and with none it ends the record in place and answers `200`.
 */

import type { RunStatus, TaskState, UserRole } from '@platform/contracts';
import {
  answerQuestionRequestSchema,
  apiErrorSchema,
  cancelRunRequestSchema,
  cancelRunResponseSchema,
  cancelTaskRequestSchema,
  decideApprovalRequestSchema,
  handBackRequestSchema,
  type JsonObject,
  pauseTaskRequestSchema,
  resumeTaskRequestSchema,
  retryRunRequestSchema,
  retryStageRequestSchema,
  returnToStageRequestSchema,
  reworkRequestSchema,
  runCommandResponseSchema,
  steerRunRequestSchema,
  steerRunResponseSchema,
  submitFeedbackRequestSchema,
  submitFeedbackResponseSchema,
  takeOverRequestSchema,
  takeOverResponseSchema,
  taskCommandResponseSchema,
} from '@platform/contracts';
import { type PermissionAction, resumeCommands } from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import type { TaskCommands } from '../commands.js';
import { commandRefusal, HttpError, NotFoundError } from '../errors.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  readIdempotencyKey,
  requireIdempotencyKey,
} from './idempotency.js';
import { scopedProject, scopeToProject } from './scope.js';

/**
 * Everything these routes read or write outside the application ring, as eight functions.
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
   * The `Idempotency-Key` record, for {@link claimIdempotentAttempt}: claim before the command
   * performs, release when it did not (WP-67).
   *
   * Keyed by the **caller** as well as by the command and the key: a key belongs to whoever issued
   * it, and the argument for that scope is in `./idempotency.ts`.
   */
  readonly claimAttempt: IdempotencyRecords['claimAttempt'];
  readonly releaseAttempt: IdempotencyRecords['releaseAttempt'];
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

  const actorOf = (request: FastifyRequest): { userId: string; name: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`, which refuses an anonymous caller first; kept
      // because the audit row's user id is not optional and a 500 would be the wrong answer.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    // The display **name**, never `actor.email`: it reaches a commit message on the project's own
    // repository and a provenance line in a model's prompt (WP-27, `actorLabel`), and an address is
    // the one field of a session a person did not choose to publish.
    return { userId: actor.userId, name: actor.name };
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
    /**
     * The shape of the request, for the audit row — read off the **body**, so never free text: a
     * sentence this file had not redacted is a sentence it may not write down (module note).
     */
    readonly params: JsonObject;
    /**
     * What the command produced, for the audit row.
     *
     * Two kinds of field, and the second is why free text can be here and not in `params`: what a
     * replay cannot recompute (the take-over's branch, the feedback id), and what the **command**
     * redacted on the way past (a pause's or a take-over's reason). Applied only on a real
     * performance, which is the same thing as saying a replay writes no row.
     */
    readonly auditResult?: (result: T) => JsonObject;
    /**
     * The task the audit row names — `human_actions.task_id`, the table's only index.
     *
     * A **function** for the two run commands, which learn the task from what the command returned:
     * the route has a run id and the row would otherwise be the one kind of `human_actions` row
     * that cannot be found by the index every reader of the table will use.
     */
    readonly taskId?: string | ((result: T) => string);
    /**
     * Given the request's `Idempotency-Key`, which the two commands that record a `run_commands`
     * row derive the row's id from (WP-85, migration 0060). Every other command ignores it.
     */
    readonly perform: (key: string | null) => Promise<T>;
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
    const replay = await claimIdempotentAttempt(options.queries, {
      userId: actor.userId,
      action: input.action,
      key,
      request: input.subject,
    });
    if (replay.replayed) {
      return input.answer({ performed: false, result: null, previous: replay.previous });
    }
    // Under the claim: a refusal from `perform` releases the key, the audit row completes it, and
    // a failure after `perform` returned leaves it held (`./idempotency.ts`, WP-67 round 1).
    const result = await replay.run(async (effectReturned) => {
      const performed = await performing(async () => input.perform(key));
      effectReturned();
      const taskId = typeof input.taskId === 'function' ? input.taskId(performed) : input.taskId;
      await options.queries.recordAction({
        userId: actor.userId,
        action: input.action,
        params: {
          ...input.params,
          ...(input.auditResult === undefined ? {} : input.auditResult(performed)),
          ...(key === null ? {} : { idempotency_key: key }),
          ...(replay.digest === null ? {} : { body_digest: replay.digest }),
        },
        ...(taskId === undefined ? {} : { taskId }),
      });
      return performed;
    });
    return input.answer({ performed: true, result, previous: null });
  };

  /** The branch a replayed take-over recorded, or a refusal: it never answers a placeholder. */
  const recordedBranch = (previous: JsonObject | null): string => {
    const recorded = previous?.branch;
    if (typeof recorded !== 'string') {
      throw new HttpError(
        409,
        'idempotency_key_reused',
        'this Idempotency-Key has already taken a task over, and the attempt that did predates the branch being audited; use a new key',
      );
    }
    return recorded;
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

  /** The command id a replayed steer recorded, or a refusal: it never answers a placeholder. */
  const recordedCommandId = (previous: JsonObject | null): string => {
    const recorded = previous?.command_id;
    if (typeof recorded !== 'string') {
      // A steer performed before WP-85 recorded no command, so there is no id to answer with.
      throw new HttpError(
        409,
        'idempotency_key_reused',
        'this Idempotency-Key has already steered this run, and the attempt that did predates the command being recorded; use a new key',
      );
    }
    return recorded;
  };

  /** One task command: the six things that differ between them, and nothing else. */
  const taskCommand = <TBody extends z.ZodType, TResult = void>(route: {
    readonly path: string;
    readonly action: PermissionAction;
    readonly name: string;
    readonly key: KeyPolicy;
    readonly body: TBody;
    readonly summary: string;
    readonly description: string;
    readonly params: (body: z.output<TBody>) => JsonObject;
    /**
     * What the **command** decided, for the audit row — the sixth, and `pause`'s alone today.
     *
     * The row's other fields are read off the body before anything runs; this one cannot be, because
     * the words a person typed are redacted by the command that owns them (TD-012, and the argument
     * is at `pipeline/commands.ts`'s `auditedReason`). So the value arrives back from `perform`, and
     * a route that has nothing to add simply omits this.
     */
    readonly auditResult?: (result: TResult) => JsonObject;
    readonly perform: (input: {
      readonly deps: TaskCommands;
      readonly body: z.output<TBody>;
      readonly taskId: string;
      readonly userId: string;
    }) => Promise<TResult>;
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
          ...(route.auditResult === undefined ? {} : { auditResult: route.auditResult }),
          taskId,
          perform: async () => {
            const deps = commands();
            const { userId } = actorOf(request);
            return route.perform({ deps, body, taskId, userId });
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
      'The pipeline stops advancing it: a run already in flight is recorded when it ends, and its stage is **not** completed. Stopping the session itself is `POST /api/runs/:run_id/cancel`. A task that is already paused, done or cancelled answers 409 naming the transition. `reason` is recorded in the audit row, redacted (TD-012), and not in the event: `task.paused` carries the *kind* of pause (`manual`).',
    params: () => ({}),
    // The one field of this row the body cannot supply: the command redacts the words before they
    // are written down, and the module note says why that is not this file's job. The parameter is
    // annotated rather than destructured bare because `perform` below takes its parameters from the
    // context — it is context-sensitive and contributes no inference in the first pass, so with
    // nothing to infer from here either, `TResult` falls back to its `void` default and this line
    // stops compiling. One annotation is cheaper than explicit type arguments at all six calls.
    auditResult: (result: { readonly reason: string | null }) =>
      result.reason === null ? {} : { reason: result.reason },
    perform: async ({ deps, body, taskId, userId }) =>
      deps.pause({ taskId, userId, ...(body.reason === undefined ? {} : { reason: body.reason }) }),
  });

  taskCommand({
    path: '/api/tasks/:task_id/resume',
    action: 'task.resume',
    name: 'task.resume',
    key: 'optional',
    body: resumeTaskRequestSchema,
    summary: 'Resume the task at the stage it stopped at',
    description:
      'Re-enters the current stage and enqueues it; no iteration round is spent, because the task stood still rather than going round. A task paused at `ready_for_merge` is not moved by the request: the answer reads `paused`, and the `ready_head_check` duty then compares the branch head with the one the gates judged — the same head re-enters `rebase_gate`, which re-reads the target branch and the Code review’s confirmation of any protected path CI excused before it lets the task wait for the merge again (WP-105), and a different or unreadable head re-enters `ci_gate` (WP-79); neither spends a loop. A template that runs no rebase gate waits for the merge again directly on the same head. A state the task cannot leave for that stage answers 409 naming the transition.',
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
      'The stage must be the one the task is at: sending it somewhere else is `return-to-stage`, which counts a round and records a reason. The attempt counter moves, which supersedes any run still in flight for the old attempt. At `ready_for_merge` (a task paused there) the request moves nothing: the `ready_head_check` duty re-enters `rebase_gate` for the branch head the gates judged (WP-105) and `ci_gate` otherwise (WP-79), spending no loop.',
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
        // `channel` names the door, as a chat answer's row does (WP-88, backlog 199).
        params: { task_id: taskId, question_id: questionId, channel: 'ui' },
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
        // `channel` names the door: a chat decision's row carries the same keys plus its
        // provider, integration and delivery, written in the delivery's transaction (WP-88,
        // `inbound-decisions.ts`), so the audit panel reads one shape whichever door was used.
        params: {
          task_id: taskId,
          approval_id: approvalId,
          decision: body.decision,
          channel: 'ui',
        },
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
    '/api/tasks/:task_id/take-over',
    {
      preValidation: [
        scope,
        requirePermission(guard, 'task.take_over', { project: scopedProject }),
      ],
      schema: {
        summary: 'Take the task over: pause the pipeline and get the work',
        description:
          'product/19 §19. The pipeline pauses, and a run in flight is found in the database and its stop is **accepted, then applied or refused** by the process holding it (TD-028 decision 9, WP-85): the stop is recorded in the same transaction as the pause, the run’s id is recorded on `task.taken_over`, and the run screen reads whether the stop was applied (`GET /api/runs/:run_id/commands`). The response carries what a person needs to carry on: the branch, the resume lines, and whether a workspace export was requested. The workspace’s `wip: hand-over to <user>` commit, its push and its tarball happen as the run winds down — `workspace_export: "requested"` is that tense, not a completed fact. The session `claude --resume` continues is read off the run’s own `system`/`init` transcript entry — the first place the database learns it — so the response carries it once the run has reported one, and `null` (never a guess) before. A task with no run in flight answers `no_live_run` and the branch it already has.',
        tags: ['tasks'],
        params: taskParamsSchema,
        body: takeOverRequestSchema,
        response: {
          200: takeOverResponseSchema,
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
        action: 'task.take_over',
        // A second take-over of a task this one paused is `paused → paused`, which the state machine
        // does not have, so the aggregate refuses the repeat and the header stays optional — the
        // same reading `pause` is given above.
        key: 'optional',
        subject: { task_id: taskId, body },
        params: { task_id: taskId, tarball: body.tarball ?? false },
        // `reason` for the same reason `pause` records one: a take-over's is the operator's account
        // of why they stepped in, `task.taken_over` has no field for it, and this row is where it
        // lives. Redacted by the command (TD-012), like every other piece of free text.
        auditResult: (result) => ({
          branch: result.branch,
          exported: result.exported,
          // The run whose stop was recorded (WP-85): the run screen's command list is where the
          // stop is then read as applied or refused.
          ...(result.runId === null ? {} : { run_id: result.runId }),
          ...(result.reason === null ? {} : { reason: result.reason }),
        }),
        taskId,
        perform: async (idempotencyKey: string | null) => {
          const { userId, name } = actorOf(request);
          return commands().takeOver({
            taskId,
            userId,
            authorName: name,
            tarball: body.tarball ?? false,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
            idempotencyKey,
          });
        },
        answer: async ({ performed, result, previous }) => {
          const position = await positionOf(taskId);
          // A replay answers from the row the first attempt wrote, never from a placeholder: the
          // branch is the audited result of the attempt this request repeats, and the session is not
          // recoverable at all once the run has ended — which is why it is `null` rather than a
          // guess (standing rule 18).
          const branch = result?.branch ?? recordedBranch(previous);
          return {
            ...position,
            performed,
            branch,
            session_id: result?.sessionId ?? null,
            resume_commands: [...resumeCommands(branch, result?.sessionId ?? null)],
            workspace_export:
              result?.exported === true ? ('requested' as const) : ('no_live_run' as const),
          };
        },
      });
    },
  );

  typed.post(
    '/api/tasks/:task_id/hand-back',
    {
      preValidation: [
        scope,
        requirePermission(guard, 'task.hand_back', { project: scopedProject }),
      ],
      schema: {
        summary: 'Hand the task back to the pipeline at a stage you choose',
        description:
          'The other half of product/19 §19: the human has pushed to the branch and picks where the pipeline resumes. Any stage the project’s template runs and has enabled — one it does not answers 409 naming what it does run, because entering a stage the pipeline has no definition for would leave the task active with nothing to run it. Handed back to `ready_for_merge`, the task is not moved by the request: the hand-back is recorded and the `ready_head_check` duty re-enters `rebase_gate` for the branch head the gates judged (WP-105) and `ci_gate` otherwise (WP-79), spending no loop — so Ready is reached only through the rebase gate’s settlement. The summary travels on `task.handed_back` and onto the ticket’s workpad. Nothing is reset and the workspace export is left where it is.',
        tags: ['tasks'],
        params: taskParamsSchema,
        body: handBackRequestSchema,
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
      const body = request.body;
      return command({
        request,
        action: 'task.hand_back',
        // Required: a hand-back **creates** a stage attempt and a run, so a double-clicked button
        // would start two — the reason `retry-stage` requires one.
        key: 'required',
        subject: { task_id: taskId, body },
        params: { task_id: taskId, stage: body.stage },
        taskId,
        perform: async () => {
          const { userId } = actorOf(request);
          await commands().handBack({ taskId, userId, stage: body.stage, summary: body.summary });
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
          'Stops the model’s session **and** ends the run, by one of two branches (TD-028 decision 11, WP-101). **A process holds the run’s lease** (the usual case): the task is paused and the stop is recorded for that process, and the answer is `202` with `command_id` — the run still reads `running`, and the process holding it interrupts the session and ends the run `cancelled` with the cost the session measured; `GET /api/runs/:run_id/commands` says whether the stop was applied. If that process dies before applying it, the run is ended `lease_expired` by the lease sweep and the stop is closed `run_ended`. **No process holds the lease** (absent or expired): nothing is running the session, so the run is ended here — the answer is `200` with `command_id: null`, the row reads `cancelled`, `run.finished` is appended and the task is paused; a session that was in fact still running somewhere has its verdict discarded and its spend recorded when it ends (WP-47, Q70 (b)). A run that has already ended answers 409.',
        tags: ['runs'],
        params: runParamsSchema,
        body: cancelRunRequestSchema,
        response: {
          200: cancelRunResponseSchema,
          202: cancelRunResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const runId = request.params.run_id;
      const body = request.body;
      const answer = await command({
        request,
        action: 'run.cancel',
        key: 'optional',
        subject: { run_id: runId, body },
        params: { run_id: runId },
        // Which branch ran, for a replay's answer: the id of the recorded stop, or `null`.
        auditResult: (result) => ({ command_id: result.commandId }),
        taskId: (result) => result.taskId,
        perform: async (idempotencyKey: string | null) => {
          const { userId } = actorOf(request);
          return commands().cancelRun({ runId, userId, idempotencyKey });
        },
        answer: async ({ performed, result, previous }) => ({
          ...(await runPositionOf(runId)),
          performed,
          command_id:
            result?.commandId ??
            (typeof previous?.command_id === 'string' ? previous.command_id : null),
        }),
      });
      // `202` exactly when a stop was recorded for another process to apply: accepted, not done.
      return reply.code(answer.command_id === null ? 200 : 202).send(answer);
    },
  );

  typed.post(
    '/api/runs/:run_id/steer',
    {
      preValidation: [scopeRun, requirePermission(guard, 'run.steer', { project: scopedProject })],
      schema: {
        summary: 'Send a message to the running agent',
        description:
          'product/18’s steer, **accepted, then applied or refused** (TD-028 decision 9, WP-85). The text is recorded for the process holding the run — on the shipped topology never the process answering — and the answer is `202` with the command’s id: it says the message was accepted, never that the model heard it. The holder then applies it as a **user turn** in the live session and a `steer` entry in the run’s transcript, attributed to whoever sent it, and stamps the command applied; a command still pending when the run ends is refused `run_ended` and never applied late. `GET /api/runs/:run_id/commands` is where the run screen reads which. Only while the run is running — a run that has ended answers 409 naming its status. Limited to one message per five seconds per user (technical/08) — one window shared by every process serving the API, read off the recorded steers (WP-101), refused `429`; the text is untrusted and is redacted once, before it is recorded.',
        tags: ['runs'],
        params: runParamsSchema,
        body: steerRunRequestSchema,
        response: {
          202: steerRunResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          429: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const runId = request.params.run_id;
      const body = request.body;
      const answer = await command({
        request,
        action: 'run.steer',
        // Required, and this is the one command where the reason is about the **model**: a repeat
        // under a used key would be a second user turn in the conversation, which the session
        // cannot take back and which the run pays for. The key is also what the recorded command's
        // id is derived from (WP-85), so a replay answers the same `command_id`.
        key: 'required',
        subject: { run_id: runId, body },
        params: { run_id: runId },
        auditResult: (result) => ({ command_id: result.commandId }),
        taskId: (result) => result.taskId,
        perform: async (idempotencyKey: string | null) => {
          const { userId, name } = actorOf(request);
          // The window is the command's (WP-101): it is read off the user's `steer` rows under a
          // per-user advisory lock, in the transaction that records this one, so a replay — which
          // records nothing and never reaches here — cannot spend it, and a refusal from the window
          // is `429 rate_limited` through `commandRefusal`.
          return commands().steerRun({
            runId,
            userId,
            // The role the guard actually applied — the project membership where there is one,
            // the organisation role otherwise. The aggregate asks `can()` again with it.
            role: request.effectiveRole ?? 'viewer',
            message: body.message,
            authorName: name,
            idempotencyKey,
          });
        },
        answer: async ({ performed, result, previous }) => ({
          ...(await runPositionOf(runId)),
          performed,
          // On a replay, the id the first attempt recorded — read from its audit row.
          command_id: result?.commandId ?? recordedCommandId(previous),
        }),
      });
      return reply.code(202).send(answer);
    },
  );
};
