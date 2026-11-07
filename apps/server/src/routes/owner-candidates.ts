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
 * **Each candidate's `writes_back`** (S-26.3) is whether assigning them would also assign the
 * ticket in the tracker — `ownerWriteBackReachesTracker`, the predicate the `ticket_owner_assign`
 * duty decides with — of the task `?task_id=` names (the picker opens from one; a task that is not
 * the project's is `404`, so the read says nothing about another project's task) or, with none, of
 * the project's task-management binding.
 *
 * A read: no `human_actions` row, no provider call. Both reads are injected, so the route's guard
 * order and refusals are driven by `owner-candidates.test.ts` against plain functions and the SQL by
 * the integration tier.
 */
import {
  apiErrorSchema,
  type OwnerCandidatesResponse,
  ownerCandidatesQuerySchema,
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
  /**
   * `ownerCandidateWriteBack` (S-26.3): whether assigning each user would reach the tracker — of
   * the named task, or of the project's binding with none — or `null` when the task is not the
   * project's (the route's 404).
   */
  readonly writeBack: (
    input: { readonly projectId: string; readonly taskId: string | null },
    userIds: readonly string[],
  ) => Promise<ReadonlyMap<string, boolean> | null>;
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
          'The people `POST /api/tasks/:id/owner` accepts as a new owner of a task of this project — `member` or above in it (the higher of the organisation role and a project membership) and not disabled — asked through the command’s own predicate, so the list and the command never disagree. Sorted by `name`, then `user_id`. Needs `task.owner.assign` (maintainer) in the project, the permission that names another person as an owner. `name` is a person’s own text: render it as text. 404 for no such project. Each item’s `writes_back` (S-26.3) says whether assigning that person would also assign the ticket in the tracker — the write-back duty’s own predicate, over the task `?task_id=` names (which must be the project’s, else 404; a shadow or platform-issued task reads false) or, with none, over the project’s task-management binding.',
        tags: ['tasks'],
        params: projectParamsSchema,
        querystring: ownerCandidatesQuerySchema,
        response: { 200: ownerCandidatesResponseSchema, 404: apiErrorSchema },
      },
    },
    async (request): Promise<OwnerCandidatesResponse> => {
      const projectId = request.params.project_id;
      const candidates = await options.queries.candidates(projectId);
      if (candidates === null) {
        throw new NotFoundError(`project ${projectId}`);
      }
      // S-26.3: whether each assignment would reach the tracker, by the write-back duty's own
      // predicate. A task of another project is a 404, never an answer about it.
      const taskId = request.query.task_id ?? null;
      const writesBack = await options.queries.writeBack(
        { projectId, taskId },
        candidates.map((candidate) => candidate.user_id),
      );
      if (writesBack === null) {
        throw new NotFoundError(`task ${String(taskId)} in project ${projectId}`);
      }
      return {
        items: candidates.map((candidate) => ({
          user_id: candidate.user_id,
          name: candidate.name,
          writes_back: writesBack.get(candidate.user_id) === true,
        })),
      };
    },
  );
};
