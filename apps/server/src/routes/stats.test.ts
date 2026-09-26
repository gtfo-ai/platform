/**
 * `GET /api/org/stats` and `/api/org/stats.csv`, driven end to end through Fastify against **plain
 * functions** (WP-41).
 *
 * `routes/settings.test.ts`'s shape and its argument: the e2e tier proves that the numbers come
 * from events a real instance produced, and it can only do that once, slowly. What this file owns
 * is what the *route* decides — which capability it asks for, what the defaults are, which refusal
 * maps to which status, what content type the CSV twin sends, and that the document it publishes
 * passes the schema Fastify serialises it with.
 *
 * **What this tier cannot see, stated rather than implied**: the query functions are fakes, so
 * "the SQL answers on a migrated database" is `test/e2e/server/stats-api.e2e.test.ts`'s — which is
 * standing rule 1's WP-31 instance (*a route's test double returning what the route would like*)
 * answered before it could happen again.
 */
import type { IsoDateTime, UserRole } from '@platform/contracts';
import { orgStatsResponseSchema } from '@platform/contracts';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { ResolvedRange, StatsSources } from '../queries/stats-metrics.js';
import { StatsRangeTooLargeError } from '../queries/stats-queries.js';
import type { StatsQueries } from './stats.js';
import { registerStatsRoutes } from './stats.js';

const USER = '00000000-0000-4000-8000-0000000000e9';
const PROJECT = '00000000-0000-4000-8000-0000000000b1';
const NOW = '2026-06-07T09:00:00.000Z' as IsoDateTime;

const SOURCES: StatsSources = {
  startedTasks: [
    { startedDay: '2026-06-02', intervened: false },
    { startedDay: '2026-06-03', intervened: true },
  ],
  deliveredTasks: [
    {
      mergedDay: '2026-06-03',
      cycleHours: 26,
      agentHours: 1.5,
      returns: 0,
      humanReviewEntries: 0,
      questions: 0,
      costUsd: 4.2,
      estimateUsd: 5,
      costActual: 4.2,
    },
  ],
  counters: [{ day: '2026-06-03', metric: 'rebase.resolved', count: 2, total: 0 }],
  cost: [{ day: '2026-06-03', usd: 4.2, inputTokens: 1000, cacheReadTokens: 400 }],
  estimatedSpend: [{ day: '2026-06-03', usd: 4.2, estimatedUsd: 0 }],
  questions: [{ answeredDay: '2026-06-03', minutes: 30 }],
  humanMinutes: [{ day: '2026-06-03', kind: 'review', minutes: 45 }],
  kbProposals: [{ day: '2026-06-03', applied: 3, rejected: 1 }],
  kbUsage: [{ day: '2026-06-03', eligible: 2, cited: 1 }],
  stageReturns: [{ stage: 'code_review', entries: 4, returns: 1, rate: null }],
  withheldReviewMinutes: { minutes: 0, entries: 0 },
  overlaps: [],
  loc: [],
  lintEdits: [],
  bugTraces: [],
};

interface World {
  readonly app: FastifyInstance;
  readonly asked: {
    range: ResolvedRange;
    projectId: string | null;
    timezone: string;
    asOf: string;
  }[];
  role: UserRole;
  signedIn: boolean;
}

const build = async (overrides: Partial<StatsQueries> = {}): Promise<World> => {
  const asked: World['asked'] = [];
  const world = { asked, role: 'viewer', signedIn: true } as unknown as World;

  const app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    if (world.signedIn) {
      request.actor = {
        userId: USER,
        email: 'operator@example.test',
        name: 'Operator',
        role: world.role,
        sessionId: 'session-1',
      };
    }
  });

  await registerStatsRoutes(app, {
    now: () => NOW,
    queries: {
      projectRole: async () => null,
      timezone: async () => ({ timezone: 'UTC', substituted: false }),
      sources: async (range, options) => {
        asked.push({
          range,
          projectId: options.projectId,
          timezone: options.timezone,
          asOf: options.asOf,
        });
        return SOURCES;
      },
      ...overrides,
    },
  });
  await app.ready();
  return Object.assign(world, { app });
};

describe('GET /api/org/stats', () => {
  it('refuses an anonymous caller', async () => {
    const world = await build();
    world.signedIn = false;
    const response = await world.app.inject({ method: 'GET', url: '/api/org/stats' });
    expect(
      `${response.statusCode} ${(response.json() as { error: { code: string } }).error.code}`,
    ).toBe('401 unauthenticated');
  });

  it('answers a viewer — statistics are the organisation’s own delivery performance', async () => {
    // Standing rule 10: the branch is named. `org.read` is `viewer`, and a route that had quietly
    // asked for `org.audit.read` would answer 403 here rather than failing some other assertion.
    const world = await build();
    world.role = 'viewer';
    const response = await world.app.inject({ method: 'GET', url: '/api/org/stats' });
    expect(response.statusCode).toBe(200);
  });

  it('defaults to thirty daily buckets ending today in the organisation’s zone', async () => {
    const world = await build();
    const response = await world.app.inject({ method: 'GET', url: '/api/org/stats' });
    const body = orgStatsResponseSchema.parse(response.json());

    expect(body.range).toEqual({
      range: '30d',
      bucket: 'day',
      from: '2026-05-09',
      to: '2026-06-07',
      timezone: 'UTC',
      timezone_substituted: false,
    });
    expect(world.asked[0]?.range.from).toBe('2026-05-09');
    expect(body.metrics.find((metric) => metric.id === 'tasks_delivered')?.buckets).toHaveLength(
      30,
    );
  });

  it('passes the range, the bucket and the project through to the reads', async () => {
    const world = await build();
    const response = await world.app.inject({
      method: 'GET',
      url: `/api/org/stats?range=7d&bucket=week&project_id=${PROJECT}`,
    });
    const body = orgStatsResponseSchema.parse(response.json());

    expect(body.range.range).toBe('7d');
    expect(body.range.bucket).toBe('week');
    expect(body.project_id).toBe(PROJECT);
    // `asOf` is the instant `generated_at` publishes: the lint fold's closed-window rule (WP-61)
    // and the document must name one clock.
    expect(world.asked).toEqual([
      {
        range: { range: '7d', bucket: 'week', from: '2026-06-01', to: '2026-06-07' },
        projectId: PROJECT,
        timezone: 'UTC',
        asOf: body.generated_at,
      },
    ]);
  });

  it('refuses an unknown range rather than silently widening the answer', async () => {
    const world = await build();
    const response = await world.app.inject({ method: 'GET', url: '/api/org/stats?range=all' });
    expect(response.statusCode).toBe(400);
  });

  it('refuses a range with more tasks than one answer is folded from', async () => {
    const world = await build({
      sources: async () => {
        throw new StatsRangeTooLargeError('delivered', 5_000);
      },
    });
    const response = await world.app.inject({ method: 'GET', url: '/api/org/stats' });
    const body = response.json() as { error: { code: string; message: string } };
    expect(`${response.statusCode} ${body.error.code}`).toBe('409 stats_range_too_large');
    // Named, so the caller is told what to do rather than that something went wrong.
    expect(body.error.message).toContain('narrow the range');
  });

  it('says when the organisation’s timezone was substituted', async () => {
    const world = await build({
      timezone: async () => ({ timezone: 'UTC', substituted: true }),
    });
    const body = orgStatsResponseSchema.parse(
      (await world.app.inject({ method: 'GET', url: '/api/org/stats' })).json(),
    );
    // The ledger fails open on a zone it cannot use; a dashboard that did not say so would publish
    // a month that started at a different hour than the operator configured.
    expect(body.range.timezone_substituted).toBe(true);
  });
});

describe('GET /api/org/stats.csv', () => {
  it('refuses an anonymous caller too', async () => {
    const world = await build();
    world.signedIn = false;
    const response = await world.app.inject({ method: 'GET', url: '/api/org/stats.csv' });
    expect(
      `${response.statusCode} ${(response.json() as { error: { code: string } }).error.code}`,
    ).toBe('401 unauthenticated');
  });

  it('sends text/csv with a filename built from the resolved range', async () => {
    const world = await build();
    const response = await world.app.inject({ method: 'GET', url: '/api/org/stats.csv?range=7d' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(response.headers['content-disposition']).toBe(
      'attachment; filename="agentic-stats-2026-06-01-to-2026-06-07.csv"',
    );
  });

  it('carries the same numbers as the JSON, and no row for a metric it cannot compute', async () => {
    const world = await build();
    const json = orgStatsResponseSchema.parse(
      (await world.app.inject({ method: 'GET', url: '/api/org/stats?range=7d' })).json(),
    );
    const csv = (await world.app.inject({ method: 'GET', url: '/api/org/stats.csv?range=7d' }))
      .body;
    const lines = csv.trimEnd().split('\n');

    const delivered = json.metrics.find((metric) => metric.id === 'tasks_delivered');
    expect(lines).toContainEqual(
      `tasks_delivered,Tasks delivered,count,bucket,2026-06-03,2026-06-04,${delivered?.buckets.find((bucket) => bucket.start === '2026-06-03')?.value},1,,`,
    );
    // An absent metric has exactly one row — its total, carrying the reason — and no bucket rows,
    // so nothing in a spreadsheet can sum a cell the platform never measured.
    expect(lines.filter((line) => line.startsWith('queue_wait_minutes,'))).toHaveLength(1);
  });
});
