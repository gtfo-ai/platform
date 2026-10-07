/**
 * The expired-last-try recovery's read and its mark, over PostgreSQL (WP-156 ruling (c), PROGRESS
 * backlog 421; the rules are `packages/application/src/recovery/expired-job.ts`').
 *
 * **The read is of pg-boss's own table** (`<schema>.job`), as the stranded-stage and knowledge-apply
 * stores read it, and it rests on the WP-156 measurement
 * (`test/integration/jobs/job-expiry.integration.test.ts`): a last try that expires is a `failed`
 * row whose `output` is one of {@link EXPIRY_SIGNATURES}' two shapes, and a thrown last try is a
 * `failed` row whose `output` is the thrown error. Nothing else on the row tells them apart, so the
 * signatures are matched **exactly** — the supervisor's fixed message, and the worker timer's
 * `Error` with its one sentence — and a handler that threw an error with some other message is never
 * read here (its wrapper escalated it already).
 *
 * The targets (queue, and for `pipeline.outbound` the bound-and-escalate duties read off the
 * payload's `duty`) arrive as one JSON parameter, so the predicate is one statement whatever the
 * census declares. The schema name is interpolated and therefore held to a bare identifier by
 * `assertPgBossSchema`.
 */
import type {
  ExpiredJob,
  ExpiredJobQuery,
  ExpiredJobRecoveryStore,
  ExpiryWriter,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';
import { assertPgBossSchema } from '../jobs/queue-backlog.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

/**
 * What pg-boss 12.30.0 writes into `output` when it fails an expired job — measured at WP-156, and
 * read in `dist/plans.js` (`failJobsByTimeout`, `failJobsByHeartbeat`) and `dist/manager.js`
 * (`#processJobs`'s `resolveWithinSeconds`). A pg-boss upgrade that rewords either is caught by the
 * measurement file, which asserts the stored output itself.
 */
export const EXPIRY_SIGNATURES = {
  /** `failJobsByTimeout` (and `failJobsByHeartbeat`): `{"value": {"message": …}}`, fixed. */
  supervisor: ['job timed out', 'job heartbeat timeout'],
  /** The worker's own timer: a serialised `Error` with this message, `<n>` the expiry in seconds. */
  workerTimer: '^handler execution exceeded [0-9]+s$',
} as const;

interface Row extends Record<string, unknown> {
  readonly id: string;
  readonly queue: string;
  readonly data: unknown;
  readonly tries: number;
  readonly expire_seconds: number;
  readonly completed_on: Date | string;
  readonly writer: ExpiryWriter;
}

export interface PostgresExpiredJobStoreOptions {
  /** pg-boss's schema (`pgboss`). */
  readonly jobsSchema: string;
}

export const createPostgresExpiredJobStore = (
  options: PostgresExpiredJobStoreOptions,
): ExpiredJobRecoveryStore => {
  const schema = assertPgBossSchema(options.jobsSchema);
  return {
    expiredJobs: async (tx, query: ExpiredJobQuery) => {
      if (query.targets.length === 0) return [];
      const { rows } = await sqlOf(tx).query<Row>(
        `select j.id::text as id, j.name as queue, j.data, j.retry_count + 1 as tries,
                j.expire_seconds, j.completed_on,
                case when j.output -> 'value' ->> 'message' = any($5::text[])
                     then 'supervisor' else 'worker_timer' end as writer
           from ${schema}.job j
          where j.state = 'failed'
            and j.retry_count >= j.retry_limit
            and j.completed_on >= $1 and j.completed_on < $2
            and exists (select 1 from jsonb_array_elements($3::jsonb) t
                         where t ->> 'queue' = j.name
                           and (jsonb_typeof(t -> 'duties') = 'null'
                                or (t -> 'duties') ? (j.data ->> 'duty')))
            and ((j.output -> 'value' ->> 'message') = any($5::text[])
                 or (j.output ->> 'name' = 'Error' and j.output ->> 'message' ~ $6))
            and not exists (select 1 from expired_job_escalations m where m.job_id = j.id)
          order by j.completed_on, j.id
          limit $4`,
        [
          query.notBefore,
          query.olderThan,
          JSON.stringify(query.targets),
          query.limit,
          [...EXPIRY_SIGNATURES.supervisor],
          EXPIRY_SIGNATURES.workerTimer,
        ],
      );
      return rows.map(
        (row): ExpiredJob => ({
          jobId: row.id as Id,
          queue: row.queue,
          data: row.data,
          tries: Number(row.tries),
          expireSeconds: Number(row.expire_seconds),
          failedAt: new Date(row.completed_on).toISOString() as IsoDateTime,
          writer: row.writer,
        }),
      );
    },

    markExpiredJob: async (tx, input) => {
      const result = await sqlOf(tx).query(
        `insert into expired_job_escalations (job_id, queue, task_id, marked_at)
         values ($1, $2, $3, $4)
         on conflict (job_id) do nothing`,
        [input.jobId, input.queue, input.taskId, input.at],
      );
      return (result.rowCount ?? 0) > 0;
    },
  };
};
