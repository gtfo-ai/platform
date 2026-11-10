/**
 * **Is a human-return window open for a merge request?** (S-28.15, TD-038 decision 3) — read from
 * pg-boss's own table, the way `queue-backlog.ts` and the stranded-stage store read it.
 *
 * BD-007's window is an `mr.comment.debounce` job with the singleton key `mr:<iid>`
 * (`enqueueReviewCommentWindow`), so "a window is open" is exactly "such a job is created, waiting
 * to retry, or active". The platform's merge waits while one is: a person's words are still being
 * collected, and the window may return the task.
 */
import { JOB_QUEUES } from '@platform/application';
import type { SqlExecutor } from '../events/sql.js';
import { assertPgBossSchema } from './queue-backlog.js';

export interface ReviewWindowProbe {
  readonly reviewWindowOpen: (iid: number) => Promise<boolean>;
}

export const createPostgresReviewWindowProbe = (options: {
  readonly sql: SqlExecutor;
  /** pg-boss's schema (`APP_JOBS_SCHEMA`'s value, `pgboss`). */
  readonly jobsSchema: string;
}): ReviewWindowProbe => {
  const schema = assertPgBossSchema(options.jobsSchema);
  return {
    reviewWindowOpen: async (iid) => {
      const { rows } = await options.sql.query(
        `select 1 from ${schema}.job
          where name = $1 and singleton_key = $2 and state in ('created', 'retry', 'active')
          limit 1`,
        [JOB_QUEUES.mrCommentDebounce, `mr:${iid}`],
      );
      return rows.length > 0;
    },
  };
};
