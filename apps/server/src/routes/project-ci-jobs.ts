/**
 * The manual CI jobs seen in a project's recent task pipelines (S-28.7, the M28 ruling):
 *
 *   GET  /api/projects/:project_id/ci/manual-jobs
 *
 * What the *Manual CI jobs* card on the project's *Rules & limits* offers a choice for — *Start it
 * automatically* (`run`), *Wait for a person* (`wait`) or *Don't run, don't wait* (`ignore`) — the
 * choice itself being written as `pipeline.ci.manual_jobs` through `PUT …/config`, like every
 * other key of the document.
 *
 * A **maintainer's** (`project.pipeline.write`), as the tracker's statuses read is: the choice is a
 * pipeline setting, and the read spends provider calls (at most five, cached for a minute,
 * `manual-jobs-seen.ts`). A project with no git binding is `409 no_git_binding`; a binding that
 * cannot be built, or a process that composed no integrations, is `503 manual_jobs_unavailable`.
 * The answer is untrusted provider text (BD-022), bounded by its schema.
 */
import {
  apiErrorSchema,
  type Id,
  manualJobsSeenResponseSchema,
  type UserRole,
} from '@platform/contracts';
import { can } from '@platform/domain';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { effectiveRole, requirePermission } from '../auth/rbac.js';
import { HttpError, NotFoundError } from '../errors.js';
import type { ManualJobsSeenAnswer } from '../manual-jobs-seen.js';

export interface ProjectCiJobsRoutesOptions {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  readonly projectExists: (projectId: string) => Promise<boolean>;
  /** The read, or `null` on a process that composed no integration stack. */
  readonly manualJobsSeen: ((projectId: Id) => Promise<ManualJobsSeenAnswer>) | null;
}

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

export const registerProjectCiJobsRoutes = async (
  app: FastifyInstance,
  options: ProjectCiJobsRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.projectRole };
  const projectOf = (request: FastifyRequest): string | undefined => {
    const value = (request.params as { project_id?: unknown }).project_id;
    return typeof value === 'string' && UUID.test(value) ? value : undefined;
  };

  typed.get(
    '/api/projects/:project_id/ci/manual-jobs',
    {
      preValidation: requirePermission(guard, 'project.pipeline.write', { project: projectOf }),
      schema: {
        summary: 'The manual CI jobs seen in this project’s recent task pipelines',
        description:
          'Read from the latest pipeline of at most five recent task heads through `IntegrationActionExecutor`, cached for a minute per project: each job seen at `manual` once by name with its stage, whether it blocks the pipeline, whether it is a trigger job (never started by the platform) and whether it reads like a deployment; and every job name seen, so a choice for a name no pipeline has can be flagged. Untrusted provider text (BD-022). `409 no_git_binding` when the project has none; `503 manual_jobs_unavailable` when the binding cannot be read. A maintainer’s (`project.pipeline.write`).',
        tags: ['projects'],
        params: projectParamsSchema,
        response: {
          200: manualJobsSeenResponseSchema,
          404: apiErrorSchema,
          409: apiErrorSchema,
          503: apiErrorSchema,
        },
      },
    },
    async (request) => {
      const projectId = request.params.project_id;
      if (!(await options.projectExists(projectId))) {
        throw new NotFoundError(`project ${projectId}`);
      }
      if (options.manualJobsSeen === null) {
        throw new HttpError(
          503,
          'manual_jobs_unavailable',
          'this process composed no integrations, so it cannot read the project’s pipelines. Ask an instance that runs the workers',
        );
      }
      const answer = await options.manualJobsSeen(projectId as Id);
      if (answer.status === 'no_binding') {
        throw new HttpError(
          409,
          'no_git_binding',
          'this project has no git binding, so there are no pipelines to read manual jobs from; bind a git host first',
        );
      }
      if (answer.status === 'unavailable') {
        throw new HttpError(503, 'manual_jobs_unavailable', answer.reason);
      }
      // The card's Save is an administrator's (`PUT …/config`): say so rather than answer a 403.
      const actor = request.actor;
      const role =
        actor === undefined
          ? undefined
          : effectiveRole(actor.role, await options.projectRole(projectId, actor.userId));
      return {
        ...answer.seen,
        can_save: role !== undefined && can(role, 'project.settings.write'),
      };
    },
  );
};
