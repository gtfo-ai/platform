/**
 * **A deploy key is refused at every write that could make it wrong** — WP-146, TD-028 decision 13b
 * item 1, against a real PostgreSQL 18, at the same doors WP-137 measured for a static run token
 * (`static-run-credential.integration.test.ts`): the create, the bindings `PUT`.
 *
 *  - a key with a passphrase, a key that is not the declared public key's, no key at all, a key beside
 *    `mint_credentials: true`, a key beside a run token, and a self-managed host — each by name, with
 *    nothing written;
 *  - a second project's binding of a deploy-key integration (409);
 *  - the published configuration never carries the private key; and migration 0081 admits
 *    `runs.credential_source = 'deploy_key'` and nothing new besides.
 */
import {
  allowAnyIntegrationHost,
  encodeOpenSshKey,
  FAKE_DEPLOY_KEY,
  RFC8032_TEST1,
} from '@platform/application';
import type { IntegrationType, JsonObject } from '@platform/contracts';
import { secrets as secretAdapters } from '@platform/infrastructure';
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  findIntegrationRow,
  toIntegrationSummary,
} from '../../../apps/server/src/queries/integration-queries.js';
import {
  createIntegration,
  environmentSecretSource,
  replaceProjectBindings,
} from '../../../apps/server/src/queries/onboarding-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** Obviously fake (BD-002); the key is built from RFC 8032's published test seed. */
const API_TOKEN = 'glpat-FAKE-wp146-binding-api-token-00000';
const RUN_TOKEN = 'glpat-FAKE-wp146-static-run-token-000000';
const SECRET_KEY = 'not-a-real-app-secret-key-wp146-000000000';
const NOW = new Date('2026-10-04T12:00:00.000Z');
const ENCRYPTED = encodeOpenSshKey({
  seed: RFC8032_TEST1.seed,
  publicKey: RFC8032_TEST1.publicKey,
  cipher: 'aes256-ctr',
});
const KEY_LINE = FAKE_DEPLOY_KEY.privateKey.trim().split('\n')[3] ?? '';

const gitlab = SHIPPED_PROVIDERS.find((entry) => entry.id === 'gitlab');

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let orgId: string;
const projects: string[] = [];

const key = secretAdapters.deriveSecretKey(SECRET_KEY);
const source = environmentSecretSource(
  { API_TOKEN, RUN_TOKEN, DEPLOY_KEY: FAKE_DEPLOY_KEY.privateKey, ENCRYPTED_KEY: ENCRYPTED },
  async () => '',
  ['API_TOKEN', 'RUN_TOKEN', 'DEPLOY_KEY', 'ENCRYPTED_KEY'],
);

const DEPLOY_KEY = {
  base_url: 'https://gitlab.com',
  run_credential: 'deploy_key',
  run_ssh_public_key: FAKE_DEPLOY_KEY.publicKey,
} as const;

const create = async (
  name: string,
  config: JsonObject,
  secretRefs: Readonly<Record<string, string>>,
): Promise<string> => {
  if (gitlab === undefined) {
    throw new Error('this build ships a gitlab provider');
  }
  const result = await createIntegration(db, {
    orgId,
    integration: { type: 'git' as IntegrationType, provider: 'gitlab', name, config, secretRefs },
    provider: gitlab,
    egress: allowAnyIntegrationHost(),
    secretSource: source,
    secretKey: key,
    newId: () => crypto.randomUUID(),
    now: NOW,
  });
  return result.integration.id;
};

const integrationCount = async (): Promise<number> =>
  (await pool.query<{ count: number }>('select count(*)::int as count from integrations')).rows[0]
    ?.count ?? -1;

beforeAll(async () => {
  database = await createMigratedDatabase('deploy-key-run-credential');
  pool = createTestPool(database.connectionString, { max: 4 });
  db = drizzle(pool) as unknown as Database;
  orgId =
    (
      await pool.query<{ id: string }>(
        "insert into organizations (name) values ('wp146') returning id",
      )
    ).rows[0]?.id ?? '';
  for (const projectKey of ['autix', 'other']) {
    projects.push(
      (
        await pool.query<{ id: string }>(
          `insert into projects (org_id, key, name, repo_url)
           values ($1, $2, $2, 'https://gitlab.com/acme/' || $2 || '.git') returning id`,
          [orgId, projectKey],
        )
      ).rows[0]?.id ?? '',
    );
  }
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('declaring a deploy key (WP-146, TD-028 decision 13b)', () => {
  it('refuses each broken create by name, never quoting the key, and writes nothing', async () => {
    const before = await integrationCount();
    const refusals: [string, JsonObject, Record<string, string>, RegExp][] = [
      ['no key', { ...DEPLOY_KEY }, { token: 'API_TOKEN' }, /needs the private key itself/],
      [
        'a passphrase',
        { ...DEPLOY_KEY },
        { token: 'API_TOKEN', run_ssh_private_key: 'ENCRYPTED_KEY' },
        /protected by a passphrase/,
      ],
      [
        'a mismatched public key',
        {
          ...DEPLOY_KEY,
          run_ssh_public_key:
            'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
        },
        { token: 'API_TOKEN', run_ssh_private_key: 'DEPLOY_KEY' },
        /not the private key’s/,
      ],
      [
        'a run token beside it',
        { ...DEPLOY_KEY },
        { token: 'API_TOKEN', run_ssh_private_key: 'DEPLOY_KEY', run_token: 'RUN_TOKEN' },
        /run_token.*both sealed/,
      ],
    ];
    for (const [name, config, refs, words] of refusals) {
      const refused = create(name, config, refs);
      await expect(refused, name).rejects.toMatchObject({
        statusCode: 400,
        code: 'run_credential_refused',
        message: expect.stringMatching(words),
      });
      await expect(refused.catch((error: Error) => error.message)).resolves.not.toContain(KEY_LINE);
    }
    for (const [name, config, words] of [
      ['minting beside it', { ...DEPLOY_KEY, mint_credentials: true }, /mint_credentials/],
      [
        'a self-managed host',
        { ...DEPLOY_KEY, base_url: 'https://gitlab.example.test' },
        /altssh.gitlab.com:443 only; a self-managed host/,
      ],
    ] as const) {
      await expect(
        create(name, config, { token: 'API_TOKEN', run_ssh_private_key: 'DEPLOY_KEY' }),
        name,
      ).rejects.toMatchObject({
        statusCode: 400,
        code: 'invalid_integration_config',
        message: expect.stringMatching(words),
      });
    }
    expect(await integrationCount()).toBe(before);
  });

  it('creates a valid one, publishes no private key, and binds it to one project only', async () => {
    const [autix, other] = projects as [string, string];
    const id = await create(
      'autix deploy key',
      { ...DEPLOY_KEY },
      { token: 'API_TOKEN', run_ssh_private_key: 'DEPLOY_KEY' },
    );
    const row = await findIntegrationRow(db, id);
    if (row === undefined) throw new Error('the integration row exists');
    const summary = toIntegrationSummary(row, gitlab);
    expect(summary.config).toMatchObject({ run_credential: 'deploy_key' });
    expect(JSON.stringify(summary)).not.toContain(KEY_LINE);
    expect(JSON.stringify(summary)).not.toContain('run_ssh_private_key"');
    const bind = (projectId: string) =>
      replaceProjectBindings(db, projectId, [{ integrationId: id }], {
        egress: allowAnyIntegrationHost(),
      });
    await bind(autix);
    await expect(bind(other)).rejects.toMatchObject({
      statusCode: 409,
      code: 'static_run_credential_shared',
      message: expect.stringMatching(/deploy key every project it is enabled on/),
    });
    expect(
      (await pool.query('select 1 from bindings where integration_id = $1', [id])).rowCount,
    ).toBe(1);
  });

  it('admits deploy_key as a run’s credential source (migration 0081), and no other new value', async () => {
    const { rows } = await pool.query<{ definition: string }>(
      `select pg_get_constraintdef(oid) as definition from pg_constraint
        where conname = 'runs_credential_source_check'`,
    );
    expect(rows).toHaveLength(1);
    for (const value of ['minted', 'static', 'deploy_key', 'none']) {
      expect(rows[0]?.definition).toContain(`'${value}'`);
    }
    expect(rows[0]?.definition.match(/'[a-z_]+'/g)).toHaveLength(4);
  });
});
