/**
 * **The jobs pg-boss gave up on, read from its own table** (WP-108, PROGRESS backlog 325).
 *
 * A job whose handler threw on every attempt its queue allows is moved to state `failed`
 * (`pg-boss@12.30.0`, `dist/plans.js` `failJobsBody`: `retry_count < retry_limit` retries, otherwise
 * `failed` with `completed_on = now()`), and kept there until its `keep_until`/deletion window
 * passes (pg-boss's defaults: fourteen days of retention, seven of deletion after completion). This
 * is the read behind `GET /api/org/failed-jobs`, the list beside the dead-letter list, and it is what
 * the census in `@platform/application`'s `job-exhaustion.ts` decided on.
 *
 * **What it reads and what it never reads.** The queue name, the attempts (`retry_count + 1`), the
 * retry limit, the two instants and the failure's **message** — pg-boss stores the thrown error
 * through `serialize-error` as `output` (`{ name, message, stack, … }`), or `{ value: { message } }`
 * for an expiry. The **payload** (`data`) is never selected: it is the job's input, which can carry
 * a blocker brief, a ticket or a provider's text, and nothing an operator decides here needs it. The
 * stack is not read either. The message is the platform's handler's words but may quote a provider,
 * so the route redacts it and then bounds it, as the dead-letter list does.
 */
import type { SqlExecutor } from '../events/sql.js';
import { assertPgBossSchema } from './queue-backlog.js';

/** Longest message this reader returns, before the route's redaction and its own bound. */
const READ_MESSAGE_CHARS = 8_000;

export interface FailedJobRow {
  readonly id: string;
  readonly queue: string;
  /** `retry_count + 1`: the first run and every retry. */
  readonly attempts: number;
  readonly retryLimit: number;
  readonly createdAt: string;
  readonly failedAt: string;
  /** The failure's message, unredacted and unbounded but for a read cap; `null` when none. */
  readonly error: string | null;
}

export interface FailedJobsPage {
  readonly items: readonly FailedJobRow[];
  /** Every failed job pg-boss still keeps, not the page. */
  readonly total: number;
}

export const readFailedJobs = async (
  sql: SqlExecutor,
  schema: string,
  query: { readonly limit: number },
): Promise<FailedJobsPage> => {
  const s = assertPgBossSchema(schema);
  const { rows } = await sql.query<{
    id: string;
    queue: string;
    attempts: number;
    retry_limit: number;
    created_on: Date | string;
    completed_on: Date | string | null;
    message: string | null;
  }>(
    `select id::text as id, name as queue, retry_count + 1 as attempts, retry_limit,
            created_on, completed_on,
            left(coalesce(output ->> 'message', output -> 'value' ->> 'message'), $2) as message
       from ${s}.job
      where state = 'failed'
      order by completed_on desc nulls last, id
      limit $1`,
    [query.limit, READ_MESSAGE_CHARS],
  );
  const counted = await sql.query<{ total: number }>(
    `select count(*)::int as total from ${s}.job where state = 'failed'`,
  );
  return {
    items: rows.map((row) => ({
      id: row.id,
      queue: row.queue,
      attempts: Number(row.attempts),
      retryLimit: Number(row.retry_limit),
      createdAt: new Date(row.created_on).toISOString(),
      // `completed_on` is set on the failing transition; a row without it is dated by its creation
      // rather than published with an invented instant.
      failedAt: new Date(row.completed_on ?? row.created_on).toISOString(),
      error: row.message,
    })),
    total: Number(counted.rows[0]?.total ?? 0),
  };
};
