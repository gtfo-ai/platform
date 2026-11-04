/**
 * **What the job queues are holding, read from pg-boss's own tables** (WP-86, PROGRESS backlog 135).
 *
 * TD-028's Consequences section says a deployment with no runner leaves `stage.execute` jobs
 * queued, and that this must be visible: *"the queue depth is a metric, `/readyz` reports the runner
 * as absent"*. Neither existed until WP-86. This module is the read behind the first:
 *
 *  - {@link readQueueBacklog} — per queue, the jobs that are **ready and unclaimed** (state
 *    `created` or `retry`, eligible now) and how long the oldest of them has been eligible. It is the
 *    `jobs_queued{queue}` / `jobs_queued_oldest_age_seconds{queue}` gauges' source
 *    (`apps/server/src/metrics.ts`). A timer that is not due yet (`start_after` in the future — every
 *    `deadline.sweep` wake-up, a retry's back-off) is **not** backlog, so it is not counted.
 *
 * WP-86's second read — `/readyz`'s `agent_runs`, a `stage.execute` job nothing claimed — is gone
 * since WP-277: a job ends at the offer (WP-276), so its backlog is plans and gates waiting for any
 * worker, never runs waiting for a claimant. The agent backlog is the offer pool's
 * (`../pipeline/offer-backlog.ts`, `/readyz`'s `claimants`).
 *
 * It is about the **instance**, not the process that answers: the queue is in the database, so
 * every process reads the same answer.
 */
import type { SqlExecutor } from '../events/sql.js';

/** One queue's ready, unclaimed jobs. `oldestAgeSeconds` is `null` when there are none. */
export interface QueueBacklog {
  readonly queue: string;
  readonly queued: number;
  readonly oldestAgeSeconds: number | null;
}

/**
 * `schema` is interpolated, so it is held to a bare identifier here although `loadJobsConfig` admits
 * only `pgboss` since WP-106: this reader takes a string, and the check is what keeps that true of
 * every caller — including the two readers outside this module that interpolate it too (WP-108:
 * the stranded-stage recovery store and the failed-jobs read).
 */
export const assertPgBossSchema = (schema: string): string => {
  if (!/^[a-z_][a-z0-9_]*$/.test(schema)) {
    throw new Error(`invalid pg-boss schema name ${JSON.stringify(schema)}`);
  }
  return schema;
};

/**
 * Every **declared** queue with its backlog — a queue with nothing waiting is a row with `0`, which
 * is a measurement, not an absence (standing rule 16) — and `oldestAgeSeconds` only where something
 * waits, because an age of nothing has no value to report.
 */
export const readQueueBacklog = async (
  sql: SqlExecutor,
  schema: string,
): Promise<readonly QueueBacklog[]> => {
  const s = assertPgBossSchema(schema);
  const { rows } = await sql.query<{
    queue: string;
    queued: number;
    oldest_age_seconds: number | null;
  }>(
    `select q.name as queue,
            count(j.id)::int as queued,
            extract(epoch from now() - min(j.start_after))::float8 as oldest_age_seconds
       from ${s}.queue q
       left join ${s}.job j
         on j.name = q.name
        and j.state in ('created', 'retry')
        and j.start_after <= now()
      group by q.name
      order by q.name`,
  );
  return rows.map((row) => ({
    queue: row.queue,
    queued: Number(row.queued),
    oldestAgeSeconds: row.oldest_age_seconds === null ? null : Number(row.oldest_age_seconds),
  }));
};
