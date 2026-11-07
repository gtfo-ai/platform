/**
 * `GET /api/projects/:project_id/owner-candidates` — the people the task page's *Assign…* picker
 * offers (S-26.1's follow-up, the M26 UX spec § 2; its caller is S-26.8b).
 *
 * **The guard is the owner command's assign permission**, `task.owner.assign` (maintainer), over the
 * caller's effective role in the project: the list exists only for someone who may name another
 * person as an owner, and a member — who may take an unassigned task or give back their own, never
 * assign — is refused `403` like the action is not offered to them. **The answer is the owner
 * command's target rule**, through the one predicate it asks (`findOwnerCandidates` over
 * `userMayOwnInProjectSql`), so the list and the command cannot disagree about a person.
 *
 * A read: no `human_actions` row, no provider call. Both reads are injected, so the route's guard
 * order and refusals are driven by `owner-candidates.test.ts` against plain functions and the SQL by
 * the integration tier.
 */
import {
  apiErrorSchema,
  type OwnerCandidatesResponse,
  ownerCandidatesResponseSchema,
  type UserRole,
} from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import * as z from 'zod';
import { requirePermission } from '../auth/rbac.js';
import { NotFoundError } from '../errors.js';
import type { OwnerCandidate } from '../queries/owner-candidate-queries.js';

export interface OwnerCandidateQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  /** `findOwnerCandidates`: the project's candidates in order, or `null` for no such project. */
  readonly candidates: (projectId: string) => Promise<readonly OwnerCandidate[] | null>;
}

const projectParamsSchema = z.strictObject({ project_id: z.uuid() });

export const registerOwnerCandidateRoutes = async (
  app: FastifyInstance,
  options: { readonly queries: OwnerCandidateQueries },
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };

  typed.get(
    '/api/projects/:project_id/owner-candidates',
    {
      preHandler: requirePermission(guard, 'task.owner.assign', {
        project: (request) => (request.params as { project_id: string }).project_id,
      }),
      schema: {
        summary: 'Who may own a task of this project',
        description:
          'The people `POST /api/tasks/:id/owner` accepts as a new owner of a task of this project — `member` or above in it (the higher of the organisation role and a project membership) and not disabled — asked through the command’s own predicate, so the list and the command never disagree. Sorted by `name`, then `user_id`. Needs `task.owner.assign` (maintainer) in the project, the permission that names another person as an owner. `name` is a person’s own text: render it as text. 404 for no such project.',
        tags: ['tasks'],
        params: projectParamsSchema,
        response: { 200: ownerCandidatesResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request): Promise<OwnerCandidatesResponse> => {
      const projectId = request.params.project_id;
      const candidates = await options.queries.candidates(projectId);
      if (candidates === null) {
        throw new NotFoundError(`project ${projectId}`);
      }
      return {
        items: candidates.map((candidate) => ({
          user_id: candidate.user_id,
          name: candidate.name,
        })),
      };
    },
  );
};
