/**
 * The two adapters WP-15a's loader reads a project through, against a real PostgreSQL 18.
 *
 * The unit tier holds their *logic* against stubbed rows. What only a database can show is the part
 * that is SQL: the join and the config merge, the `uuid[]` round trip through the driver, `bytea`
 * carrying a sealed envelope byte for byte, and the stable order that makes "which binding did the
 * loader choose" a question with one answer.
 *
 * The order test is the one worth naming. `bindings` has no ordering column, so without the
 * `order by` a project with two git accounts resolves to whichever row PostgreSQL returned — and
 * the loader refuses two of a type, so the *refusal* would name a different pair on different runs.
 * Asserting the order here is what makes that refusal reproducible.
 */
import { secrets as secretAdapters } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

const KEY = secretAdapters.deriveSecretKey('not-a-real-app-secret-key-000000000000');

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: string;
let orgId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('bindings');
  pool = new pg.Pool({ connectionString: database.connectionString, max: 4 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('bindings') returning id",
  );
  orgId = org.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'api', 'API', 'https://git.example.test/acme/api.git') returning id`,
    [orgId],
  );
  projectId = project.rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const insertSecret = async (field: string, value: string): Promise<string> => {
  const { rows } = await pool.query<{ id: string }>(
    'insert into secrets (ciphertext, key_id) values ($1, $2) returning id',
    [secretAdapters.sealSecret(KEY, secretAdapters.secretDocument(field, value)), KEY.keyId],
  );
  return rows[0]?.id as string;
};

const insertBinding = async (
  type: string,
  provider: string,
  name: string,
  integrationConfig: Record<string, unknown>,
  bindingConfig: Record<string, unknown>,
  secretIds: readonly string[],
): Promise<void> => {
  const { rows } = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
     values ($1, $2::integration_type, $3, $4, $5::jsonb, $6::uuid[]) returning id`,
    [orgId, type, provider, name, JSON.stringify(integrationConfig), secretIds],
  );
  await pool.query(
    'insert into bindings (project_id, integration_id, config) values ($1, $2, $3::jsonb)',
    [projectId, rows[0]?.id, JSON.stringify(bindingConfig)],
  );
};

describe('the secret store on a real database', () => {
  it('round-trips a sealed credential through bytea and resolves it by config field', async () => {
    const id = await insertSecret('token', 'glpat-FAKE-not-a-real-token-0001');
    const store = secretAdapters.createPostgresSecretStore({ sql: pool, key: KEY });
    await expect(store.resolve([id as never])).resolves.toEqual({
      token: 'glpat-FAKE-not-a-real-token-0001',
    });
  });

  it('refuses a row sealed under a key this process does not hold', async () => {
    const other = secretAdapters.deriveSecretKey('also-not-a-real-app-secret-key-11111111');
    const { rows } = await pool.query<{ id: string }>(
      'insert into secrets (ciphertext, key_id) values ($1, $2) returning id',
      [secretAdapters.sealSecret(other, secretAdapters.secretDocument('token', 'x')), other.keyId],
    );
    const store = secretAdapters.createPostgresSecretStore({ sql: pool, key: KEY });
    await expect(store.resolve([rows[0]?.id as never])).rejects.toThrow(/is sealed under key/);
  });
});

describe('the binding repository on a real database', () => {
  it('merges the binding’s config over the account’s, carries the secret ids, and orders stably', async () => {
    await insertBinding(
      'task_management',
      'jira-cloud',
      'acme jira',
      { site_url: 'https://acme-example.atlassian.net', pickup_label: 'agentic' },
      { pickup_label: 'agentic-api' },
      [],
    );
    const tokenId = await insertSecret('token', 'glpat-FAKE-not-a-real-token-0002');
    await insertBinding('git', 'gitlab', 'b account', { base_url: 'https://b.example.test' }, {}, [
      tokenId,
    ]);
    await insertBinding(
      'git',
      'gitlab',
      'a account',
      { base_url: 'https://a.example.test' },
      {},
      [],
    );

    const repository = secretAdapters.createPostgresBindingRepository(pool);
    const bindings = await repository.forProject(projectId as never);

    // `order by i.type, i.provider, i.name`. `type` is an **enum**, and PostgreSQL orders an enum
    // by the order its labels were declared, not alphabetically — migration 0002 declares
    // `task_management` first. Asserted as it actually behaves rather than as the column name
    // suggests: the property the loader needs is that the answer is the *same* every time, and a
    // test written to the alphabetical guess would have hidden which of the two it was getting.
    expect(bindings.map((binding) => `${binding.type}/${binding.name}`)).toEqual([
      'task_management/acme jira',
      'git/a account',
      'git/b account',
    ]);

    const jira = bindings.find((binding) => binding.provider === 'jira-cloud');
    expect(jira?.config).toEqual({
      site_url: 'https://acme-example.atlassian.net',
      // The binding's own value wins over the account's, which is the reason the column exists.
      pickup_label: 'agentic-api',
    });

    const withSecret = bindings.find((binding) => binding.name === 'b account');
    expect(withSecret?.secretIds).toEqual([tokenId]);
    expect(bindings.find((binding) => binding.name === 'a account')?.secretIds).toEqual([]);
  });

  it('answers nothing for a project with no bindings, rather than every binding', async () => {
    const other = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'web', 'Web', 'https://git.example.test/acme/web.git') returning id`,
      [orgId],
    );
    const repository = secretAdapters.createPostgresBindingRepository(pool);
    await expect(repository.forProject(other.rows[0]?.id as never)).resolves.toEqual([]);
  });
});
