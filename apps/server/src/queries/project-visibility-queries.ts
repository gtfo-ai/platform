/**
 * The one statement behind `auth/visibility.ts` (BD-035, TD-022's visibility amendment item 1): a
 * person's three sources of visible projects, read together.
 *
 * - `workers` that are not revoked, each one's `claim_project_ids` as stored (`null` and a legacy
 *   `'{}'` are read as every project by the rule, not here);
 * - `project_members` rows;
 * - the projects of tasks they own that are neither `done` nor `cancelled`
 *   (`tasks_owner_user_id_idx`, migration 0104, serves the predicate — no new index).
 *
 * Each list is aggregated in its own scalar subquery, so a person with many tasks does not multiply
 * their workers' rows.
 */
import { sql } from 'drizzle-orm';
import type { VisibilitySources } from '../auth/visibility.js';
import type { Database } from './identity-queries.js';

interface Row extends Record<string, unknown> {
  readonly worker_scopes: unknown;
  readonly memberships: unknown;
  readonly owned_task_projects: unknown;
}

const idsOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

const scopesOf = (value: unknown): (string[] | null)[] =>
  Array.isArray(value) ? value.map((scope) => (Array.isArray(scope) ? idsOf(scope) : null)) : [];

export const readVisibilitySources = async (
  database: Database,
  userId: string,
): Promise<VisibilitySources> => {
  const { rows } = await database.execute<Row>(sql`
    select
      coalesce((select json_agg(w.claim_project_ids)
                  from workers w
                 where w.user_id = ${userId} and w.revoked_at is null), '[]'::json)
        as worker_scopes,
      coalesce((select json_agg(pm.project_id)
                  from project_members pm
                 where pm.user_id = ${userId}), '[]'::json)
        as memberships,
      coalesce((select json_agg(distinct t.project_id)
                  from tasks t
                 where t.owner_user_id = ${userId}
                   and t.state not in ('done', 'cancelled')), '[]'::json)
        as owned_task_projects`);
  const row = rows[0];
  return {
    workerScopes: scopesOf(row?.worker_scopes),
    memberships: idsOf(row?.memberships),
    ownedTaskProjects: idsOf(row?.owned_task_projects),
  };
};
