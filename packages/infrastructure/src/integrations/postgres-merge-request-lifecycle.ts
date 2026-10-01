/**
 * The newest lifecycle event the log holds for one merge request — the read
 * `recordNormalisedDelivery`'s merge-request dedup stands on (WP-110,
 * `packages/application/src/integrations/merge-request-lifecycle.ts`).
 *
 * One statement over `events`, served by `events_mr_lifecycle_idx` (migration 0068): the partial
 * index holds the three lifecycle types only, on the two expressions compared here, so the rows
 * read are the few events of one merge request of one project. The predicate on `type` is spelled
 * exactly as the index's — the planner uses a partial index only when it can prove the query's
 * predicate implies it. Not transactional, by design: the recorder reads it after the stream
 * sequence and before its transaction, and the sequence guard is what makes that race-free.
 *
 * **An aggregate, not `order by position desc limit 1`** — measured, not chosen by taste. On a
 * freshly migrated database with no statistics (the integration tier's), the `limit 1` form planned
 * a backward scan of every partition's `position` index with this predicate as a filter — the
 * planner betting a match sits near the top — which for a merge request the log has never seen
 * (the first delivery of every one) reads the whole log. With statistics both forms take this
 * index: measured at 10^5 other events and 10^3 lifecycle events, `analyze`d, the aggregate answered
 * in 0.024 ms reading 2 shared buffers for an unseen merge request and 0.052 ms (3) for one with three
 * events. The aggregate has no order for the planner to bet on, so it does not depend on the
 * statistics being current — and a new monthly partition starts with none.
 */
import type {
  MergeRequestLifecycleEvent,
  MergeRequestLifecycleReader,
} from '@platform/application';
import type { SqlExecutor } from '../events/sql.js';

/** The statement, exported so the integration tier's plan check reads the query that runs. */
export const MERGE_REQUEST_LIFECYCLE_SQL = `select (array_agg(type order by position desc))[1] as type
   from events
  where type in ('mr.opened', 'mr.merged', 'mr.closed')
    and payload ->> 'project_id' = $1
    and (payload -> 'mr') ->> 'iid' = $2
    and coalesce((payload -> 'mr') ->> 'project_path', '') = $3`;

export interface PostgresMergeRequestLifecycleOptions {
  readonly sql: SqlExecutor;
}

export const createPostgresMergeRequestLifecycle = (
  options: PostgresMergeRequestLifecycleOptions,
): MergeRequestLifecycleReader => ({
  latest: async (key) => {
    const { rows } = await options.sql.query<{ type: MergeRequestLifecycleEvent | null }>(
      MERGE_REQUEST_LIFECYCLE_SQL,
      [key.projectId, String(key.iid), key.projectPath ?? ''],
    );
    return rows[0]?.type ?? null;
  },
});
