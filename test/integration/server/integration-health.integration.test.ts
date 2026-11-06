/**
 * An integration's health from its traffic, and who uses it — S-25.3, product/08's 2026-11-06
 * amendment — through `GET /api/integrations` on a real Fastify instance over PostgreSQL 18.
 *
 * The rows are written the way the platform writes them (`integration_actions` by the audit log,
 * `inbox` by the ingress, `bindings` by a project's connections), relative to the database's
 * `now()` and inside the harness's 14-day stale-write window. Each integration reaches one verdict:
 *
 * - *Jira*: an `ok` call an hour ago behind a newer **shadow** (`would_have`) row and a newer
 *   **unverified** delivery — neither is evidence — so `working`, with the call and the verified
 *   delivery as its activity; bound to two projects, each with its own use.
 * - *Old probe*: a passed *Test connection* two days ago and nothing since — `not_checked_recently`,
 *   never `working`.
 * - *Flaky*: a success three hours ago and a failure one hour ago — `degraded`.
 * - *Quiet*: nothing at all — `never_checked`, used by nobody.
 *
 * The last case holds the delivery read to its index (migration 0103): with sequential scans
 * switched off for one transaction, the plan of the probe the projection runs names
 * `inbox_verified_integration_idx`, so dropping the migration fails here by name.
 */
import { createRequire } from 'node:module';
import type { IntegrationSummary } from '@platform/contracts';
import { integrationsResponseSchema } from '@platform/contracts';
import { db } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toApiError } from '../../../apps/server/src/errors.js';
import { registerIntegrationRoutes } from '../../../apps/server/src/routes/integrations.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** Fastify and its zod compilers, resolved from `apps/server` (`read-api.integration.test.ts`). */
const fromServer = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
type App = Parameters<typeof registerIntegrationRoutes>[0];
const fastify = fromServer('fastify') as () => App;
const { serializerCompiler, validatorCompiler } = fromServer('fastify-type-provider-zod') as {
  // biome-ignore lint/suspicious/noExplicitAny: the compilers' own types live in apps/server's graph.
  readonly serializerCompiler: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  readonly validatorCompiler: any;
};

let database: MigratedDatabase;
let pool: pg.Pool;
let app: App;
const ids: Record<'jira' | 'probe' | 'flaky' | 'quiet', string> = {
  jira: '',
  probe: '',
  flaky: '',
  quiet: '',
};

const insertIntegration = async (
  orgId: string,
  type: string,
  provider: string,
  name: string,
  config: Record<string, unknown>,
  health: Record<string, unknown> = {},
): Promise<string> => {
  const { rows } = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, health)
     values ($1, $2::integration_type, $3, $4, $5::jsonb, $6::jsonb) returning id`,
    [orgId, type, provider, name, JSON.stringify(config), JSON.stringify(health)],
  );
  return rows[0]?.id as string;
};

/** One audit row, `hours` before the database's now. */
const call = async (integrationId: string, status: string, hours: number): Promise<void> => {
  await pool.query(
    `insert into integration_actions
       (integration_id, direction, action, payload, result, status, attempts, redaction_count,
        created_at)
     values ($1, 'out', 'read_ticket', '{}'::jsonb, '{}'::jsonb, $2, 1, 0,
             now() - make_interval(secs => $3::float8 * 3600))`,
    [integrationId, status, hours],
  );
};

const delivery = async (
  integrationId: string,
  deliveryId: string,
  verified: boolean,
  hours: number,
): Promise<void> => {
  await pool.query(
    `insert into inbox
       (provider, delivery_id, integration_id, received_at, headers, payload, processed_at,
        redaction_count, verified)
     values ('jira-cloud', $2, $1, now() - make_interval(secs => $4::float8 * 3600), '{}'::jsonb,
             '{}'::jsonb, now(), 0, $3)`,
    [integrationId, deliveryId, verified, hours],
  );
};

beforeAll(async () => {
  database = await createMigratedDatabase('integration-health');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('s253') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  const project = async (key: string, name: string): Promise<string> => {
    const { rows } = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, $3, 'https://git.example.test/acme/' || $2 || '.git') returning id`,
      [orgId, key, name],
    );
    return rows[0]?.id as string;
  };
  const autix = await project('autix', 'Autix');
  const demo = await project('demo', 'Demo');

  ids.jira = await insertIntegration(orgId, 'task_management', 'jira-cloud', 'Autix Jira', {
    site_url: 'https://acme.atlassian.example.test',
    user_email: 'ops@example.test',
    project_keys: ['AUT'],
  });
  await call(ids.jira, 'failed', 72);
  await call(ids.jira, 'ok', 1);
  // Newer, and evidence of nothing: shadow mode reached nobody, an unverified delivery is a guess.
  await call(ids.jira, 'would_have', 0.1);
  await delivery(ids.jira, 'jira:verified-1', true, 2);
  await delivery(ids.jira, 'jira:unverified-1', false, 0.05);
  // Autix reads the account's keys; Demo narrows them and picks up by status.
  await pool.query(
    `insert into bindings (project_id, integration_id, config)
     values ($1, $3, '{}'::jsonb), ($2, $3, '{"project_keys":["DEM"],"pickup_status":"Ready"}'::jsonb)`,
    [autix, demo, ids.jira],
  );

  ids.probe = await insertIntegration(
    orgId,
    'git',
    'gitlab',
    'Old probe',
    { base_url: 'https://gitlab.example.test' },
    {
      status: 'ok',
      checked_at: new Date(Date.now() - 48 * 3_600_000).toISOString(),
      detail: null,
    },
  );
  ids.flaky = await insertIntegration(orgId, 'git', 'gitlab', 'Flaky', {
    base_url: 'https://gitlab.example.test',
  });
  await call(ids.flaky, 'ok', 3);
  await call(ids.flaky, 'failed', 1);
  ids.quiet = await insertIntegration(orgId, 'communication', 'slack', 'Quiet', {
    channel: '#agentic',
  });

  app = fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler(async (error: unknown, _request, reply) => {
    const mapped = toApiError(error, 'test-request');
    return reply.status(mapped.statusCode).send(mapped.body);
  });
  app.addHook('onRequest', async (request) => {
    request.actor = {
      userId: '00000000-0000-4000-8000-0000000000e9',
      email: 'operator@example.test',
      name: 'Operator',
      role: 'maintainer',
      sessionId: 'session-1',
    };
  });
  await registerIntegrationRoutes(app, {
    database: drizzle(pool, { schema: db.schema }),
    baseUrl: 'https://agentic.example.test',
    organisationCredentials: null,
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await database?.drop();
});

const listed = async (): Promise<Map<string, IntegrationSummary>> => {
  const response = await app.inject({ method: 'GET', url: '/api/integrations' });
  expect(response.statusCode).toBe(200);
  const parsed = integrationsResponseSchema.parse(response.json());
  return new Map(parsed.items.map((item) => [item.id, item]));
};

/** Hours between an instant and now, rounded to a tenth. */
const hoursAgo = (at: string | null | undefined): number | null =>
  at === null || at === undefined ? null : Math.round((Date.now() - Date.parse(at)) / 360_000) / 10;

describe('GET /api/integrations — health from traffic (S-25.3)', () => {
  it('reads working from the newest real call, past a shadow row and an unverified delivery', async () => {
    const jira = (await listed()).get(ids.jira);
    expect(jira?.current_health.status).toBe('working');
    expect(jira?.current_health.basis).toBe('call');
    expect(hoursAgo(jira?.current_health.at)).toBe(1);
    expect(jira?.activity.last_call?.ok).toBe(true);
    expect(hoursAgo(jira?.activity.last_call?.at)).toBe(1);
    expect(hoursAgo(jira?.activity.last_delivery_at)).toBe(2);
  });

  it('reads a passed probe two days old with nothing since as not checked recently', async () => {
    const probe = (await listed()).get(ids.probe);
    expect(probe?.health.status).toBe('ok');
    expect(probe?.current_health).toMatchObject({ status: 'not_checked_recently', basis: 'probe' });
    expect(probe?.activity).toEqual({ last_call: null, last_delivery_at: null });
  });

  it('reads a failure after a success inside the bound as degraded', async () => {
    const flaky = (await listed()).get(ids.flaky);
    expect(flaky?.current_health).toMatchObject({ status: 'degraded', basis: 'call' });
    expect(flaky?.activity.last_call?.ok).toBe(false);
  });

  it('reads an integration with no traffic and no probe as never checked, used by nobody', async () => {
    const quiet = (await listed()).get(ids.quiet);
    expect(quiet?.current_health).toEqual({ status: 'never_checked', basis: null, at: null });
    expect(quiet?.used_by).toEqual([]);
  });
});

describe('GET /api/integrations — who uses it (S-25.3)', () => {
  it('names each binding project by key with its own use, the binding over the account', async () => {
    const jira = (await listed()).get(ids.jira);
    expect(jira?.used_by.map((user) => [user.project_key, user.project_name, user.uses])).toEqual([
      [
        'autix',
        'Autix',
        [
          { label: 'Tickets from', value: 'AUT' },
          { label: 'Picked up with label', value: 'agentic' },
        ],
      ],
      [
        'demo',
        'Demo',
        [
          { label: 'Tickets from', value: 'DEM' },
          { label: 'Picked up at status', value: 'Ready' },
        ],
      ],
    ]);
  });
});

describe('the newest-delivery probe and its index (migration 0103)', () => {
  it('is answered from inbox_verified_integration_idx', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query('set local enable_seqscan = off');
      const { rows } = await client.query<{ 'QUERY PLAN': string }>(
        `explain select b.received_at from inbox b
          where b.integration_id = $1 and b.verified
          order by b.received_at desc limit 1`,
        [ids.jira],
      );
      expect(rows.map((row) => row['QUERY PLAN']).join('\n')).toContain(
        'inbox_verified_integration_idx',
      );
    } finally {
      await client.query('rollback');
      client.release();
    }
  });
});
