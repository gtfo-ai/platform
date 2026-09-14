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
 * **One rate limit, and it is the only one in this file.** technical/08:137 —
 * *"`POST /api/runs/:id/steer` limited to 1 message per 5 s per user"* — is the one endpoint the
 * document gives a number to, and {@link steerGate} is that number. It is **per process**: a
 * deployment running N API containers allows N messages per window, which is stated here rather
 * than discovered, and is the same trade every in-memory limiter in this repository makes. What it
 * protects is not the platform but the **run**: each steer is a turn the model pays for, and a
 * stuck key would spend a run's budget on repetition.
 */

import type { RunStatus, TaskState, UserRole } from '@platform/contracts';
import {
  answerQuestionRequestSchema,
  apiErrorSchema,
  cancelRunRequestSchema,
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
  /** The steer window; the default is technical/08:137's. Injected so a test can drive its clock. */
  readonly steerGate?: SteerGate;
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

/** technical/08:137 — *"1 message per 5 s per user"*, verbatim. */
export const STEER_MIN_INTERVAL_MS = 5_000;

/**
 * A bound on how many users this process remembers a steer for.
 *
 * Not a policy: an entry is one timestamp per user who has steered, and it is dropped as soon as
 * its window has passed. The cap is here so that a pathological caller cannot grow the map without
 * limit, and eviction is oldest-first — which lets the evicted user steer once more immediately,
 * the fail-**open** direction. That is deliberate for a rate limit and would not be for a
 * permission: over-refusing a person's message loses the thing the feature exists for, and the
 * spend it protects is bounded by the run's own budget either way (BD-010).
 */
export const STEER_GATE_MAX_USERS = 4_096;

export interface SteerGate {
  /** `true` when this caller may steer now; records the attempt when it answers `true`. */
  allow(userId: string): boolean;
}

/**
 * The per-user steer window, in memory (see the module note for what "per process" costs).
 *
 * `now` is injected for the reason every other duration in this repository is: a test that waited
 * five real seconds to prove a five-second window would be asserting something about the machine.
 */
export const createSteerGate = (
  now: () => number = () => Date.now(),
  intervalMs: number = STEER_MIN_INTERVAL_MS,
  maxUsers: number = STEER_GATE_MAX_USERS,
): SteerGate => {
  const last = new Map<string, number>();
  return {
    allow: (userId) => {
      const at = now();
      const previous = last.get(userId);
      if (previous !== undefined && at - previous < intervalMs) {
        return false;
      }
      if (last.size >= maxUsers && previous === undefined) {
        const oldest = last.keys().next();
        if (!oldest.done) {
          last.delete(oldest.value);
        }
      }
      // Delete first so the insertion order is the recency order the eviction above reads.
      last.delete(userId);
      last.set(userId, at);
      return true;
    },
  };
};

export const registerCommandRoutes = async (
  app: FastifyInstance,
  options: CommandRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };
  const steerGate = options.steerGate ?? createSteerGate();

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
    '/api/tasks/:task_id/take-over',
    {
      preValidation: [
        scope,
        requirePermission(guard, 'task.take_over', { project: scopedProject }),
      ],
      schema: {
        summary: 'Take the task over: pause the pipeline and get the work',
        description:
          'product/19 §19. The pipeline pauses, a run in flight is interrupted gracefully, and the response carries what a person needs to carry on: the branch, the `claude --resume` command when the interrupted run had a session, and whether its workspace was asked to export. The workspace’s `wip: hand-over to <user>` commit, its push and its tarball happen as the run winds down — `workspace_export: "requested"` is that tense, not a completed fact. A task with no run in flight answers `no_live_run` and the branch it already has.',
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
          ...(result.reason === null ? {} : { reason: result.reason }),
        }),
        taskId,
        perform: async () => {
          const { userId, name } = actorOf(request);
          return commands().takeOver({
            taskId,
            userId,
            authorName: name,
            tarball: body.tarball ?? false,
            ...(body.reason === undefined ? {} : { reason: body.reason }),
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
          'The other half of product/19 §19: the human has pushed to the branch and picks where the pipeline resumes. Any stage the project’s template runs and has enabled — one it does not answers 409 naming what it does run, because entering a stage the pipeline has no definition for would leave the task active with nothing to run it. The summary travels on `task.handed_back` and onto the ticket’s workpad. Nothing is reset and the workspace export is left where it is.',
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

  typed.post(
    '/api/runs/:run_id/steer',
    {
      preValidation: [scopeRun, requirePermission(guard, 'run.steer', { project: scopedProject })],
      schema: {
        summary: 'Send a message to the running agent',
        description:
          'product/18’s steer: the text becomes a **user turn** in the live session and a `steer` entry in the run’s transcript, attributed to whoever sent it. Only while the run is running — a run that has ended answers 409 naming its status, and a run this process is not executing answers 409 saying so rather than accepting a message nobody will hear. Limited to one message per five seconds per user (technical/08); the text is untrusted and is redacted once, before it reaches the session, the transcript and the event.',
        tags: ['runs'],
        params: runParamsSchema,
        body: steerRunRequestSchema,
        response: {
          200: runCommandResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          429: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const runId = request.params.run_id;
      const body = request.body;
      return command({
        request,
        action: 'run.steer',
        // Required, and this is the one command where the reason is about the **model**: a repeat
        // under a used key would be a second user turn in the conversation, which the session
        // cannot take back and which the run pays for.
        key: 'required',
        subject: { run_id: runId, body },
        params: { run_id: runId },
        taskId: (result) => result.taskId,
        perform: async () => {
          const { userId, name } = actorOf(request);
          // After the replay check and before the command: a replayed request delivered nothing, so
          // charging it against the window would refuse the *next* real steer. The gate is the
          // last thing between the caller and the session.
          if (!steerGate.allow(userId)) {
            throw new HttpError(
              429,
              'rate_limited',
              `steering is limited to one message every ${STEER_MIN_INTERVAL_MS / 1_000} seconds per person (technical/08); the run is still listening, try again in a moment`,
            );
          }
          return commands().steerRun({
            runId,
            userId,
            // The role the guard actually applied — the project membership where there is one, the
            // organisation role otherwise. The aggregate asks `can()` again with it.
            role: request.effectiveRole ?? 'viewer',
            message: body.message,
            authorName: name,
          });
        },
        answer: async ({ performed }) => ({ ...(await runPositionOf(runId)), performed }),
      });
    },
  );
};
