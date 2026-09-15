/**
 * `GET /api/org/stats` and its CSV twin — technical/08's organisation statistics, product/10:22's
 * screen (WP-41).
 *
 * ## Why two paths rather than one with a `format` parameter
 *
 * Fastify compiles a response serialiser per status code from the route's schema, and a route that
 * sometimes answers a strict object and sometimes a `text/csv` string has to publish a schema that
 * is a lie for one of them — in the OpenAPI document as well as in the code. Two routes each
 * publish what they actually return. The cost is one more path in
 * `routes/client-census.test.ts`, which is the file that would have caught it either way.
 *
 * ## `org.read`, which is `viewer`
 *
 * Statistics are the organisation's own delivery performance, and product/16 makes one of them
 * explicitly visible to everyone in the project (*"Clean-first-MR rate per ticket author … visible
 * to everyone"*, Q22). The cost figures here are already viewer-visible through `budget.read`, and
 * nothing on this endpoint is a credential, a prompt or a model's output. `org.audit.read`
 * (maintainer) guards the audit log because that is a record of *who did what*; this is a record of
 * what the platform delivered.
 *
 * ## What it refuses
 *
 * A range holding more tasks than one answer is folded from is refused **409
 * `stats_range_too_large`** rather than served short, because a truncated total looks exactly like
 * a real one on a screen (`queries/stats-queries.ts` carries the bound and the reasoning). There is
 * no "no data" refusal: an organisation that has delivered nothing has a real zero for every count
 * and a `null` for every ratio, which is a measurement rather than an absence.
 */
import { rollupDay } from '@platform/application';
import type { IsoDateTime, UserRole } from '@platform/contracts';
import { apiErrorSchema, orgStatsQuerySchema, orgStatsResponseSchema } from '@platform/contracts';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { requirePermission } from '../auth/rbac.js';
import { HttpError } from '../errors.js';
import type { ResolvedRange, StatsSources } from '../queries/stats-metrics.js';
import {
  DEFAULT_BUCKET,
  DEFAULT_RANGE,
  foldStats,
  resolveRange,
  statsToCsv,
} from '../queries/stats-metrics.js';
import { StatsRangeTooLargeError } from '../queries/stats-queries.js';

/**
 * The three reads this file needs, bound to the process's database by the composition root.
 *
 * The shape `routes/settings.ts`, `routes/asks.ts` and `routes/org.ts`'s identity pair use, and for
 * the reason those give: bound as functions, the routes are drivable through the **real** router
 * against plain functions, so the 401, the 409, the content type and the CSV body are asserted
 * against the router that serves them rather than against a copy of it. What a fake cannot say —
 * that the SQL answers on a migrated database — is `test/e2e/server/stats-api.e2e.test.ts`'s, which
 * is standing rule 1's instance from WP-31 answered in advance.
 */
export interface StatsQueries {
  readonly projectRole: (projectId: string, userId: string) => Promise<UserRole | null>;
  readonly timezone: () => Promise<{ readonly timezone: string; readonly substituted: boolean }>;
  readonly sources: (
    range: ResolvedRange,
    options: { readonly timezone: string; readonly projectId: string | null },
  ) => Promise<StatsSources>;
}

export interface StatsRoutesOptions {
  readonly queries: StatsQueries;
  /** Injected so a test can pin the range without pinning the clock globally. */
  readonly now?: () => IsoDateTime;
}

type StatsQuery = {
  readonly range?: '7d' | '30d' | '90d' | '365d';
  readonly bucket?: 'day' | 'week' | 'month';
  readonly project_id?: string;
  readonly format?: 'json' | 'csv';
};

export const registerStatsRoutes = async (
  app: FastifyInstance,
  options: StatsRoutesOptions,
): Promise<void> => {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const guard = { projectRole: options.queries.projectRole };
  const now = options.now ?? (() => new Date().toISOString() as IsoDateTime);

  /**
   * One answer, whichever representation asked for it.
   *
   * The timezone is read **once** and used for three things that must agree: the civil day "today"
   * falls in, the day each row is cut on in SQL, and the zone the response names (Q12, standing
   * rule 9).
   */
  const load = async (query: StatsQuery) => {
    const zone = await options.queries.timezone();
    const range = resolveRange(
      query.range ?? DEFAULT_RANGE,
      query.bucket ?? DEFAULT_BUCKET,
      rollupDay(now(), zone.timezone),
    );
    const projectId = query.project_id ?? null;
    try {
      const sources = await options.queries.sources(range, {
        timezone: zone.timezone,
        projectId,
      });
      return foldStats({
        range,
        timezone: zone.timezone,
        timezoneSubstituted: zone.substituted,
        projectId,
        generatedAt: now(),
        sources,
      });
    } catch (error) {
      if (error instanceof StatsRangeTooLargeError) {
        throw new HttpError(409, 'stats_range_too_large', error.message);
      }
      throw error;
    }
  };

  typed.get(
    '/api/org/stats',
    {
      preValidation: requirePermission(guard, 'org.read'),
      schema: {
        summary: 'Delivery statistics for the organisation',
        description:
          'product/16 and product/19 §10, over a range of civil days in the organisation timezone. Every metric carries its own definition (product/10:63) and a metric this build cannot compute carries `absent` with the reason and the owner rather than a zero. Minutes and dollars are two fields and are never added: no hourly rate exists (Q73).',
        tags: ['org'],
        querystring: orgStatsQuerySchema,
        response: { 200: orgStatsResponseSchema, 409: apiErrorSchema },
      },
    },
    async (request) => load(request.query),
  );

  typed.get(
    '/api/org/stats.csv',
    {
      preValidation: requirePermission(guard, 'org.read'),
      schema: {
        summary: 'The same statistics as CSV (product/10:24)',
        description:
          'One row per metric per bucket, plus a total row per metric carrying its definition and — for a metric this build cannot compute — why it is absent. Long rather than wide, so an absent metric has no rows instead of an empty cell a spreadsheet would read as zero.',
        tags: ['org'],
        querystring: orgStatsQuerySchema,
        // **No `response` block, deliberately.** This route sends a `text/csv` string; declaring a
        // schema for any status would compile a JSON serialiser for a payload that is not JSON,
        // and publishing one in the OpenAPI document would describe an answer this route never
        // gives. The refusal below is the shared error handler's, in the shape every route uses.
      },
    },
    async (request, reply) => {
      const document = await load(request.query);
      return reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header(
          'content-disposition',
          // The filename is built from the range this endpoint resolved, never from a caller's
          // string: a header value is a place a quote or a newline would be somebody else's bug.
          `attachment; filename="agentic-stats-${document.range.from}-to-${document.range.to}.csv"`,
        )
        .send(statsToCsv(document));
    },
  );
};
