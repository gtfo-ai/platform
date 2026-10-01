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
  /**
   * The row's keyset position — the instant it is ordered by, **as the database renders it**
   * (microseconds; a `Date` would truncate to milliseconds and the next page would skip or repeat
   * the row it came from, the task page's measured defect) — and its id (WP-114, backlog 324).
   */
  readonly position: FailedJobPosition;
}

/** Where a page ends: the ordering instant at microsecond precision, and the job id. */
export interface FailedJobPosition {
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`, UTC. */
  readonly at: string;
  readonly id: string;
}

export interface FailedJobsPage {
  readonly items: readonly FailedJobRow[];
  /** Every failed job pg-boss still keeps, not the page. */
  readonly total: number;
}

/**
 * The newest `limit` failed jobs **older than** `before` when it is given (WP-114, PROGRESS backlog
 * 324: the list had no way past its first page). A keyset over `(failed instant, id)`, both
 * descending: the instant is `coalesce(completed_on, created_on)` — the `failed_at` the route
 * publishes — so a page reads in the order the screen shows, and the id breaks a tie between two
 * jobs that failed in one microsecond. A job failing between two reads lands **before** the first
 * page and moves no later page.
 */
export const readFailedJobs = async (
  sql: SqlExecutor,
  schema: string,
  query: { readonly limit: number; readonly before?: FailedJobPosition },
): Promise<FailedJobsPage> => {
  const s = assertPgBossSchema(schema);
  const { rows } = await sql.query<{
    id: string;
    queue: string;
    attempts: number;
    retry_limit: number;
    created_on: Date | string;
    completed_on: Date | string | null;
    position_at: string;
    message: string | null;
    total: number;
  }>(
    // One statement, so the page and its `total` are one snapshot (session 11, found on WP-110's
    // tree: as two statements a job that failed between them answered `total: 1` beside no items).
    // A first page with no rows means no failed job at all (`limit` is at least 1), so `total` is 0.
    `select id::text as id, name as queue, retry_count + 1 as attempts, retry_limit,
            created_on, completed_on,
            to_char(coalesce(completed_on, created_on) at time zone 'UTC',
                    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as position_at,
            left(coalesce(output ->> 'message', output -> 'value' ->> 'message'), $2) as message,
            (select count(*)::int from ${s}.job where state = 'failed') as total
       from ${s}.job
      where state = 'failed'
        and ($3::timestamptz is null
             or (coalesce(completed_on, created_on), id) < ($3::timestamptz, $4::uuid))
      order by coalesce(completed_on, created_on) desc, id desc
      limit $1`,
    [query.limit, READ_MESSAGE_CHARS, query.before?.at ?? null, query.before?.id ?? null],
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
      position: { at: row.position_at, id: row.id },
    })),
    // On a later page, a page with no rows does not mean "no failed job at all": the count is then
    // read on its own (one more statement, only for an empty page past the first).
    total:
      rows[0] !== undefined
        ? Number(rows[0].total)
        : query.before === undefined
          ? 0
          : Number(
              (
                await sql.query<{ total: number }>(
                  `select count(*)::int as total from ${s}.job where state = 'failed'`,
                )
              ).rows[0]?.total ?? 0,
            ),
  };
};
