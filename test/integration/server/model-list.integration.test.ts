/**
 * The organisation's model list against a real PostgreSQL 18 after every migration (WP-159).
 *
 * `listedModelIds` (`apps/server/src/queries/cost-queries.ts`) is the one query behind both halves
 * of ruling (a) and (b): `GET /api/org/models` publishes it, and the retry command's
 * `ModelCatalogue` asks it about one id. So this file measures the definition on the migrated
 * schema — the seed answers, a closed window and a window that opens later do not — and holds the
 * shipped defaults to the seed (criterion 5), so a default model cannot fall out of the list the
 * retry offers and checks.
 */
import { createRequire } from 'node:module';
import {
  DEFAULT_ASK_MODEL,
  FALLBACK_STAGE_AGENT_DEFAULTS,
  STAGE_AGENT_DEFAULTS,
} from '@platform/domain';
import { db } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toApiError } from '../../../apps/server/src/errors.js';
import { listedModelIds } from '../../../apps/server/src/queries/cost-queries.js';
import { registerOrgRoutes } from '../../../apps/server/src/routes/org.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/**
 * Fastify and its zod compilers, resolved **from `apps/server`**, for the reason
 * `read-api.integration.test.ts` measured: the root does not depend on them, and adding them there
 * resolves a second peer variant of `fastify-type-provider-zod`.
 */
const fromServer = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
const fastify = fromServer('fastify') as () => Parameters<typeof registerOrgRoutes>[0];
const { serializerCompiler, validatorCompiler } = fromServer('fastify-type-provider-zod') as {
  // biome-ignore lint/suspicious/noExplicitAny: the compilers' own types live in apps/server's graph.
  readonly serializerCompiler: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  readonly validatorCompiler: any;
};

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;

/** What migration 0009 seeds, sorted as the query orders them. */
const SEED = ['claude-fable-5-1', 'claude-haiku-4-5', 'claude-opus-5', 'claude-sonnet-5'];

const price = async (modelId: string, from: string, to: string | null): Promise<void> => {
  await pool.query(
    `insert into price_list (model_id, effective_from, effective_to, input, output, cache_write_5m,
                             cache_write_1h, cache_read, source_url, verified_at)
     values ($1, $2, $3, 1, 1, 1, 1, 1, 'https://pricing.example.invalid', $2)`,
    [modelId, from, to],
  );
};

beforeAll(async () => {
  database = await createMigratedDatabase('model-list');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  drizzled = drizzle(pool, { schema: db.schema });
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('the model list after every migration (WP-159)', () => {
  it('answers the seed’s ids, ordered, on a fresh database', async () => {
    expect(await listedModelIds(drizzled, new Date())).toEqual(SEED);
  });

  it('serves the seed’s ids through the route, to a viewer, bound as the composition root binds it', async () => {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    app.setErrorHandler(async (error: unknown, _request, reply) => {
      const mapped = toApiError(error, 'test-request');
      return reply.status(mapped.statusCode).send(mapped.body);
    });
    app.addHook('onRequest', async (request) => {
      request.actor = {
        userId: '00000000-0000-4000-8000-0000000000a1',
        email: 'viewer@example.test',
        name: 'Viewer',
        role: 'viewer',
        sessionId: 'session-1',
      };
    });
    await registerOrgRoutes(app, {
      database: drizzled,
      identities: {} as never,
      // `apps/server/src/app.ts`'s binding, verbatim.
      models: async () => listedModelIds(drizzled, new Date()),
    });
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: '/api/org/models' });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ models: SEED.map((model_id) => ({ model_id })) });
    } finally {
      await app.close();
    }
  });

  it('lists every shipped default model, so a default cannot fall out of the list (criterion 5)', async () => {
    const defaults = new Set([
      ...Object.values(STAGE_AGENT_DEFAULTS).map((row) => row.model),
      FALLBACK_STAGE_AGENT_DEFAULTS.model,
      DEFAULT_ASK_MODEL,
    ]);
    // The scope, asserted before anything is concluded from it (standing rule 4).
    expect(defaults.size).toBeGreaterThanOrEqual(3);
    const listed = await listedModelIds(drizzled, new Date());
    expect([...defaults].filter((model) => !listed.includes(model))).toEqual([]);
  });

  it('leaves out a closed window and a window that opens later, and lists a superseded id once', async () => {
    await price('claude-fake-closed', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z');
    await price('claude-fake-later', '2099-01-01T00:00:00Z', null);
    await price('claude-fake-superseded', '2026-01-01T00:00:00Z', '2026-03-01T00:00:00Z');
    await price('claude-fake-superseded', '2026-03-01T00:00:00Z', null);
    // A window whose end is still ahead is open now.
    await price('claude-fake-ending', '2026-01-01T00:00:00Z', '2099-01-01T00:00:00Z');

    const listed = await listedModelIds(drizzled, new Date());
    expect(listed).toEqual([...SEED, 'claude-fake-ending', 'claude-fake-superseded'].sort());
    // The same definition answers the retry's one-id question.
    expect(await listedModelIds(drizzled, new Date(), 'claude-fake-superseded')).toEqual([
      'claude-fake-superseded',
    ]);
    expect(await listedModelIds(drizzled, new Date(), 'claude-fake-closed')).toEqual([]);
    expect(await listedModelIds(drizzled, new Date(), 'claude-fake-later')).toEqual([]);
    // …and at an instant inside the closed window, that window is the open one.
    expect(
      await listedModelIds(drizzled, new Date('2026-01-15T00:00:00Z'), 'claude-fake-closed'),
    ).toEqual(['claude-fake-closed']);
  });

  it('treats a window as half-open: one that ends exactly at the instant is closed', async () => {
    const at = new Date('2026-05-01T00:00:00Z');
    await price('claude-fake-edge', '2026-04-01T00:00:00Z', at.toISOString());
    expect(await listedModelIds(drizzled, at, 'claude-fake-edge')).toEqual([]);
    expect(await listedModelIds(drizzled, new Date(at.getTime() - 1), 'claude-fake-edge')).toEqual([
      'claude-fake-edge',
    ]);
  });

  it('does not list an id the retry would refuse as too long', async () => {
    const long = `claude-${'x'.repeat(130)}`;
    await price(long, '2026-01-01T00:00:00Z', null);
    expect(await listedModelIds(drizzled, new Date())).not.toContain(long);
  });
});
