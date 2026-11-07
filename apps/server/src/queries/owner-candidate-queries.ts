/**
 * **Who may own a task of this project** — the projection behind `GET
 * /api/projects/:id/owner-candidates`, the *Assign…* picker's list (S-26.1's follow-up, the M26 UX
 * spec § 2).
 *
 * The set is the owner command's own: `POST /api/tasks/:id/owner` asks
 * `TaskOwnerDirectory.mayOwn` (`postgres-task-owners.ts`) of its target, and that is
 * `userMayOwnInProjectSql` — the effective project role at `member` or above (the higher of
 * `users.role` and a `project_members` row, backlog 886) and an account that is not disabled. This
 * read asks the **same predicate** of every user, so the picker can never offer a person the command
 * then refuses `422 owner_not_project_member`, nor leave out one it would accept;
 * `test/integration/server/owner-candidates.integration.test.ts` holds the two to one answer.
 *
 * An installation is one organisation (`users` carries no organisation column), so "every user" is
 * the candidate pool. Sorted by `name`, then `id`, so two people with one name keep a stable order.
 */
import type { Id } from '@platform/contracts';
import { pipeline as pipelineAdapters } from '@platform/infrastructure';
import { sql } from 'drizzle-orm';
import type { Database } from './identity-queries.js';

export interface OwnerCandidate {
  readonly user_id: Id;
  readonly name: string;
}

const MAY_OWN = sql.raw(pipelineAdapters.userMayOwnInProjectSql('u.id', 'p.id'));

/**
 * The project's owner candidates, or `null` when there is no such project (the route's 404). A
 * project with no candidate answers an empty list.
 */
export const findOwnerCandidates = async (
  database: Database,
  projectId: string,
): Promise<readonly OwnerCandidate[] | null> => {
  const { rows } = await database.execute<{
    project_id: string;
    user_id: string | null;
    name: string | null;
  }>(sql`
    select p.id as project_id, u.id as user_id, u.name
      from projects p
      left join users u on ${MAY_OWN}
     where p.id = ${projectId}::uuid
     order by u.name, u.id`);
  if (rows.length === 0) {
    return null;
  }
  return rows.flatMap((row) =>
    row.user_id === null ? [] : [{ user_id: row.user_id as Id, name: row.name ?? '' }],
  );
};
