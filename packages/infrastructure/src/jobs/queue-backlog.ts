/**
 * **What the job queues are holding, read from pg-boss's own tables** (WP-86, PROGRESS backlog 135).
 *
 * TD-028's Consequences section says a deployment with no runner leaves `stage.execute` jobs
 * queued, and that this must be visible: *"the queue depth is a metric, `/readyz` reports the runner
 * as absent"*. Neither existed until WP-86. This module is the two reads behind them:
 *
 *  - {@link readQueueBacklog} — per queue, the jobs that are **ready and unclaimed** (state
 *    `created` or `retry`, eligible now) and how long the oldest of them has been eligible. It is the
 *    `jobs_queued{queue}` / `jobs_queued_oldest_age_seconds{queue}` gauges' source
 *    (`apps/server/src/metrics.ts`). A timer that is not due yet (`start_after` in the future — every
 *    `deadline.sweep` wake-up, a retry's back-off) is **not** backlog, so it is not counted.
 *  - {@link readAgentRunService} — `/readyz`'s `agent_runs` line (`apps/server/src/readiness.ts`):
 *    `unserved` when `stage.execute` holds a job that has been eligible for longer than the bound
 *    **and** nothing has claimed a `stage.execute` job within it (none active, none started).
 *
 * Both are about the **instance**, not the process that answers: the queue is in the database, so
 * every process reads the same answer. That is the point — `app` is designed to run no agent, so a
 * process-local "do I run agents?" would be wrong on the one process an operator looks at.
 *
 * The runner's absence is the case this exists for, and it is the case a check *in* the runner
 * cannot report: a container that is not there runs no healthcheck (`compose.yml`'s `runner`).
 */
import { JOB_QUEUES } from '@platform/application';
import type { SqlExecutor } from '../events/sql.js';

/**
 * How long a `stage.execute` job may be eligible, with nothing claiming, before `/readyz` says the
 * agent stages are unserved: **five minutes**.
 *
 * The derivation: a subscribed worker with a free slot claims within one polling interval
 * (`APP_JOBS_POLL_INTERVAL_SECONDS`, default 2 s, so 150 intervals); a runner restarting under
 * `restart: unless-stopped` is back in well under a minute; a job waiting out its retry back-off is
 * not eligible and does not count. A busy runner is not "unserved" either way — its active job is a
 * claim. Short enough that an operator onboarding a first project sees the line within one sitting.
 *
 * **The residual that definition carries:** an active job counts as a claim, so a runner that died
 * holding a job reads *served* until pg-boss expires that job (up to its two-hour expiry) — the line
 * can say the stages are served for that long after the last runner went away.
 */
export const AGENT_RUNS_UNSERVED_AFTER_SECONDS = 300;

/** One queue's ready, unclaimed jobs. `oldestAgeSeconds` is `null` when there are none. */
export interface QueueBacklog {
  readonly queue: string;
  readonly queued: number;
  readonly oldestAgeSeconds: number | null;
}

/**
 * `schema` is interpolated, so it is held to a bare identifier here although `loadJobsConfig` admits
 * only `pgboss` since WP-106: this reader takes a string, and the check is what keeps that true of
 * every caller.
 */
const assertSchema = (schema: string): string => {
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
  const s = assertSchema(schema);
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

/** `served`: nothing has waited past the bound, or something claimed a job within it. */
export type AgentRunService = 'served' | 'unserved';

/** Whether anything is taking `stage.execute` jobs; see {@link AGENT_RUNS_UNSERVED_AFTER_SECONDS}. */
export const readAgentRunService = async (
  sql: SqlExecutor,
  schema: string,
  unservedAfterSeconds: number = AGENT_RUNS_UNSERVED_AFTER_SECONDS,
): Promise<AgentRunService> => {
  const s = assertSchema(schema);
  const { rows } = await sql.query<{ waiting: boolean; claimed: boolean }>(
    `select exists (
              select 1 from ${s}.job
               where name = $2
                 and state in ('created', 'retry')
                 and start_after <= now() - make_interval(secs => $1::float8)
            ) as waiting,
            exists (
              select 1 from ${s}.job
               where name = $2
                 and (state = 'active' or started_on >= now() - make_interval(secs => $1::float8))
            ) as claimed`,
    [unservedAfterSeconds, JOB_QUEUES.stageExecute],
  );
  const row = rows[0];
  return row?.waiting === true && row.claimed !== true ? 'unserved' : 'served';
};
