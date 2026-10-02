/**
 * `POST /api/projects/:project_id/tasks` — product/04 S0's manual "Start" from a ticket key
 * (WP-122, PROGRESS backlog 379; technical/08 § "Tasks").
 *
 * The ruling, as built:
 *
 * - **`task.create`**, which the capability map gives `member` — the same guard position as every
 *   command (`preValidation`, so an anonymous caller learns nothing of the body's shape).
 * - **`Idempotency-Key` required**, through `./idempotency.ts`'s claim-before-effect: the key is
 *   claimed before the ticket is read, so a replay reads nothing and records nothing, a concurrent
 *   repeat is `409 idempotency_key_in_flight`, and a refusal gives the key back. The audit row that
 *   completes the claim is written **in the match's own transaction** (`task-start.ts`).
 * - The ticket is read **outside any transaction** through the project's task-management binding
 *   and `IntegrationActionExecutor`; then one transaction appends the `ticket.matched` intake
 *   consumes, with `rule: 'manual'`, and the `human_actions` row. The answer is `202`: the task is
 *   intake's to create, under the WIP limits, the dial, the protected-branch check and one task
 *   per ticket, exactly as for a rule match.
 *
 * Every refusal is typed and recorded nothing — `manual-start.ts` lists them; the status for each is
 * chosen here, because this file is where a status meets its caller.
 *
 * **The audit row's `task_id` is null, and that is a residual, not an oversight.** The row commits
 * with the `ticket.matched` it records, and no task exists then: intake creates it later, in its own
 * `intake_check` job and transaction (and may not create one at all — a WIP-queued task is still
 * created, an unprotected default branch escalates one, a race with a webhook makes it the other
 * door's). So the task page's *Who did what* (`GET /api/tasks/:id/audit`, keyed by `task_id`) does
 * not list the start; the match's `actor` names the person, and the task's export carries that
 * event. The row's `params` name the project, the event and the ticket.
 */

import { MANUAL_START_ACTION, ManualStartRefusedError } from '@platform/application';
import type { Id, JsonObject } from '@platform/contracts';
import {
  apiErrorSchema,
  createTaskRequestSchema,
  startTaskResponseSchema,
  ticketRefSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError, projectStreamContention } from '../errors.js';
import type { TaskStartCommands } from '../task-start.js';
import {
  claimIdempotentAttempt,
  type IdempotencyRecords,
  requireIdempotencyKey,
} from './idempotency.js';

export interface TaskStartQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<string | null>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
  readonly claimAttempt: IdempotencyRecords['claimAttempt'];
  readonly releaseAttempt: IdempotencyRecords['releaseAttempt'];
}

export interface TaskStartRoutesOptions {
  readonly queries: TaskStartQueries;
  /**
   * The command, or `null` on a process that composed no integration stack. `503` by name rather
   * than `404`: the path exists and this process cannot serve it.
   */
  readonly commands: TaskStartCommands | null;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

/** Each refusal of `startTicketManually`, as the status and code it is to the caller. */
export const MANUAL_START_REFUSALS: Readonly<
  Record<ManualStartRefusedError['reason'], { readonly status: number; readonly code: string }>
> = {
  no_task_management: { status: 409, code: 'no_task_management_binding' },
  not_picked_up: { status: 409, code: 'project_does_not_pick_up_tickets' },
  task_exists: { status: 409, code: 'ticket_has_task' },
  ticket_not_found: { status: 404, code: 'ticket_not_found' },
  // A binding's declared scope (Jira's `project_keys`) is not the pick-up rule: not bypassed.
  outside_binding_scope: { status: 409, code: 'ticket_outside_binding_scope' },
  // The tracker failed: the request was fine and the platform could not complete it upstream.
  ticket_unreadable: { status: 502, code: 'ticket_unreadable' },
};

/**
 * The answer to a replayed key, from what the performing attempt's audit row recorded. A row that
 * cannot answer is refused rather than invented — the shadow batch's rule.
 */
const replayedStart = (previous: JsonObject | null) => {
  const eventId = previous?.event_id;
  const ticket = ticketRefSchema.safeParse(previous?.ticket);
  if (typeof eventId !== 'string' || !ticket.success) {
    throw new HttpError(
      409,
      'idempotency_key_reused',
      'this Idempotency-Key has already started a ticket, and what it started can no longer be read back; use a new key',
    );
  }
  return { performed: false, event_id: eventId, ticket: ticket.data };
};

export const registerTaskStartRoutes = async (
  app: FastifyInstance,
  options: TaskStartRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      (await options.queries.projectRole(projectId, userId)) as never,
  };
  // The guard runs before validation, so it copes with a segment the schema has not checked yet
  // (`routes/onboarding.ts` carries the argument).
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };

  const commands = (): TaskStartCommands => {
    if (options.commands === null) {
      throw new HttpError(
        503,
        'task_start_unavailable',
        'this process composed no integrations, so it cannot read a ticket to start; ask an instance that serves the API with its integrations',
      );
    }
    return options.commands;
  };

  typed.post(
    '/api/projects/:project_id/tasks',
    {
      preValidation: requirePermission(guard, 'task.create', { project: projectOf }),
      schema: {
        summary: 'Start a ticket by hand, from its key',
        description:
          "product/04's manual Start. Reads the ticket through the project's task-management binding (audited and rate-limited like every provider call) and records the same `ticket.matched` a rule match records, with `rule: \"manual\"` — the **pick-up rule is bypassed and nothing else**: intake then creates the task under the WIP limits (above them it is `queued`), the protected-branch check, the issue type's template and one task per ticket. `202` names the recorded match, not a task. `Idempotency-Key` is required; a replay answers `performed: false` and reads nothing. Refusals record nothing: `409 no_task_management_binding`, `409 project_does_not_pick_up_tickets` (the autonomy dial is Observe), `409 ticket_has_task`, `409 ticket_outside_binding_scope` (the ticket is outside the projects the binding declares it reads — Jira's `project_keys` — naming that list), `404 ticket_not_found`, `502 ticket_unreadable` (the tracker failed; try again). The `human_actions` row `task.start` has `task_id` null: no task exists when it commits, so the task's audit read does not list it. The key is letters, digits, `.`, `_` and `-`, at most 64. `task.create` (member).",
        tags: ['tasks'],
        params: projectParamsSchema,
        body: createTaskRequestSchema,
        response: {
          202: startTaskResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          502: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request, reply) => {
      const key = requireIdempotencyKey(request);
      const projectId = request.params.project_id;
      const actor = request.actor;
      if (actor === undefined) {
        throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
      }
      const ticketKey = request.body.ticket_key;
      const claim = await claimIdempotentAttempt(options.queries, {
        userId: actor.userId,
        action: MANUAL_START_ACTION,
        key,
        request: { project_id: projectId, ticket_key: ticketKey },
      });
      if (claim.replayed) {
        const replayed = replayedStart(claim.previous);
        reply.code(202);
        return replayed;
      }
      return claim.run(async (effectReturned) => {
        if (!(await options.queries.projectExists(projectId))) {
          throw new NotFoundError(`project ${projectId}`);
        }
        let started: Awaited<ReturnType<TaskStartCommands['start']>>;
        try {
          started = await commands().start({
            projectId: projectId as Id,
            ticketKey,
            userId: actor.userId as Id,
            audit: { key, digest: claim.digest },
          });
        } catch (error) {
          if (error instanceof ManualStartRefusedError) {
            const answer = MANUAL_START_REFUSALS[error.reason];
            throw new HttpError(answer.status, answer.code, error.message);
          }
          throw projectStreamContention(error) ?? error;
        }
        // The match and its audit row committed together: nothing after this gives the key back.
        effectReturned();
        reply.code(202);
        return { performed: true, event_id: started.eventId, ticket: started.ticket };
      });
    },
  );
};
