/**
 * One broken organisation account, named once — the route case (WP-157 (a), PROGRESS backlog 413).
 *
 * `GET /api/integrations` through a real Fastify instance over PostgreSQL 18, with the production
 * check (`createOrganisationAccountCredentials`, the loader that withholds the prompt files) over
 * sealed rows. Three projects and one communication account sealed under a key this process does
 * not hold give **exactly one** `credentials_readable: false`, on the account, whatever the
 * project count — and the per-project loader names the same account for every project, which is
 * the N signals this replaces. None once the account decrypts. Every planted credential value is
 * absent from the response in both states.
 */
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { IntegrationsResponse } from '@platform/contracts';
import { integrationsResponseSchema } from '@platform/contracts';
import { db, secrets as secretAdapters } from '@platform/infrastructure';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toApiError } from '../../../apps/server/src/errors.js';
import {
  createOrganisationAccountCredentials,
  createProjectCredentials,
} from '../../../apps/server/src/knowledge.js';
import { ORGANISATION_ACCOUNT_UNREADABLE_CONSEQUENCE } from '../../../apps/server/src/queries/integration-queries.js';
import { registerIntegrationRoutes } from '../../../apps/server/src/routes/integrations.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/**
 * Fastify and its zod compilers, resolved **from `apps/server`**, for the reason
 * `read-api.integration.test.ts` measured: the root does not depend on them, and adding them there
 * resolves a second peer variant of `fastify-type-provider-zod`.
 */
const fromServer = createRequire(new URL('../../../apps/server/package.json', import.meta.url));
type App = Parameters<typeof registerIntegrationRoutes>[0];
const fastify = fromServer('fastify') as () => App;
const { serializerCompiler, validatorCompiler } = fromServer('fastify-type-provider-zod') as {
  // biome-ignore lint/suspicious/noExplicitAny: the compilers' own types live in apps/server's graph.
  readonly serializerCompiler: any;
  // biome-ignore lint/suspicious/noExplicitAny: as above.
  readonly validatorCompiler: any;
};

const SECRET = 'not-a-real-app-secret-key-wp157-0000000000';
const OTHER_SECRET = 'also-not-a-real-app-secret-key-wp157-11111';
const KEY = secretAdapters.deriveSecretKey(SECRET);
const OTHER_KEY = secretAdapters.deriveSecretKey(OTHER_SECRET);

const BROKEN_TOKEN = 'xoxb-FAKE-wp157-broken-organisation-bot-token';
const READABLE_TOKEN = 'xoxb-FAKE-wp157-readable-organisation-bot-token';
const GIT_TOKEN = 'glpat-FAKE-wp157-git-binding-token-0001';
const CONFIG_PASTED = 'FAKE-wp157-signing-secret-pasted-into-config';

let database: MigratedDatabase;
let pool: pg.Pool;
let app: App;
let brokenId: string;
let brokenSecretId: string;
const projectIds: string[] = [];

const seal = async (key: typeof KEY, field: string, value: string): Promise<string> => {
  const id = randomUUID();
  await pool.query('insert into secrets (id, ciphertext, key_id) values ($1, $2, $3)', [
    id,
    secretAdapters.sealSecret(key, secretAdapters.secretDocument(field, value), id),
    key.keyId,
  ]);
  return id;
};

const insertIntegration = async (
  orgId: string,
  type: string,
  provider: string,
  name: string,
  config: Record<string, unknown>,
  secretIds: readonly string[],
): Promise<string> => {
  const { rows } = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
     values ($1, $2::integration_type, $3, $4, $5::jsonb, $6::uuid[]) returning id`,
    [orgId, type, provider, name, JSON.stringify(config), secretIds],
  );
  return rows[0]?.id as string;
};

beforeAll(async () => {
  database = await createMigratedDatabase('organisation-credentials');
  pool = createTestPool(database.connectionString, { max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('wp157') returning id",
  );
  const orgId = org.rows[0]?.id as string;
  for (const key of ['one', 'two', 'three']) {
    const project = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, $2, 'https://git.example.test/acme/' || $2 || '.git') returning id`,
      [orgId, key],
    );
    projectIds.push(project.rows[0]?.id as string);
  }
  // The broken organisation account: sealed under a key this process does not hold.
  brokenSecretId = await seal(OTHER_KEY, 'bot_token', BROKEN_TOKEN);
  brokenId = await insertIntegration(
    orgId,
    'communication',
    'slack',
    'old slack',
    { channel: 'C0FAKE', signing_secret: CONFIG_PASTED },
    [brokenSecretId],
  );
  await insertIntegration(orgId, 'communication', 'slack', 'acme slack', { channel: 'C0FAKE2' }, [
    await seal(KEY, 'bot_token', READABLE_TOKEN),
  ]);
  // A bound account of another type, readable, on every project: not an organisation account.
  const gitId = await insertIntegration(
    orgId,
    'git',
    'gitlab',
    'acme gitlab',
    { base_url: 'https://gitlab.example.test' },
    [await seal(KEY, 'token', GIT_TOKEN)],
  );
  for (const projectId of projectIds) {
    await pool.query(
      `insert into bindings (project_id, integration_id, config) values ($1, $2, '{"project":"acme/x"}'::jsonb)`,
      [projectId, gitId],
    );
  }

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
    organisationCredentials: createOrganisationAccountCredentials(pool, SECRET),
  });
}, 180_000);

afterAll(async () => {
  await app?.close();
  await pool?.end();
  await database?.drop();
});

const list = async (): Promise<{ body: string; parsed: IntegrationsResponse }> => {
  const response = await app.inject({ method: 'GET', url: '/api/integrations' });
  expect(response.statusCode).toBe(200);
  return { body: response.body, parsed: integrationsResponseSchema.parse(response.json()) };
};

const planted = [BROKEN_TOKEN, READABLE_TOKEN, GIT_TOKEN, CONFIG_PASTED];

describe('GET /api/integrations and an organisation account that will not decrypt (WP-157 (a))', () => {
  it('names the broken account once, whatever the project count, and carries no value', async () => {
    const { body, parsed } = await list();
    const unreadable = parsed.items.filter((item) => item.credentials_readable === false);
    expect(unreadable.map((item) => item.id)).toEqual([brokenId]);
    expect(unreadable[0]?.credentials_consequence).toBe(
      ORGANISATION_ACCOUNT_UNREADABLE_CONSEQUENCE,
    );
    // The readable organisation account is `true`; the git account is not an organisation
    // account and is unchecked (`null`), never reported readable.
    expect(
      Object.fromEntries(parsed.items.map((item) => [item.name, item.credentials_readable])),
    ).toEqual({ 'old slack': false, 'acme slack': true, 'acme gitlab': null });
    for (const value of planted) {
      expect(body, value).not.toContain(value);
    }
    // The rows parse, so nothing above is a refusal standing in for an answer.
    expect(parsed.items.map((item) => item.config_refusal)).toEqual([null, null, null]);
    // The N signals this replaces: every project's reading names the same account.
    const credentials = createProjectCredentials(pool, SECRET);
    for (const projectId of projectIds) {
      const answer = await credentials(projectId as never);
      expect(answer.unreadable.map((entry) => entry.integration)).toEqual([
        `integration "old slack" (slack, ${brokenId})`,
      ]);
    }
  });

  it('names none once the account decrypts', async () => {
    await pool.query('update secrets set ciphertext = $2, key_id = $3 where id = $1', [
      brokenSecretId,
      secretAdapters.sealSecret(
        KEY,
        secretAdapters.secretDocument('bot_token', BROKEN_TOKEN),
        brokenSecretId,
      ),
      KEY.keyId,
    ]);
    const { body, parsed } = await list();
    expect(parsed.items.filter((item) => item.credentials_readable === false)).toEqual([]);
    expect(parsed.items.every((item) => item.credentials_consequence === null)).toBe(true);
    for (const value of planted) {
      expect(body, value).not.toContain(value);
    }
  });
});
