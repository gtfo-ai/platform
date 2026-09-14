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
 * **The writes moved next door.** `POST /api/projects`, `PUT …/config`, `GET/PUT …/bindings` and
 * `POST …/discovery` are served by `routes/onboarding.ts` since WP-21 — a command needs an audit
 * row and an `Idempotency-Key` a read does not — and `GET/PUT …/autonomy`, `PUT …/budgets` and
 * `GET …/audit` by `routes/settings.ts` since WP-30, which is the same settings reached from the
 * other side of onboarding. What is still unbuilt is `POST …/config/export` (the configuration as a
 * merge request on the repository) and recomputing the merge from a repository's own
 * `.agentic/config.yml`; `packages/domain`'s `mergeProjectConfig` is there for both.
 */

import type { SecretRedactor } from '@platform/application';
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
  /**
   * TD-012 step 2 — the platform's pattern rules, injected.
   *
   * The only thing this module publishes that did not come out of a typed projection is the
   * `invalid_stored_config` refusal, which quotes `projects.config` back at the caller;
   * {@link describeConfigIssues} says why that needs a redactor. A read request carries no
   * run-scoped credential (Q55), so the patterns alone are the honest composition — the same one
   * `routes/settings.ts` is given.
   */
  readonly redactor: SecretRedactor;
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

/** Longest rendering of one offending clause; stored state came from outside (BD-022). */
export const MAX_STORED_VALUE_CHARS = 120;

/**
 * `features.review_only.trigger: "manual"` — one clause per zod issue, in the order they were found.
 *
 * The **key path and the value**, because a refusal an operator cannot act on is a 500 with better
 * manners. `instancePath`-style dotted paths are the same spelling `toApiError` gives a request's
 * own validation errors (`errors.ts`), so the two refusals read alike.
 *
 * **Every clause goes through the caller's redactor** (TD-012, BD-022), and all three of its parts
 * do: `projects.config` is partly the repository's own document (layer `repo`, merged from
 * `.agentic/config.yml`), the value is whatever was stored there, and a *strict* schema puts an
 * unrecognised **key** into both the path and zod's own message — so a credential pasted into a
 * config file reaches this string by three routes, not one. It is the same composition
 * `routes/settings.ts` gives `override_reason` and `routes/commands.ts` gives every task command,
 * injected rather than constructed here for the same reason.
 *
 * Redaction runs **before** the bound, which is the opposite order from `auditedText`'s and is
 * deliberate: truncating first can cut a credential in half, and half a credential is both
 * unmatchable by the rules and still a prefix of the secret.
 */
export const describeConfigIssues = (
  document: unknown,
  issues: readonly { readonly path: readonly PropertyKey[]; readonly message: string }[],
  redactText: (value: string) => string,
): string =>
  issues
    .map((issue) => {
      const path = issue.path.map(String).join('.');
      const value = valueAt(document, issue.path);
      const clause =
        value === undefined
          ? `${path === '' ? '(root)' : path} (${issue.message})`
          : `${path}: ${JSON.stringify(value)}`;
      return redactText(clause).slice(0, MAX_STORED_VALUE_CHARS);
    })
    .join(', ');

const valueAt = (document: unknown, path: readonly PropertyKey[]): unknown => {
  let current: unknown = document;
  for (const segment of path) {
    if (typeof current !== 'object' || current === null) {
      return undefined;
    }
    current = (current as Record<PropertyKey, unknown>)[segment];
  }
  return current;
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
        response: { 200: effectiveConfigResponseSchema, 404: apiErrorSchema, 409: apiErrorSchema },
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
        /**
         * **Named, and a 409 rather than a 500** — PROGRESS backlog 58.
         *
         * Boundary schemas are strict, so a value a *previous* release accepted is refused rather
         * than dropped. That is right on the write side, where the platform is about to act, and
         * wrong on the read side, where it is being told what it stored itself: a whole document
         * failing over one key, with a 500 that named no key and offered an import endpoint that
         * does not exist, made wizard step 4 and the project panel unopenable and gave an operator
         * nothing to act on (standing rule 20 splits the two sides).
         *
         * It stays a **refusal** — nothing is dropped, so strictness is preserved and a silently
         * pruned document cannot be re-saved without the key the operator never saw — but it names
         * every key it could not parse and the value it found there, which is a `PUT` an operator
         * can make. The value is stringified, **redacted** and bounded because it is stored state,
         * and stored state came from outside (BD-022) — `describeConfigIssues` has the order and
         * the reason for it.
         */
        throw new HttpError(
          409,
          'invalid_stored_config',
          `the stored configuration of project ${projectId} has ${parsed.error.issues.length} key(s) this release does not accept: ` +
            `${describeConfigIssues(raw, parsed.error.issues, (value) => options.redactor.redactText(value).value)}. ` +
            `Send a corrected document to PUT /api/projects/${projectId}/config`,
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
          'product/17’s fourteen criteria as the last evaluation found them, with the level they add up to and the three cheapest improvements next. `unlocks` is platform text; `evidence` is the Discovery agent’s own words for the eleven criteria it answers (BD-022) — render it, never execute it. Refuses with 409 `readiness_not_evaluated` for a project nothing has evaluated yet, which is a project whose discovery run has not happened.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: readinessResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const readiness = await findProjectReadiness(options.database, projectId);
      if (!readiness.found) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (readiness.recorded) {
        return readiness.response;
      }
      /**
       * **The refusal is a statement about this project, not about the build.**
       *
       * It used to be the latter — nothing wrote `readiness_evaluations` at all — and WP-21's
       * evaluator changed which sentence is true. What has not changed is why a projection is
       * refused in its place: `readinessResponseSchema` publishes the criteria, the evidence and
       * the instant of an evaluation, and `projects.readiness_level` carries none of those, so
       * `{level: 0, evaluated_at: <now>, criteria: []}` would invent two of the three. The row
       * count stays in the message because it is what distinguishes "nothing has evaluated this
       * project" from "rows exist and this reader could not read them".
       */
      throw new HttpError(
        409,
        'readiness_not_evaluated',
        `project ${projectId} has no readiness evaluation (${readiness.rows} readiness_evaluations rows): run discovery on it (POST /api/projects/${projectId}/discovery), which is what records one. The published record needs the criteria, the evidence and the instant of an evaluation, none of which projects.readiness_level carries`,
      );
    },
  );
};
