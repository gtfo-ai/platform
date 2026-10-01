/**
 * The two routes that append to a project's stream answer a lost race as a retryable `409`, through
 * the real router — WP-109 review round 1 (PROGRESS backlog 357).
 *
 * `appendOnProjectWithRetry` retries a lost race in place, so only the bound's last loss reaches a
 * route; `projectStreamContention` (`../errors.ts`) maps it, and each route has to *call* the mapper.
 * That wiring is what this file holds: the mapper's own unit case is green whether or not either
 * route uses it (the reviewer replaced the interview's `throw projectStreamContention(error) ??
 * error` with `throw error` and 967 unit tests stayed green). The command is stubbed to throw the
 * conflict, so the router, the permission guard, the idempotency read and the error handler are the
 * production ones.
 *
 * **The database is a stub keyed by table**: each route reads a handful of rows through drizzle's
 * chain (`select … from … where … limit`), and this answers each by the table passed to `from`. A
 * query against a table it was not given answers no rows, so a route that started reading
 * something new would see an empty answer here rather than a convenient one.
 */
import { StreamConflictError } from '@platform/application';
import type { Id } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { type FastifyInstance, fastify } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { afterEach, describe, expect, it } from 'vitest';
import { toApiError } from '../errors.js';
import type { KnowledgeCommands } from '../knowledge.js';
import type { OnboardingCommands } from '../onboarding.js';
import type { Database } from '../queries/identity-queries.js';
import { registerKbRoutes } from './kb.js';
import { registerOnboardingRoutes } from './onboarding.js';

const PROJECT = '00000000-0000-4000-8000-000000000e01';
const PROPOSAL = '00000000-0000-4000-8000-000000000e02';
const USER = '00000000-0000-4000-8000-000000000e03';
const AT = new Date('2026-09-27T04:00:00.000Z');

const { projectMembers, projects } = dbAdapters.schema;

/** A drizzle-shaped read that answers by the table it is `from`. */
const tableDatabase = (answers: ReadonlyMap<unknown, readonly unknown[]>): Database => {
  const chain = (rows: readonly unknown[]): unknown =>
    new Proxy(
      {},
      {
        get: (_target, property) => {
          if (property === 'then') {
            return (resolve: (value: unknown) => void) => resolve(rows);
          }
          if (property === 'from') {
            return (table: unknown) => chain(answers.get(table) ?? []);
          }
          return () => chain(rows);
        },
      },
    );
  return { select: () => chain([]) } as unknown as Database;
};

const database = tableDatabase(
  new Map<unknown, readonly unknown[]>([
    [projectMembers, [{ role: 'maintainer' }]],
    [
      projects,
      [
        {
          id: PROJECT,
          key: 'api',
          name: 'API',
          repoUrl: 'https://git.example.test/acme/api.git',
          defaultBranch: 'main',
          agenticDir: '.agentic',
          knowledgeDir: '.agentic/knowledge',
          autonomyLevel: 'supervised',
          readinessLevel: 0,
          status: 'active',
          createdAt: AT,
          updatedAt: AT,
        },
      ],
    ],
  ]),
);

const conflict = (): never => {
  throw new StreamConflictError('project', PROJECT, 7);
};

let app: FastifyInstance | undefined;

const build = async (register: (app: FastifyInstance) => Promise<void>) => {
  const instance = fastify();
  instance.setValidatorCompiler(validatorCompiler);
  instance.setSerializerCompiler(serializerCompiler);
  instance.setErrorHandler(async (error, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  instance.addHook('onRequest', async (request) => {
    request.actor = {
      userId: USER,
      email: 'operator@example.test',
      name: 'Operator',
      // `member` at the organisation, so the project role (the stub's `maintainer`) decides.
      role: 'member',
      sessionId: 'session-1',
    };
  });
  await register(instance);
  await instance.ready();
  app = instance;
  return instance;
};

afterEach(async () => {
  await app?.close();
  app = undefined;
});

const codeOf = (body: string): string =>
  (JSON.parse(body) as { error?: { code?: string } }).error?.code ?? '';

describe('a project-stream race the retry could not win, at the route', () => {
  it('answers the business interview with 409 project_stream_contended, never a 500', async () => {
    const calls: unknown[] = [];
    const instance = await build((target) =>
      registerOnboardingRoutes(target, {
        database,
        secretKey: 'FAKE-app-secret-key-for-tests-only-000000',
        onboarding: {
          recordInterview: async (input: unknown) => {
            calls.push(input);
            return conflict();
          },
        } as unknown as OnboardingCommands,
      }),
    );
    const response = await instance.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/interview`,
      headers: { 'content-type': 'application/json', 'idempotency-key': 'interview-1' },
      payload: { answers: { glossary: { status: 'answered', text: 'Ledger.' } } },
    });
    expect(calls).toHaveLength(1);
    expect(response.statusCode, response.body).toBe(409);
    expect(codeOf(response.body)).toBe('project_stream_contended');
  });

  it('answers a knowledge decision with 409 project_stream_contended, never a 500', async () => {
    const calls: unknown[] = [];
    const instance = await build((target) =>
      registerKbRoutes(target, {
        database,
        knowledge: {
          decide: async (input: unknown) => {
            calls.push(input);
            return conflict();
          },
          list: async () => [],
        } as unknown as KnowledgeCommands,
      }),
    );
    const response = await instance.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/kb/proposals/${PROPOSAL}/reject`,
      headers: { 'content-type': 'application/json' },
      payload: { decision: 'reject', reason: 'not true' },
    });
    expect(calls).toHaveLength(1);
    expect(response.statusCode, response.body).toBe(409);
    expect(codeOf(response.body)).toBe('project_stream_contended');
  });

  it('keeps any other failure of the command a 500 (the other side, rule 42)', async () => {
    const instance = await build((target) =>
      registerKbRoutes(target, {
        database,
        knowledge: {
          decide: async () => {
            throw new StreamConflictError('task', PROPOSAL as Id, 3);
          },
          list: async () => [],
        } as unknown as KnowledgeCommands,
      }),
    );
    const response = await instance.inject({
      method: 'POST',
      url: `/api/projects/${PROJECT}/kb/proposals/${PROPOSAL}/reject`,
      headers: { 'content-type': 'application/json' },
      payload: { decision: 'reject' },
    });
    expect(response.statusCode).toBe(500);
    expect(codeOf(response.body)).toBe('internal_error');
  });
});
