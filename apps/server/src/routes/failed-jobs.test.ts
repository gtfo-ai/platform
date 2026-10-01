/**
 * The failed-jobs read, driven through Fastify against a plain function (WP-108, PROGRESS backlog
 * 325).
 *
 * `test/integration/jobs/failed-jobs.integration.test.ts` reads a job real pg-boss failed; what this
 * file owns is what the route decides: the admin gate, the error's redaction and then its bound, the
 * census row beside each job (and `null` for a queue this build does not declare), the limit, and
 * the `503` of a process that reads no job queue.
 */
import type { UserRole } from '@platform/contracts';
import { MAX_FAILED_JOB_ERROR_CHARS } from '@platform/contracts';
import { redaction } from '@platform/infrastructure';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { beforeEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import {
  DEFAULT_FAILED_JOBS_PAGE,
  type FailedJobRecord,
  registerFailedJobRoutes,
} from './failed-jobs.js';

const USER = '00000000-0000-4000-8000-000000000e11';
/** Obviously fake, and in the shape the platform's patterns catch. */
const FAKE_TOKEN = 'glpat-FAKE000000000000000';

const record = (overrides: Partial<FailedJobRecord> = {}): FailedJobRecord => ({
  id: '00000000-0000-4000-8000-000000000f01',
  queue: 'pipeline.outbound',
  attempts: 3,
  retryLimit: 2,
  createdAt: '2026-09-30T08:00:00.000Z',
  failedAt: '2026-09-30T08:48:00.000Z',
  error: `provider answered 401 for token ${FAKE_TOKEN}`,
  ...overrides,
});

interface World {
  role: UserRole;
  signedIn: boolean;
  rows: FailedJobRecord[];
  total: number;
}

let app: FastifyInstance;
let world: World;
let asked: { limit: number }[];

const build = async (composed = true): Promise<void> => {
  asked = [];
  world = { role: 'admin', signedIn: true, rows: [record()], total: 1 };
  app = fastify();
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
  await registerFailedJobRoutes(app, {
    read: composed
      ? async (query) => {
          asked.push({ limit: query.limit });
          return { items: world.rows, total: world.total };
        }
      : null,
    projectRole: async () => null,
    redactor: redaction.patternRedactor(),
  });
  await app.ready();
};

beforeEach(async () => build());

const list = (query = '') => app.inject({ method: 'GET', url: `/api/org/failed-jobs${query}` });
const codeOf = (raw: string): string =>
  (JSON.parse(raw) as { error?: { code?: string } }).error?.code ?? '';

describe('GET /api/org/failed-jobs (WP-108, backlog 325)', () => {
  it.each(['viewer', 'member', 'maintainer'] as const)(
    'refuses a %s and reads nothing',
    async (role) => {
      world.role = role;
      const response = await list();
      expect(response.statusCode).toBe(403);
      expect(asked).toEqual([]);
    },
  );

  it('refuses an anonymous caller before anything is read', async () => {
    world.signedIn = false;
    expect((await list()).statusCode).toBe(401);
    expect(asked).toEqual([]);
  });

  it('publishes the job with its error redacted, the census row beside it, and no payload', async () => {
    const response = await list();
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.total).toBe(1);
    expect(body.items).toHaveLength(1);
    const [job] = body.items;
    expect(job).toMatchObject({
      queue: 'pipeline.outbound',
      attempts: 3,
      retry_limit: 2,
      failed_at: '2026-09-30T08:48:00.000Z',
      error_truncated: false,
      exhaustion: { kind: 'relies_on_retries' },
    });
    expect(job.error).toContain('provider answered 401');
    expect(response.body).not.toContain(FAKE_TOKEN);
    expect(Object.keys(job)).not.toContain('data');
    expect(Object.keys(job)).not.toContain('payload');
    expect(asked).toEqual([{ limit: DEFAULT_FAILED_JOBS_PAGE }]);
  });

  it('bounds the error after redacting it, and says the bound cut it', async () => {
    world.rows = [record({ error: `${FAKE_TOKEN} ${'x'.repeat(MAX_FAILED_JOB_ERROR_CHARS * 2)}` })];
    const job = (await list()).json().items[0];
    expect(job.error).toHaveLength(MAX_FAILED_JOB_ERROR_CHARS);
    expect(job.error).not.toContain(FAKE_TOKEN);
    expect(job.error_truncated).toBe(true);
  });

  it('names a queue this build does not declare with no census row, and a job with no message', async () => {
    world.rows = [record({ queue: 'budget.window.reset', error: null })];
    const job = (await list()).json().items[0];
    expect(job).toMatchObject({ queue: 'budget.window.reset', error: null, exhaustion: null });
  });

  it('passes the caller’s limit and refuses one past the page', async () => {
    await list('?limit=5');
    expect(asked).toEqual([{ limit: 5 }]);
    expect((await list('?limit=101')).statusCode).toBe(400);
  });

  it('answers 503 by name on a process that reads no job queue', async () => {
    await build(false);
    const response = await list();
    expect(response.statusCode).toBe(503);
    expect(codeOf(response.body)).toBe('failed_jobs_unavailable');
  });
});
