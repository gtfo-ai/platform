/**
 * `GET /api/tasks/:task_id` — technical/08's "the task, with stages, artifacts and checks" (WP-15h).
 *
 * One read, and it is the one the task screen is built on: `taskDetailResponseSchema` is a
 * composite, so this route is where the projections of five tables meet the DTO the SPA parses. The
 * *commands* of technical/08 § "Tasks" (`pause`, `resume`, `retry-stage`, `answer`, …) are not
 * here — each of them writes, and a write needs the aggregate, the human-action audit row and an
 * idempotency key rather than a query. They belong to the work package that gives the pipeline an
 * HTTP mutation surface; this row was scoped to the reads (`13-implementation-plan.md`, WP-15h).
 *
 * `checks` is the other absence worth naming: `taskDetailResponseSchema` has no field for them, so
 * there is nothing here to omit — the Checks panel names the same gap in its own docblock.
 */
import { taskDetailResponseSchema } from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { NotFoundError } from '../errors.js';
import type { Database } from '../queries/identity-queries.js';
import { findProjectRole, findTaskProjectId } from '../queries/identity-queries.js';
import { findTaskDetail } from '../queries/pipeline-queries.js';
import { scopedProject, scopeToProject } from './scope.js';

export interface TaskRoutesOptions {
  readonly database: Database;
}

const taskParamsSchema = z.strictObject({ task_id: z.uuid() });

export const registerTaskRoutes = async (
  app: FastifyInstance,
  options: TaskRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = {
    projectRole: async (projectId: string, userId: string) =>
      findProjectRole(options.database, projectId, userId),
  };
  const scope = scopeToProject({
    database: options.database,
    param: 'task_id',
    what: 'task',
    projectOf: findTaskProjectId,
  });

  typed.get(
    '/api/tasks/:task_id',
    {
      // `task.read` is `viewer` (technical/08's capability map). The task record carries no model
      // output: the ticket reference, the state machine's position, cost totals and the ids of the
      // artifacts. The artifacts' *content* and the transcript are separately gated.
      preHandler: [scope, requirePermission(guard, 'task.read', { project: scopedProject })],
      schema: {
        summary: 'One task, with its stages, artifacts, questions, approvals and runs',
        description:
          'Ticket text, question text and stage outcomes are untrusted content (BD-022): render them, never execute them.',
        tags: ['tasks'],
        params: taskParamsSchema,
        response: { 200: taskDetailResponseSchema },
      },
    },
    async (request) => {
      const detail = await findTaskDetail(options.database, request.params.task_id);
      if (detail === null) {
        // Unreachable through the preHandler, which 404s on the same question; kept because the
        // two reads are separate statements and a task deleted between them is a 404, not a 500.
        throw new NotFoundError(`task ${request.params.task_id}`);
      }
      return detail;
    },
  );
};
