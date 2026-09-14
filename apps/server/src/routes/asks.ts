/**
 * Ask-the-task's HTTP surface — technical/08:17's `POST /api/tasks/:id/ask`, plus the two reads it
 * cannot be useful without (WP-31).
 *
 *   POST /api/tasks/:task_id/ask     ask a question about this task
 *   GET  /api/tasks/:task_id/asks    the Q&A thread (product/10:57)
 *   GET  /api/tasks/:task_id/audit   this task's `human_actions` rows (criterion 10, backlog 52)
 *
 * ## Why this is a file of its own rather than a case in `routes/commands.ts`
 *
 * The command shape is the same and is deliberately copied rather than shared: the six steps of
 * `routes/commands.ts`'s `command` helper — read the actor, refuse a replay, perform, record the
 * human action, answer — are reproduced here because the two surfaces answer **different response
 * schemas**. A task command answers `taskCommandResponseSchema` (the aggregate's new position) and
 * an ask answers where the *ask* stands; threading a second response type through that helper would
 * have made the helper the thing under review instead of the route.
 *
 * What is *not* copied is the policy, and that matters more: the same `Idempotency-Key` mechanism
 * (`routes/idempotency.ts`), the same `preValidation` guard order, the same "a refused command
 * writes no `human_actions` row" rule, and the same 401/403/409 vocabulary.
 *
 * ## The census cannot see these routes, so they are named positively here
 *
 * `apps/server/src/routes/client-census.test.ts` compares the **client's** paths against the
 * router, and until the SPA's ask thread existed it was blind to this endpoint by construction —
 * which is exactly what WP-31's plan row says. `apps/server/src/routes/asks.test.ts` names all
 * three positively and asserts the auth, the replay and the refusals per route.
 *
 * ## Who may do what
 *
 * `task.ask` is **member** in the shipped capability map (`packages/domain/src/permissions.ts`,
 * Q36), and that is the answer this row takes rather than Q72's *"anyone with `project.read`"*.
 * The deviation is deliberate and stated in `PROGRESS.md`: Q72's reasoning is that *"an ask mutates
 * nothing and reads only what the asker can already read"*, and the first half is false — an ask
 * starts a run and spends the project's money. Reading the thread is `task.read` (viewer), because
 * that really does read only what the caller can already see.
 */
import type {
  AskAnswerCitation,
  IsoDateTime,
  JsonObject,
  TaskAsk,
  UserRole,
} from '@platform/contracts';
import {
  apiErrorSchema,
  askTaskRequestSchema,
  askTaskResponseSchema,
  taskAskListSchema,
  taskAuditPageSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import { idempotentReplay, requireIdempotencyKey } from './idempotency.js';
import { scopedProject, scopeToProject } from './scope.js';

/** How many thread entries and audit rows one page carries. A page, not an export. */
export const ASK_PAGE_LIMIT = 50;
export const TASK_AUDIT_PAGE_LIMIT = 100;

/** What the ask surface reads and writes outside the application ring, as six functions. */
export interface AskQueries {
  readonly taskProjectId: (taskId: string) => Promise<string | null>;
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
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
  readonly listAsks: (taskId: string, limit: number) => Promise<readonly TaskAsk[]>;
  readonly taskAudit: (
    taskId: string,
    limit: number,
  ) => Promise<
    readonly {
      readonly id: string;
      readonly action: string;
      readonly user_id: string | null;
      readonly params: JsonObject;
      readonly created_at: IsoDateTime;
    }[]
  >;
}

export interface AskCommandPort {
  /** Records the question and enqueues the run. Answers `duplicate` for a replayed ticket comment. */
  ask(input: {
    readonly taskId: string;
    readonly projectId: string;
    readonly userId: string;
    readonly question: string;
  }): Promise<
    { readonly status: 'recorded'; readonly askId: string } | { readonly status: 'duplicate' }
  >;
}

export interface AskRoutesOptions {
  readonly queries: AskQueries;
  /** `null` on a process that composed no pipeline: the path exists and this one cannot serve it. */
  readonly asks: AskCommandPort | null;
}

const taskParamsSchema = z.strictObject({ task_id: z.uuid() });

export const registerAskRoutes = async (
  app: FastifyInstance,
  options: AskRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };
  const scope = scopeToProject({
    param: 'task_id',
    what: 'task',
    projectOf: options.queries.taskProjectId,
    lenient: true,
  });
  const scopeForRead = scopeToProject({
    param: 'task_id',
    what: 'task',
    projectOf: options.queries.taskProjectId,
  });

  const actorOf = (request: FastifyRequest): { userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`, which refuses an anonymous caller first.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };

  const projectOf = async (taskId: string): Promise<string> => {
    const projectId = await options.queries.taskProjectId(taskId);
    if (projectId === null) {
      throw new NotFoundError(`task ${taskId}`);
    }
    return projectId;
  };

  typed.post(
    '/api/tasks/:task_id/ask',
    {
      preValidation: [scope, requirePermission(guard, 'task.ask', { project: scopedProject })],
      schema: {
        summary: 'Ask this task a question, answered from its own audit trail',
        description:
          'product/10:57. The question is **untrusted** (BD-022): it is stored redacted and bounded, and it reaches the model only inside a nonce-bearing data block. The answer is produced by a run with this task and **no stage** — the same admission guard, cost ledger, transcript sink and budget cap every other run gets — so this endpoint returns as soon as the question is recorded and the thread (`GET …/asks`) reports the answer. `Idempotency-Key` is **required**: a repeat would start a second paid run.',
        tags: ['tasks'],
        params: taskParamsSchema,
        body: askTaskRequestSchema,
        response: {
          200: askTaskResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      if (options.asks === null) {
        throw new HttpError(
          503,
          'commands_unavailable',
          'this process composed no pipeline, so it cannot answer a question about a task: it serves reads only. Ask an instance that runs the workers',
        );
      }
      const { task_id: taskId } = request.params;
      const actor = actorOf(request);
      // Before the replay, not after it: a key belongs to whoever issued it (`./idempotency.ts`).
      const key = requireIdempotencyKey(request);
      const replay = await idempotentReplay(options.queries.previousAttempt, {
        userId: actor.userId,
        action: 'task.ask',
        key,
        request: { task_id: taskId, ...request.body },
      });
      if (replay.replayed) {
        const askId = replay.previous?.ask_id;
        if (typeof askId !== 'string') {
          // A row written by a build before this field existed. Refusing is the honest answer: the
          // question was asked and this process cannot say which ask it became (WP-27's rule).
          throw new HttpError(
            409,
            'idempotency_key_reused',
            'this Idempotency-Key has already asked a question, and the attempt that did predates the ask id being audited; use a new key',
          );
        }
        return { ask_id: askId, task_id: taskId, performed: false, status: 'pending' as const };
      }
      const projectId = await projectOf(taskId);
      const result = await options.asks.ask({
        taskId,
        projectId,
        userId: actor.userId,
        question: request.body.question,
      });
      if (result.status === 'duplicate') {
        // Only a ticket-sourced ask can collide, and this door never creates one — so this is a
        // defect rather than a state, and it is named rather than reported as success.
        throw new HttpError(
          409,
          'ask_already_recorded',
          'an ask with this identity already exists on this task',
        );
      }
      await options.queries.recordAction({
        userId: actor.userId,
        action: 'task.ask',
        // The **shape** of the request, never the words: the question is free text and this route
        // has no redactor — the command redacts it on its way to the row (`routes/commands.ts`'s
        // module note states the same rule for the other nine free-text fields).
        params: {
          ask_id: result.askId,
          question_chars: request.body.question.length,
          idempotency_key: key,
          ...(replay.digest === null ? {} : { body_digest: replay.digest }),
        },
        taskId,
      });
      return { ask_id: result.askId, task_id: taskId, performed: true, status: 'pending' as const };
    },
  );

  typed.get(
    '/api/tasks/:task_id/asks',
    {
      preHandler: [scopeForRead, requirePermission(guard, 'task.read', { project: scopedProject })],
      schema: {
        summary: 'The ask-the-task thread for one task, newest first',
        description:
          'Every question and every answer is untrusted content (BD-022): render them as text, never as markup, and build a citation’s link yourself — `citations` names rows (`run_id`, `artifact_type`/`version`) and deliberately carries no URL. `dropped_citations` counts the claims whose evidence named another task or project and was refused (product/11:30).',
        tags: ['tasks'],
        params: taskParamsSchema,
        response: { 200: taskAskListSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      await projectOf(request.params.task_id);
      return {
        items: [...(await options.queries.listAsks(request.params.task_id, ASK_PAGE_LIMIT))],
      };
    },
  );

  typed.get(
    '/api/tasks/:task_id/audit',
    {
      // `org.audit.read` is **maintainer** — the same capability WP-30's project audit uses, because
      // it is the same table and the same question. Scoped to the task's project, so a maintainer of
      // one project cannot read another's.
      preHandler: [
        scopeForRead,
        requirePermission(guard, 'org.audit.read', { project: scopedProject }),
      ],
      schema: {
        summary: 'Every human action recorded on this task, newest first',
        description:
          "PROGRESS backlog 52's remaining half. `GET /api/projects/:id/audit` serves the rows whose `params.project_id` names the project — the wizard's and the settings screens' writes — and a task command's row names a **task** instead, because `human_actions` has no `project_id` column. `params` is client-supplied JSON carrying the caller's own `Idempotency-Key`: untrusted (BD-022).",
        tags: ['tasks'],
        params: taskParamsSchema,
        response: { 200: taskAuditPageSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      await projectOf(request.params.task_id);
      return {
        items: [
          ...(await options.queries.taskAudit(request.params.task_id, TASK_AUDIT_PAGE_LIMIT)),
        ],
      };
    },
  );
};

/** The wire shape of one thread entry; the projection and the route agree on this one function. */
export const toWireAsk = (ask: {
  readonly id: string;
  readonly taskId: string;
  readonly source: 'ui' | 'ticket';
  readonly askedByUserId: string;
  readonly question: string;
  readonly runId: string | null;
  readonly status: 'pending' | 'answered' | 'refused' | 'failed';
  readonly answer: string | null;
  readonly citations: readonly AskAnswerCitation[];
  readonly droppedCitations: number;
  readonly answerArtifactId: string | null;
  readonly refusalReason: string | null;
  readonly mirroredAt: string | null;
  readonly createdAt: string;
  readonly answeredAt: string | null;
}): TaskAsk => ({
  id: ask.id,
  task_id: ask.taskId,
  source: ask.source,
  asked_by_user_id: ask.askedByUserId,
  question: ask.question,
  run_id: ask.runId,
  status: ask.status,
  answer: ask.answer,
  citations: [...ask.citations],
  dropped_citations: ask.droppedCitations,
  answer_artifact_id: ask.answerArtifactId,
  refusal_reason: ask.refusalReason,
  mirrored_at: ask.mirroredAt as IsoDateTime | null,
  created_at: ask.createdAt as IsoDateTime,
  answered_at: ask.answeredAt as IsoDateTime | null,
});
