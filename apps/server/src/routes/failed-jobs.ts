/**
 * Failed jobs — the list beside the dead-letter list (WP-108, PROGRESS backlog 325).
 *
 *   GET /api/org/failed-jobs
 *
 * WP-95 gave the **event** queue's dead letters a list and a re-queue; the **job** queue's — a
 * pg-boss job whose handler threw on every attempt its queue allows — stayed invisible: no list, no
 * count, no audit row. WP-108's census (`@platform/application`'s `job-exhaustion.ts`) classified
 * every registered queue and found most of them rely on pg-boss's retries, the largest
 * (`pipeline.outbound`) with twenty-seven `PipelineOutboundData` duties since WP-111 (twenty-nine
 * with the two that carry payloads of their own), most of them provider writes. Giving each the
 * stage executor's bound-and-escalate shape is a rewrite of that band, so the census chose this read
 * instead: what failed, how often it was tried, why, and — from the census — what that cost and
 * what (if anything) recovers it.
 *
 * ## Who may, and what a caller is shown
 *
 * `org.dead_letters.manage` (**admin**), the dead-letter list's own action: it is the same operator
 * reading the same kind of record across every project. `error` is the failure's message, which may
 * quote a provider, a URL or a credential, so it is **redacted by the platform's patterns and then
 * bounded** (redact-then-slice, `routes/dead-letters.ts`'s order) and the SPA renders it as text
 * (BD-022). The job's **payload is never read**, let alone published (`readFailedJobs`).
 *
 * ## What it does not do
 *
 * There is no re-queue. Backlog 325 made one conditional on the job's handler being shown to
 * re-validate on fire, and nobody has shown that for every queue; what a failed job left is the
 * recovery pass's (where `recovered_by` names a row) or a person's.
 *
 * ## Paging (WP-114, PROGRESS backlog 324)
 *
 * Newest first, `limit` at a time, with an opaque `next_cursor` that pages back to the oldest — a
 * keyset over the failed instant (as the database renders it, microseconds) and the job id, so a job
 * failing between two reads moves no later page. `total` is every failed job, not the page.
 */
import { jobExhaustionOf, type SecretRedactor } from '@platform/application';
import {
  apiErrorSchema,
  type FailedJob,
  failedJobsQuerySchema,
  failedJobsResponseSchema,
  type IsoDateTime,
  MAX_FAILED_JOB_ERROR_CHARS,
} from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { type PermissionGuardDependencies, requirePermission } from '../auth/rbac.js';
import { BadRequestError, HttpError } from '../errors.js';

/** The page a screen asks for when it names none. */
export const DEFAULT_FAILED_JOBS_PAGE = 50;

/** One failed job as the reader returns it (`@platform/infrastructure`'s `readFailedJobs`). */
export interface FailedJobRecord {
  readonly id: string;
  readonly queue: string;
  readonly attempts: number;
  readonly retryLimit: number;
  readonly createdAt: string;
  readonly failedAt: string;
  readonly error: string | null;
  /** The keyset position the next page starts after (`readFailedJobs`, WP-114). */
  readonly position: FailedJobPosition;
}

/** The ordering instant at microsecond precision, as the database rendered it, and the job id. */
export interface FailedJobPosition {
  readonly at: string;
  readonly id: string;
}

export type FailedJobsReader = (query: {
  readonly limit: number;
  readonly before?: FailedJobPosition;
}) => Promise<{
  readonly items: readonly FailedJobRecord[];
  readonly total: number;
}>;

const CURSOR =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** The opaque cursor: the position the reader returned, joined — never re-derived from a `Date`. */
export const failedJobCursorOf = (position: FailedJobPosition): string =>
  `${position.at}_${position.id}`;

/**
 * The position a `cursor` names, or a `400` — anything but what this route handed out is a client
 * error rather than a malformed timestamp in a query (`parseDeadLetterCursor`'s argument).
 */
export const parseFailedJobCursor = (cursor: string): FailedJobPosition => {
  const match = CURSOR.exec(cursor);
  if (match === null || Number.isNaN(Date.parse(match[1] as string))) {
    throw new BadRequestError(
      'invalid_cursor',
      'cursor must be the `next_cursor` this endpoint returned',
    );
  }
  return { at: match[1] as string, id: match[2] as string };
};

export interface FailedJobRoutesOptions {
  /** `null` on a process that reads no job queue; the route then answers 503 by name. */
  readonly read: FailedJobsReader | null;
  /** Unused by an org-scoped guard, and required by its type: no project is named here. */
  readonly projectRole: PermissionGuardDependencies['projectRole'];
  /** TD-012's pattern rules — an HTTP request carries no run-scoped credential (Q55). */
  readonly redactor: SecretRedactor;
}

/** One row on the wire: the error redacted, **then** bounded, and the census's row beside it. */
export const toWireFailedJob = (row: FailedJobRecord, redactor: SecretRedactor): FailedJob => {
  const redacted = row.error === null ? null : redactor.redactText(row.error).value;
  const census = jobExhaustionOf(row.queue);
  return {
    id: row.id,
    queue: row.queue,
    attempts: row.attempts,
    retry_limit: row.retryLimit,
    created_at: row.createdAt as IsoDateTime,
    failed_at: row.failedAt as IsoDateTime,
    error: redacted === null ? null : redacted.slice(0, MAX_FAILED_JOB_ERROR_CHARS),
    error_truncated: redacted !== null && redacted.length > MAX_FAILED_JOB_ERROR_CHARS,
    exhaustion:
      census === null
        ? null
        : { kind: census.kind, loss: census.loss, recovered_by: census.recoveredBy },
  };
};

export const registerFailedJobRoutes = async (
  app: FastifyInstance,
  options: FailedJobRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.projectRole };

  typed.get(
    '/api/org/failed-jobs',
    {
      preValidation: requirePermission(guard, 'org.dead_letters.manage'),
      schema: {
        summary: 'Jobs pg-boss gave up on after their last retry, newest first',
        description:
          'The rows of pg-boss’s job table in state `failed`, newest first, `limit` at a time: `next_cursor` is **opaque** — send it back unchanged as `cursor` for the next, older page — and `null` on the page that reached the oldest. Each names the queue, the attempts (the first run plus every retry), the retry limit, when it was created and when it failed, and the failure’s message — **redacted by the platform’s patterns and bounded**, with `error_truncated` saying whether the bound cut it. `exhaustion` is the census’s row for the queue (whether it bounds its own failures or relies on retries, what a failed job drops, and what recovers it), `null` for a queue this build does not declare. `total` is every failed job pg-boss still keeps, not the page. The job payload is never published, and there is no re-queue. Admin only (WP-108, PROGRESS backlog 325).',
        tags: ['org'],
        querystring: failedJobsQuerySchema,
        response: { 200: failedJobsResponseSchema, 400: apiErrorSchema, 503: apiErrorSchema },
      },
    },
    async (request) => {
      if (options.read === null) {
        throw new HttpError(
          503,
          'failed_jobs_unavailable',
          'this process reads no job queue, so it cannot list the jobs that failed',
        );
      }
      const limit = request.query.limit ?? DEFAULT_FAILED_JOBS_PAGE;
      // One row past the page, so "is there an older page" is read rather than guessed from a count
      // that moves (the dead-letter route's shape).
      const page = await options.read({
        limit: limit + 1,
        ...(request.query.cursor === undefined
          ? {}
          : { before: parseFailedJobCursor(request.query.cursor) }),
      });
      const items = page.items.slice(0, limit);
      const last = items.at(-1);
      return {
        items: items.map((row) => toWireFailedJob(row, options.redactor)),
        total: page.total,
        next_cursor:
          page.items.length > limit && last !== undefined ? failedJobCursorOf(last.position) : null,
      };
    },
  );
};
