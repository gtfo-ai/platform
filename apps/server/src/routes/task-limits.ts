/**
 * **A person's limit on their tasks in flight** (S-28.6, the M28 ruling B on BD-010):
 *
 *   GET /api/me/task-limit                 your limit, what counts toward it and what holds it
 *   PUT /api/me/task-limit                 set your own — `{ max_tasks_in_flight }`, `null` the default
 *   GET /api/org/task-limits               every person's — an administrator's read
 *   PUT /api/org/users/:id/task-limit      set a person's — an administrator's write
 *
 * Session-authenticated; the two writes are behind the CSRF hook (`auth/plugin.ts`). Your own is
 * `worker.register` (any signed-in active user — the person whose machines take the work); anyone
 * else's is `org.users.manage` (an administrator). Each `PUT` is a **state assertion**, as the
 * claim policy's is: a repeat of the stored value answers `performed: false` and writes nothing,
 * so a retried request is idempotent without a key. A number above the organisation's
 * `pipeline.wip.max_tasks_per_owner` is `422 task_limit_above_maximum`, naming the maximum, and
 * nothing is written. One `human_actions` row `user.task_limit` per change.
 *
 * **A raise starts the queue**: when the person's limit in force rose, the route appends one
 * `config.changed` per project where they have a queued task, once the write has committed — the
 * event the scheduler hears (`pipeline/wip-raised.ts`), so a waiting task of theirs starts without
 * another event. A failed append does not fail the write (`wip-raise.ts` says why).
 */
import type { WipRaisedRecorder } from '@platform/application';
import {
  apiErrorSchema,
  myTaskLimitResponseSchema,
  orgTaskLimitsResponseSchema,
  TASK_LIMIT_HOLDERS_MAX,
  taskLimitRequestSchema,
  taskLimitResponseSchema,
  taskLimitUserParamsSchema,
} from '@platform/contracts';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type * as z from 'zod';
import { type PermissionGuardDependencies, requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import {
  type listPeopleTaskLoads,
  type OrganisationOwnerLimits,
  type PersonTaskLoad,
  personalLimitInForce,
  type SetTaskLimitResult,
} from '../queries/task-limits.js';
import { recordWipRaise } from '../wip-raise.js';

/** What the routes read and write — the database's in production, a test's own otherwise. */
export interface TaskLimitQueries {
  readonly projectRole: PermissionGuardDependencies['projectRole'];
  /** The organisation's two values; throws the `409 invalid_organisation_config` for a bad document. */
  readonly organisationLimits: () => Promise<OrganisationOwnerLimits>;
  readonly personLoad: (userId: string, holders: number) => Promise<PersonTaskLoad | null>;
  readonly people: () => ReturnType<typeof listPeopleTaskLoads>;
  readonly setLimit: (input: {
    readonly userId: string;
    readonly actorUserId: string;
    readonly personal: number | null;
    readonly limits: OrganisationOwnerLimits;
    readonly via: 'self' | 'administrator';
  }) => Promise<SetTaskLimitResult>;
}

export interface TaskLimitRoutesOptions {
  readonly queries: TaskLimitQueries;
  /** Where a raise's `config.changed` is appended; `null` appends nothing (a census composition). */
  readonly recorder: WipRaisedRecorder | null;
}

export const registerTaskLimitRoutes = async (
  app: FastifyInstance,
  options: TaskLimitRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };

  const actorOf = (request: FastifyRequest): { readonly userId: string } => {
    const actor = request.actor;
    if (actor === undefined) {
      // Unreachable through `requirePermission`; the audit row's user is not optional.
      throw new HttpError(401, 'unauthenticated', 'this endpoint needs an authenticated session');
    }
    return { userId: actor.userId };
  };

  const write = async (
    request: FastifyRequest,
    userId: string,
    personal: number | null,
    via: 'self' | 'administrator',
  ): Promise<z.output<typeof taskLimitResponseSchema>> => {
    const actor = actorOf(request);
    const limits = await options.queries.organisationLimits();
    const result = await options.queries.setLimit({
      userId,
      actorUserId: actor.userId,
      personal,
      limits,
      via,
    });
    switch (result.status) {
      case 'not_found':
        throw new NotFoundError(`user ${userId}`);
      case 'above_maximum':
        throw new HttpError(
          422,
          'task_limit_above_maximum',
          `the organisation allows at most ${result.maximum} tasks in flight per person`,
          [{ path: 'max_tasks_in_flight', message: String(result.maximum) }],
        );
      case 'set':
        break;
    }
    if (result.raised !== null && options.recorder !== null) {
      for (const projectId of result.queuedProjects) {
        await recordWipRaise(
          { recorder: options.recorder, limitsInForce: async () => null },
          {
            projectId,
            scope: 'org',
            raised: [{ key: 'pipeline.wip.max_tasks_per_owner', ...result.raised }],
            userId: actor.userId,
            log: request.log,
          },
        );
      }
    }
    return {
      user_id: userId,
      max_tasks_in_flight: result.personal,
      limit: result.limit,
      performed: result.performed,
    };
  };

  typed.get(
    '/api/me/task-limit',
    {
      preValidation: requirePermission(guard, 'worker.register'),
      schema: {
        summary: 'Your limit on tasks in flight, and what counts toward it (S-28.6)',
        description:
          'Your own `max_tasks_in_flight` (`null`: the default), the `limit` in force — your own number under the organisation’s `pipeline.wip.max_tasks_per_owner` (`maximum`), else that value or 3 (`default`) — and what it counts now: `in_flight`, the tasks you own that are `active`, `returned`, `waiting_answers` or `waiting_approval` across every project (paused tasks and tasks at `needs_human` do not count), with up to 20 of them as `holders`, oldest first, and `queued`, your tasks waiting for a place. A project may hold its tasks to a lower default. `409 invalid_organisation_config` when the organisation’s settings document does not parse.',
        tags: ['task-limits'],
        response: { 200: myTaskLimitResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request): Promise<z.output<typeof myTaskLimitResponseSchema>> => {
      const actor = actorOf(request);
      const limits = await options.queries.organisationLimits();
      const load = await options.queries.personLoad(actor.userId, TASK_LIMIT_HOLDERS_MAX);
      if (load === null) {
        throw new NotFoundError(`user ${actor.userId}`);
      }
      return {
        user_id: actor.userId,
        max_tasks_in_flight: load.personal,
        limit: personalLimitInForce(limits, load.personal),
        default: limits.default,
        maximum: limits.maximum,
        organisation_states: limits.organisationStates,
        in_flight: load.inFlight,
        queued: load.queued,
        holders: load.holders.map((holder) => ({
          task_id: holder.taskId,
          ticket_key: holder.ticketKey,
          project_key: holder.projectKey,
          state: holder.state,
        })),
      };
    },
  );

  typed.put(
    '/api/me/task-limit',
    {
      preValidation: requirePermission(guard, 'worker.register'),
      schema: {
        summary: 'Set your own limit on tasks in flight (S-28.6)',
        description:
          'A state assertion: `max_tasks_in_flight` 1–200, or `null` for the default. Above the organisation’s `pipeline.wip.max_tasks_per_owner` is `422 task_limit_above_maximum` (`details`: the maximum) and nothing is written. A repeat of the stored value answers `performed: false` and writes nothing. One `human_actions` row `user.task_limit` `{user_id, max_tasks_in_flight, previous, via: self}` per change. When your limit in force rose, one `config.changed` per project where you have a queued task is appended after the commit, so the scheduler starts what now fits.',
        tags: ['task-limits'],
        body: taskLimitRequestSchema,
        response: { 200: taskLimitResponseSchema, 409: apiErrorSchema, 422: apiErrorSchema },
      },
    },
    async (request) =>
      write(request, actorOf(request).userId, request.body.max_tasks_in_flight, 'self'),
  );

  typed.get(
    '/api/org/task-limits',
    {
      preValidation: requirePermission(guard, 'org.users.manage'),
      schema: {
        summary: 'Every person’s limit on tasks in flight — an administrator’s read (S-28.6)',
        description:
          'The organisation’s `default` and `maximum` and, for every person whose account is not disabled, their own number (`null`: the default), the `limit` in force, their tasks in flight and their queued tasks — counted as `GET /api/me/task-limit` counts them. An administrator (`org.users.manage`).',
        tags: ['task-limits'],
        response: { 200: orgTaskLimitsResponseSchema, 409: apiErrorSchema },
      },
    },
    async (): Promise<z.output<typeof orgTaskLimitsResponseSchema>> => {
      const limits = await options.queries.organisationLimits();
      const people = await options.queries.people();
      return {
        default: limits.default,
        maximum: limits.maximum,
        organisation_states: limits.organisationStates,
        items: people.map((person) => ({
          user_id: person.userId,
          name: person.name,
          email: person.email,
          max_tasks_in_flight: person.personal,
          limit: personalLimitInForce(limits, person.personal),
          in_flight: person.inFlight,
          queued: person.queued,
        })),
      };
    },
  );

  typed.put(
    '/api/org/users/:id/task-limit',
    {
      preValidation: requirePermission(guard, 'org.users.manage'),
      schema: {
        summary: 'Set a person’s limit on tasks in flight — an administrator’s write (S-28.6)',
        description:
          'As `PUT /api/me/task-limit`, for the person `:id` (`404` for none), by an administrator (`org.users.manage`); the audit row says `via: administrator` and names the administrator as its user.',
        tags: ['task-limits'],
        params: taskLimitUserParamsSchema,
        body: taskLimitRequestSchema,
        response: {
          200: taskLimitResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          422: apiErrorSchema,
        },
      },
    },
    async (request) =>
      write(request, request.params.id, request.body.max_tasks_in_flight, 'administrator'),
  );
};
