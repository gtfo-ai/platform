/**
 * `GET /api/projects/:project_id/readiness` — the newest readiness evaluation and the platform's
 * notes beside it (WP-21, WP-143; moved out of `routes/projects.ts` at WP-181's review).
 *
 * The evaluation is stored (`readiness_evaluations`); the notes are computed **at the read, from
 * stored rows only** — the ticket lifecycle's notes from the task-management binding (BD-031 ruling
 * 7) and Q118 (a)'s `binding_account_is_a_person` from the account the binding's last save read
 * (`bindings.account_identity`, migration 0090) joined with `user_identities`. **This route makes no
 * provider call** (the orchestrator's ruling at WP-181 review round 2): a read any viewer makes may
 * not spend an integration's rate budget, stall on a tracker outage or fail on one. Every database
 * read is injected, so `project-readiness.test.ts` drives the route through Fastify beside the
 * bindings route that stores the account, and asserts the fake tracker is not called.
 */
import {
  apiErrorSchema,
  type ReadinessResponse,
  readinessResponseSchema,
  type UserRole,
} from '@platform/contracts';
import { bindingAccountPersonNote, lifecycleReadinessNotes } from '@platform/domain';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { ProjectReadiness } from '../queries/project-queries.js';
import type { ProjectTicketLifecycle } from '../ticket-lifecycle.js';

export interface ProjectReadinessQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  /** The newest evaluation, or why there is none (`findProjectReadiness`). */
  readonly readiness: (projectId: string) => Promise<ProjectReadiness>;
  /** The pipeline's own reading of the binding's lifecycle (`findProjectTicketLifecycle`). */
  readonly ticketLifecycle: (projectId: string) => Promise<ProjectTicketLifecycle>;
  /**
   * Whether the stored account of the project's task-management binding is a mapped person
   * (`findBindingAccountIsAPerson`) — `false` when unknown. A database read, never a provider call.
   */
  readonly accountIsAPerson: (projectId: string) => Promise<boolean>;
}

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

/**
 * The readiness answer with the platform's computed notes appended (WP-181 ruling (d), Q118 (a)):
 * one `lifecycle_slot_unmapped` note per empty slot, or one `lifecycle_not_configured` for a binding
 * with no block (`lifecycleReadinessNotes`); none for no task-management binding, two of them, or a
 * block that fails its schema (the pipeline applies no lifecycle there either). Then
 * `binding_account_is_a_person` when `accountIsAPerson`. The stored notices come first and are
 * untouched; the level, the criteria and `next_improvements` are untouched.
 */
export const withLifecycleNotes = (
  response: ReadinessResponse,
  lifecycle: ProjectTicketLifecycle,
  accountIsAPerson = false,
): ReadinessResponse => {
  const notes = [
    ...(lifecycle.kind === 'none'
      ? lifecycleReadinessNotes(null)
      : lifecycle.kind === 'lifecycle'
        ? lifecycleReadinessNotes(lifecycle.lifecycle)
        : []),
    ...(accountIsAPerson ? [bindingAccountPersonNote()] : []),
  ];
  return {
    ...response,
    notices: [
      ...response.notices,
      ...notes.map((note) => ({ code: note.code, severity: note.severity, message: note.message })),
    ],
  };
};

export const registerProjectReadinessRoutes = async (
  app: FastifyInstance,
  options: { readonly queries: ProjectReadinessQueries },
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };

  typed.get(
    '/api/projects/:project_id/readiness',
    {
      preHandler: requirePermission(guard, 'project.read', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'The project’s readiness evaluation',
        description:
          'product/17’s fourteen criteria as the last evaluation found them, with the level they add up to and the three cheapest improvements next. `unlocks` is platform text; `evidence` is the Discovery agent’s own words for the eleven criteria it answers (BD-022) — render it, never execute it. `notices` carries the stored notices and, computed from stored rows at the read, the ticket lifecycle’s notes and the binding-account note (WP-181); no provider is called. Refuses with 409 `readiness_not_evaluated` for a project nothing has evaluated yet, which is a project whose discovery run has not happened.',
        tags: ['projects'],
        params: projectParamsSchema,
        response: { 200: readinessResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      const readiness = await options.queries.readiness(projectId);
      if (!readiness.found) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (readiness.recorded) {
        const lifecycle = await options.queries.ticketLifecycle(projectId);
        return withLifecycleNotes(
          readiness.response,
          lifecycle,
          lifecycle.kind !== 'no_binding' && (await options.queries.accountIsAPerson(projectId)),
        );
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
