/**
 * The project reads of technical/08: the list, the effective configuration, the budgets, the task
 * page and the readiness ladder.
 *
 * `GET /api/projects/:project_id/config` is the effective configuration with per-key provenance
 * (technical/12 § "Effective configuration"), `…/budgets` is the projection WP-19's ledger folds
 * spend into, and WP-15h part 2 added `GET /api/projects`, `…/tasks` and `…/readiness`.
 *
 * Project scoping is a property of the RBAC middleware that only a real project-scoped request can
 * demonstrate, and every route with a `:project_id` carries the same guard. `GET /api/projects` has
 * no id to scope by, so it is decided on the organisation role — which is the honest reading of a
 * list: `project.read` is `viewer` at organisation level anyway, and a per-project filter here would
 * be the only place in the server that answers a different question from `can()`.
 *
 * Writing the configuration, exporting it to the repository and recomputing the merge from the
 * repository's `.agentic/config.yml` are WP-15's; `packages/domain`'s `mergeEffectiveConfig` is
 * already there for it. `POST /api/projects` and `POST …/discovery` are writes and belong with the
 * command surface.
 */
import {
  agenticConfigSchema,
  apiErrorSchema,
  budgetsResponseSchema,
  effectiveConfigResponseSchema,
  type IsoDateTime,
  listTasksQuerySchema,
  projectsResponseSchema,
  readinessResponseSchema,
  tasksResponseSchema,
} from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import { findProjectTimezone, listProjectBudgets } from '../queries/cost-queries.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectConfig, findProjectRole } from '../queries/identity-queries.js';
import { listProjectTasks, type TaskCursor } from '../queries/pipeline-queries.js';
import { findProjectReadiness, listProjectSummaries } from '../queries/project-queries.js';

export interface ProjectRoutesOptions {
  readonly database: Database;
}

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

/** Default page size for the task list; the client sends its own `limit` when it wants one. */
const DEFAULT_TASK_LIMIT = 50;

/**
 * technical/08's `next_cursor` for the task page, which is a **pair**.
 *
 * `tasks.id` is a uuidv7 and `created_at` is `now()`, so two tasks created inside one transaction
 * share the timestamp exactly — a cursor of the timestamp alone would skip whichever of them fell
 * after a page boundary, silently, because a short page and the last page look the same. Opaque by
 * contract and parsed as untrusted input: the client sends back what it was given, so anything else
 * is a `400` rather than half a keyset in a query.
 *
 * The timestamp is the **database's own rendering, to the microsecond**, and is passed through
 * without being parsed into a `Date` — {@link TaskCursor} records the row that was skipped when it
 * was.
 */
export const encodeTaskCursor = (cursor: TaskCursor): string => `${cursor.createdAt}|${cursor.id}`;

const taskCursorSchema = z.strictObject({
  createdAt: z.iso.datetime({ offset: true }),
  id: z.uuid(),
});

export const decodeTaskCursor = (raw: string): TaskCursor => {
  const separator = raw.lastIndexOf('|');
  const parsed = taskCursorSchema.safeParse({
    createdAt: separator < 0 ? '' : raw.slice(0, separator),
    id: separator < 0 ? '' : raw.slice(separator + 1),
  });
  if (!parsed.success) {
    throw new HttpError(
      400,
      'invalid_cursor',
      'the cursor is not one this endpoint issued; ask for the first page and follow next_cursor',
    );
  }
  // Passed back as the string it arrived as — the query casts it in the database. Parsing it into
  // a `Date` here is exactly the truncation `TaskCursor`'s docblock measures.
  return { createdAt: parsed.data.createdAt, id: parsed.data.id };
};

export const registerProjectRoutes = async (
  app: FastifyInstance,
  options: ProjectRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };

  typed.get(
    '/api/projects',
    {
      preHandler: requirePermission(guard, 'project.read'),
      schema: {
        summary: 'Every project, with its open work and its recent spend',
        description:
          '`open_tasks` counts the tasks that are neither `done` nor `cancelled` — `merged` and `retro` are still in flight. `spent_usd_30d` sums `cost_rollup_daily` over the last thirty calendar days **in the organisation’s timezone** (Q12), so it agrees with the budget windows about when a day turned. Project names and repository URLs come from configuration, not from a model.',
        tags: ['projects'],
        response: { 200: projectsResponseSchema },
      },
    },
    // `new Date()` is the read's own instant: "the last thirty days" is a question about now, and
    // the caller does not get to choose which thirty.
    async () => listProjectSummaries(options.database, new Date().toISOString() as IsoDateTime),
  );

  typed.get(
    '/api/projects/:project_id/config',
    {
      preHandler: requirePermission(guard, 'project.read', {
        // Project scoping: the caller's role for *this* project, which may be higher than their
        // organisation role (see auth/rbac.ts).
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'Effective project configuration, with the source of every key',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: effectiveConfigResponseSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const row = await findProjectConfig(options.database, projectId);
      if (row === null) {
        throw new NotFoundError(`project ${projectId}`);
      }

      // A project that has never been configured stores `{}`. The effective configuration of "no
      // configuration" is the schema's own minimum — version 1 and platform defaults for the rest
      // — not an empty object, which would not validate.
      const raw = Object.keys(row.config).length === 0 ? { version: 1 } : row.config;
      const parsed = agenticConfigSchema.safeParse(raw);
      if (!parsed.success) {
        throw new HttpError(
          500,
          'invalid_stored_config',
          `the stored configuration of project ${projectId} does not match the current schema; re-import it from the repository`,
        );
      }

      return {
        config: parsed.data,
        sources: row.configSource as Record<string, 'default' | 'org' | 'project' | 'repo'>,
        hash: row.configHash ?? 'unconfigured',
        computed_at: row.updatedAt.toISOString(),
      };
    },
  );

  typed.get(
    '/api/projects/:project_id/budgets',
    {
      preHandler: requirePermission(guard, 'project.read', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'Budgets applying to this project, with the spend of the current window',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: budgetsResponseSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const zone = await findProjectTimezone(options.database, projectId);
      if (zone === undefined) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (zone.substituted) {
        // The same state the ledger charges in UTC and warns about; a read answers with the window
        // it actually used rather than a 500 (`findProjectTimezone` says why).
        request.log.warn(
          { project_id: projectId, fallback: zone.timezone },
          'the organisation timezone is not an IANA zone this runtime can use; budget windows are read in UTC',
        );
      }
      // Q12: the organisation's zone decides where the window boundary falls. `new Date()` is the
      // read's own instant — a budget window is "now", and the caller does not get to choose which
      // window it is shown.
      const items = await listProjectBudgets(
        options.database,
        projectId,
        new Date().toISOString() as IsoDateTime,
        zone.timezone,
      );
      return { items: [...items] };
    },
  );

  typed.get(
    '/api/projects/:project_id/tasks',
    {
      preHandler: requirePermission(guard, 'task.read', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'One page of a project’s tasks, newest first',
        description:
          'Filtered by `state`, `template`, `mode` or `stage`. `next_cursor` is an **opaque** keyset over `(created_at, id)`: send it back unchanged, never parse it. A task carries the ticket’s provider, key and URL, which are external text (BD-022): render them, never execute them.',
        tags: ['tasks'],
        params: projectParamsSchema,
        querystring: listTasksQuerySchema,
        response: { 200: tasksResponseSchema },
      },
    },
    async (request) => {
      const query = request.query;
      const limit = query.limit ?? DEFAULT_TASK_LIMIT;
      const page = await listProjectTasks(options.database, request.params.project_id, {
        limit,
        ...(query.cursor === undefined ? {} : { before: decodeTaskCursor(query.cursor) }),
        ...(query.state === undefined ? {} : { state: query.state }),
        ...(query.template === undefined ? {} : { template: query.template }),
        ...(query.mode === undefined ? {} : { mode: query.mode }),
        ...(query.stage === undefined ? {} : { stage: query.stage }),
      });
      if (page === null) {
        // The same answer `/config`, `/budgets` and `/readiness` give for the same id: an empty page
        // and a project that does not exist are different facts, and only one of them is a 200.
        throw new NotFoundError(`project ${request.params.project_id}`);
      }
      return {
        items: [...page.items],
        next_cursor: page.next === undefined ? null : encodeTaskCursor(page.next),
      };
    },
  );

  typed.get(
    '/api/projects/:project_id/readiness',
    {
      preHandler: requirePermission(guard, 'project.read', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'The project’s readiness evaluation',
        description:
          'Refuses with 409 `readiness_not_evaluated` while nothing writes `readiness_evaluations`.',
        tags: ['projects'],
        params: projectParamsSchema,
        // `200` is the shape this endpoint answers with once an evaluator exists; today it answers
        // `409` and nothing else, so both are published (the precedent is `/context-pack`).
        response: { 200: readinessResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const readiness = await findProjectReadiness(options.database, projectId);
      if (!readiness.found) {
        throw new NotFoundError(`project ${projectId}`);
      }
      /**
       * **The refusal is the answer, and it is a statement about the writer rather than the row.**
       *
       * `readinessResponseSchema` publishes the level, the instant it was evaluated **and the
       * criteria** — what passed, the evidence, what it unlocks. Only `readiness_evaluations`
       * (migration 0008) can hold those, and nothing in this repository inserts into it: BD-027's
       * ladder is its own work package. `projects.readiness_level` is `not null default 0`, so a
       * projection could answer `{level: 0, evaluated_at: <now>, criteria: []}` — and two of those
       * three would be invented. An empty criteria list renders as "nothing passed", which is a
       * claim about the project; `evaluated_at` would be the time of the *read*. The row count is in
       * the message so an operator can tell "no producer yet" from "a producer exists and this
       * reader was never written for it".
       */
      throw new HttpError(
        409,
        'readiness_not_evaluated',
        `project ${projectId} has no readiness evaluation (${readiness.rows} readiness_evaluations rows): nothing in this build writes that table, and the published record needs the criteria, the evidence and the instant of an evaluation — none of which projects.readiness_level carries. Giving this endpoint an answer is the readiness evaluator (BD-027), not a reader`,
      );
    },
  );
};
