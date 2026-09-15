/**
 * The epic split's acceptance surface — product/04:117's *"for the PM to accept"* (WP-40, Q85).
 *
 *   GET  /api/tasks/:task_id/breakdown         the proposed children, in the order they were made
 *   POST /api/tasks/:task_id/breakdown/decide  accept or reject some of them
 *
 * ## Why a queue and not an approval
 *
 * Q85's recommendation, and the reasoning is the whole design: a breakdown is **N independent
 * decisions** and an `approvals` row is one, so a PM who wants five of seven children has to be able
 * to say so. `approval_kind` is therefore untouched and the storage is `ticket_breakdown_items`
 * (migration 0033), whose shape is `kb_proposals`' — a status per row, who decided and when, and a
 * rejection that **leaves the row** with its reason, because the platform learns from rejections
 * (product/10:52).
 *
 * ## The command shape is WP-15i's, copied deliberately rather than shared
 *
 * `routes/asks.ts` made the same call and for the same reason: the six steps of
 * `routes/commands.ts`' `command` helper are reproduced here because this surface answers a
 * **different response schema** — a task command answers where the aggregate now stands, and this
 * answers what the decision moved. What is *not* copied is the policy: the same `Idempotency-Key`
 * mechanism (`routes/idempotency.ts`), the same `preValidation` guard order, the same *"a refused
 * command writes no `human_actions` row"* rule, and the same 401/403/409 vocabulary.
 *
 * **The key is required**, because a repeat under a used key would file a second set of tickets in
 * somebody else's backlog. The countable effect is the rows: N accepted children become N
 * `createTicket` calls, and a replay performs none of them a second time — the route answers from
 * the recorded attempt and the command is never called.
 *
 * ## Who may accept
 *
 * `task.approve_plan` — **maintainer**, which is Q85's recommendation verbatim: *"the capability to
 * accept is the one that decides a plan approval … there is no PM role in the RBAC map and
 * inventing one for this is a second vocabulary"*. Reading the queue is `task.read` (viewer),
 * because that reads only what the caller can already see on the task page.
 *
 * ## The census cannot see these routes
 *
 * `apps/server/src/routes/client-census.test.ts` compares the **client's** paths against the router
 * and no screen calls either of these yet, so they are asserted there by hand — the position
 * `GET …/kb/health`, `take-over` and `hand-back` are already in.
 */
import type { JsonObject, TicketBreakdownItem, UserRole } from '@platform/contracts';
import {
  apiErrorSchema,
  decideBreakdownRequestSchema,
  decideBreakdownResponseSchema,
  taskBreakdownSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { commandRefusal, HttpError, NotFoundError } from '../errors.js';
import { idempotentReplay, requireIdempotencyKey } from './idempotency.js';
import { scopedProject, scopeToProject } from './scope.js';

/** What this surface reads or writes outside the application ring, as five functions. */
export interface BreakdownQueries {
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
  readonly listBreakdown: (taskId: string) => Promise<readonly TicketBreakdownItem[]>;
}

export interface BreakdownCommandPort {
  decide(input: {
    readonly taskId: string;
    readonly itemIds: readonly string[];
    readonly decision: 'accept' | 'reject';
    readonly userId: string;
    readonly reason: string | null;
  }): Promise<{
    readonly accepted: number;
    readonly rejected: number;
    readonly remaining: number;
  }>;
}

export interface BreakdownRoutesOptions {
  readonly queries: BreakdownQueries;
  /** `null` on a process with no database-backed pipeline store; the write answers 503 by name. */
  readonly breakdown: BreakdownCommandPort | null;
}

const taskParamsSchema = z.strictObject({ task_id: z.uuid() });

export const registerBreakdownRoutes = async (
  app: FastifyInstance,
  options: BreakdownRoutesOptions,
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

  typed.get(
    '/api/tasks/:task_id/breakdown',
    {
      preHandler: [scopeForRead, requirePermission(guard, 'task.read', { project: scopedProject })],
      schema: {
        summary: 'The ticket breakdown this epic-split task proposed, in order',
        description:
          'product/04:117’s *"a proposed ticket breakdown with acceptance criteria for the PM to accept"*. Every string here is untrusted (BD-022) — title, description, rationale and every acceptance criterion are model output over an untrusted epic, and `reason` is a human’s own words — so render each as text, never as markup. All of them are stored **redacted** (TD-012 at the write), so a placeholder is what a reader sees where a credential was. `ticket_key` and `ticket_url` are what the platform filed for an accepted child, and stay `null` until the `createTicket` call has happened, which is the honest difference between *accepted* and *created*. A task on any other template answers an empty list rather than 404: it simply proposed no breakdown.',
        tags: ['tasks'],
        params: taskParamsSchema,
        response: { 200: taskBreakdownSchema, 404: apiErrorSchema },
      },
    },
    async (request) => {
      await projectOf(request.params.task_id);
      return { items: [...(await options.queries.listBreakdown(request.params.task_id))] };
    },
  );

  typed.post(
    '/api/tasks/:task_id/breakdown/decide',
    {
      preValidation: [
        scope,
        requirePermission(guard, 'task.approve_plan', { project: scopedProject }),
      ],
      schema: {
        summary: 'Accept or reject some of the proposed child tickets',
        description:
          '**Accepting files real tickets** in the project’s tracker — one per accepted child, through `IntegrationActionExecutor` from a `pipeline.outbound` duty keyed on the child’s own row, so a replay files each one once and a shadow task files none. Rejecting writes nothing to any provider and leaves the row with its reason. `Idempotency-Key` is **required**: a repeat would create a second set of tickets in somebody else’s backlog. A decision may name a subset — five of seven children is one call, and the other two stay queued.',
        tags: ['tasks'],
        params: taskParamsSchema,
        body: decideBreakdownRequestSchema,
        response: {
          200: decideBreakdownResponseSchema,
          400: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const { task_id: taskId } = request.params;
      const actor = actorOf(request);
      // Before the replay, not after it: a key belongs to whoever issued it (`./idempotency.ts`).
      const key = requireIdempotencyKey(request);
      const replay = await idempotentReplay(options.queries.previousAttempt, {
        userId: actor.userId,
        action: 'task.breakdown.decide',
        key,
        request: { task_id: taskId, ...request.body },
      });
      if (replay.replayed) {
        const previous = replay.previous ?? {};
        const counted = (field: string): number =>
          typeof previous[field] === 'number' ? (previous[field] as number) : 0;
        return {
          task_id: taskId,
          performed: false,
          accepted: counted('accepted'),
          rejected: counted('rejected'),
          remaining: counted('remaining'),
        };
      }
      if (options.breakdown === null) {
        throw new HttpError(
          503,
          'commands_unavailable',
          'this process cannot decide a ticket breakdown: it serves reads only. Ask an instance that runs the workers',
        );
      }
      await projectOf(taskId);
      // A **refusal** is translated here rather than globally, exactly as `routes/commands.ts`
      // translates the aggregate's: `BreakdownRefusedError` means "not to this, not now" to a
      // caller who chose the decision, and means "this build has a bug" on a route that reads —
      // which is why `toApiError` leaves it as `500 internal_error` everywhere else.
      const result = await (async () => {
        try {
          return await (options.breakdown as BreakdownCommandPort).decide({
            taskId,
            itemIds: request.body.item_ids,
            decision: request.body.decision,
            userId: actor.userId,
            reason: request.body.reason ?? null,
          });
        } catch (error) {
          const refusal = commandRefusal(error);
          if (refusal === null) {
            throw error;
          }
          throw refusal;
        }
      })();
      await options.queries.recordAction({
        userId: actor.userId,
        action: 'task.breakdown.decide',
        // The **shape** of the request plus the counts the command produced, never the words. The
        // reason is untrusted free text and it is stored — redacted — on the rows the decision
        // moved, which is the one copy worth keeping; a second copy in `human_actions` would be a
        // second thing to redact and a second thing to get wrong (`routes/commands.ts`' module
        // note). `reason_chars` is what an auditor needs from it here.
        params: {
          decision: request.body.decision,
          items: request.body.item_ids.length,
          reason_chars: (request.body.reason ?? '').length,
          accepted: result.accepted,
          rejected: result.rejected,
          remaining: result.remaining,
          idempotency_key: key,
          ...(replay.digest === null ? {} : { body_digest: replay.digest }),
        },
        taskId,
      });
      return { task_id: taskId, performed: true, ...result };
    },
  );
};

/** The wire shape of one queued child; the projection and the route agree on this one function. */
export const toWireBreakdownItem = (item: {
  readonly id: string;
  readonly taskId: string;
  readonly position: number;
  readonly title: string;
  readonly description: string;
  readonly acceptanceCriteria: TicketBreakdownItem['acceptance_criteria'];
  readonly size: TicketBreakdownItem['size'];
  readonly rationale: string;
  readonly status: TicketBreakdownItem['status'];
  readonly decidedByUserId: string | null;
  readonly decidedAt: string | null;
  readonly reason: string | null;
  readonly ticketKey: string | null;
  readonly ticketUrl: string | null;
  readonly createdAt: string;
}): TicketBreakdownItem => ({
  id: item.id as TicketBreakdownItem['id'],
  task_id: item.taskId as TicketBreakdownItem['task_id'],
  position: item.position,
  title: item.title,
  description: item.description,
  acceptance_criteria: [...item.acceptanceCriteria],
  size: item.size,
  rationale: item.rationale,
  status: item.status,
  decided_by_user_id: item.decidedByUserId as TicketBreakdownItem['decided_by_user_id'],
  decided_at: item.decidedAt as TicketBreakdownItem['decided_at'],
  reason: item.reason,
  ticket_key: item.ticketKey,
  ticket_url: item.ticketUrl as TicketBreakdownItem['ticket_url'],
  created_at: item.createdAt as TicketBreakdownItem['created_at'],
});
