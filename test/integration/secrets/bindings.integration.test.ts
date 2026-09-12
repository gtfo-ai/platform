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
import { randomUUID } from 'node:crypto';
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  noSecretsRedactor,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { secrets as secretAdapters } from '@platform/infrastructure';
import {
  createPipelineIntegrationsLoader,
  createPipelineProviderRegistry,
} from '@platform/integrations';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const KEY = secretAdapters.deriveSecretKey('not-a-real-app-secret-key-000000000000');

let database: MigratedDatabase;
let pool: pg.Pool;
let projectId: string;
let orgId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('bindings');
  pool = createTestPool(database.connectionString, { max: 4 });
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
  // The id is in the envelope's AAD, so it is generated here and inserted explicitly rather than
  // left to the column default (`envelope.ts`).
  const id = randomUUID();
  const { rows } = await pool.query<{ id: string }>(
    'insert into secrets (id, ciphertext, key_id) values ($1, $2, $3) returning id',
    [
      id,
      secretAdapters.sealSecret(KEY, secretAdapters.secretDocument(field, value), id),
      KEY.keyId,
    ],
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
    const id = randomUUID();
    const { rows } = await pool.query<{ id: string }>(
      'insert into secrets (id, ciphertext, key_id) values ($1, $2, $3) returning id',
      [
        id,
        secretAdapters.sealSecret(other, secretAdapters.secretDocument('token', 'x'), id),
        other.keyId,
      ],
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

/**
 * The **shipped** registrations, through the **production** loader, on a **real** database.
 *
 * Round 2's reviewer named this hole: the `e2e-fake-claude` harness replaces the registry wholesale,
 * so every end-to-end run exercises the fakes' `configSchema` and `create`, and `loader.test.ts`
 * exercises the real ones against stubbed rows. Neither drives the join that actually breaks — a
 * real `integrations.config` document merged with a real decrypted `secrets` row and parsed by a
 * real provider's **strict** schema, which is exactly where a column rename or a `secretFields`
 * typo lands and where nothing else would notice.
 *
 * No provider I/O happens here and none is stubbed: `create` parses and constructs, and the first
 * HTTP call is a method call this never makes. That is what makes the coverage cheap enough to be
 * worth having at this tier rather than another e2e.
 */
describe('the shipped provider registrations, loaded from real rows', () => {
  it('builds GitLab and Jira from the rows an operator would have written', async () => {
    const project = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'shipped', 'Shipped', 'https://git.example.test/acme/shipped.git')
       returning id`,
      [orgId],
    );
    const projectId = project.rows[0]?.id as Id;

    const gitlabToken = await insertSecret('token', 'glpat-FAKE-shipped-binding-token-0001');
    const jiraToken = await insertSecret('api_token', 'FAKE-shipped-jira-token-0001');

    const bind = async (
      type: string,
      provider: string,
      name: string,
      config: Record<string, unknown>,
      secretId: string,
    ): Promise<void> => {
      const { rows } = await pool.query<{ id: string }>(
        `insert into integrations (org_id, type, provider, name, config, secret_ids)
         values ($1, $2::integration_type, $3, $4, $5::jsonb, array[$6::uuid]) returning id`,
        [orgId, type, provider, name, JSON.stringify(config), secretId],
      );
      await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
        projectId,
        rows[0]?.id,
      ]);
    };

    await bind(
      'git',
      'gitlab',
      'shipped gitlab',
      { base_url: 'https://gitlab.example.test', project: 'acme/shipped' },
      gitlabToken,
    );
    await bind(
      'task_management',
      'jira-cloud',
      'shipped jira',
      { site_url: 'https://acme-example.atlassian.net', user_email: 'bot@example.test' },
      jiraToken,
    );

    const executor = createIntegrationActionExecutor({
      auditLog: createMemoryAuditLog(),
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
    });
    const loader = createPipelineIntegrationsLoader({
      repository: secretAdapters.createPostgresBindingRepository(pool),
      secrets: secretAdapters.createPostgresSecretStore({ sql: pool, key: KEY }),
      registry: createPipelineProviderRegistry({
        executor,
        clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
      }),
      executor,
      gitProjectPath: async () => 'acme/shipped',
    });

    const integrations = await loader.forProject(projectId, { runScopedSecrets: [] });

    expect(integrations.git?.ref).toEqual({
      integrationId: expect.any(String),
      provider: 'gitlab',
      type: 'git',
    });
    expect(integrations.git?.project).toBe('acme/shipped');
    expect(integrations.taskManagement?.ref).toMatchObject({
      provider: 'jira-cloud',
      type: 'task_management',
    });
    // The capability flags come off the parsed config, so reading one proves the strict parse ran
    // over the merged document rather than over the row alone.
    expect(integrations.git?.port.capabilities()).toMatchObject({ webhooks: expect.any(Boolean) });
  });

  it('refuses a shipped binding whose config row is missing a field the schema requires', async () => {
    const project = await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, 'broken', 'Broken', 'https://git.example.test/acme/broken.git')
       returning id`,
      [orgId],
    );
    const projectId = project.rows[0]?.id as Id;
    const token = await insertSecret('token', 'glpat-FAKE-broken-binding-token-0001');
    const { rows } = await pool.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name, config, secret_ids)
       values ($1, 'git', 'gitlab', 'no base url', '{}'::jsonb, array[$2::uuid]) returning id`,
      [orgId, token],
    );
    await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
      projectId,
      rows[0]?.id,
    ]);

    const executor = createIntegrationActionExecutor({
      auditLog: createMemoryAuditLog(),
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
    });
    const loader = createPipelineIntegrationsLoader({
      repository: secretAdapters.createPostgresBindingRepository(pool),
      secrets: secretAdapters.createPostgresSecretStore({ sql: pool, key: KEY }),
      registry: createPipelineProviderRegistry({
        executor,
        clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
      }),
      executor,
      gitProjectPath: async () => 'acme/broken',
    });

    // Standing rule 20: broken is not absent. A missing `base_url` must not resolve to `git: null`.
    const error = await loader
      .forProject(projectId, { runScopedSecrets: [] })
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toContain('fails its schema at: base_url');
    expect((error as Error).message).not.toContain('glpat-');
  });
});
