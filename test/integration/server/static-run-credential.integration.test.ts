/**
 * **A static run credential is refused at every write that could make it wrong** — WP-137, TD-028
 * decision 13 item 1, against a real PostgreSQL 18.
 *
 * Measured first (criterion 1): `integrations.config` and the integration's credentials are written
 * by exactly four statements — the create (`createIntegration`), the `PATCH` (`updateIntegrationConfig`),
 * the re-seal (`resealIntegrationSecrets`) and, for the binding rule, the bindings `PUT`
 * (`replaceProjectBindings`); `mint_credentials` is validated by the GitLab config schema alone. Each
 * refusal is asserted at the door it belongs to, with nothing written behind it:
 *
 *  - `static` without a run token; the API token as the run token (decrypted values compared);
 *    `static` beside `mint_credentials: true`; an expiry past or more than 90 days ahead;
 *  - a second project's binding of a static integration (409), and a `PATCH` into `static` of an
 *    integration two projects bind (409);
 *  - and the published configuration never carries `run_token`, even from a row written by hand.
 */
import { allowAnyIntegrationHost } from '@platform/application';
import type { IntegrationType, JsonObject } from '@platform/contracts';
import { secrets as secretAdapters } from '@platform/infrastructure';
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boundProjectReader } from '../../../apps/server/src/onboarding.js';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  findIntegrationRow,
  toIntegrationSummary,
} from '../../../apps/server/src/queries/integration-queries.js';
import {
  createIntegration,
  environmentSecretSource,
  replaceProjectBindings,
  resealIntegrationSecrets,
  updateIntegrationConfig,
} from '../../../apps/server/src/queries/onboarding-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

/** Obviously fake (BD-002). */
const API_TOKEN = 'glpat-FAKE-wp137-binding-api-token-00000';
const RUN_TOKEN = 'glpat-FAKE-wp137-static-run-token-000000';
const SECRET_KEY = 'not-a-real-app-secret-key-wp137-000000000';
const NOW = new Date('2026-10-03T12:00:00.000Z');

const gitlab = SHIPPED_PROVIDERS.find((entry) => entry.id === 'gitlab');

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let orgId: string;
let userId: string;
const projects: string[] = [];

const key = secretAdapters.deriveSecretKey(SECRET_KEY);
const source = environmentSecretSource({ API_TOKEN, RUN_TOKEN }, async () => '', [
  'API_TOKEN',
  'RUN_TOKEN',
]);

const STATIC = {
  base_url: 'https://gitlab.example.test',
  run_credential: 'static',
  run_token_username: 'agentic-runner',
  run_token_expires_at: '2026-12-01',
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

const secretIdsOf = async (integrationId: string): Promise<string[]> =>
  (
    await pool.query<{ secret_ids: string[] }>(
      'select secret_ids from integrations where id = $1',
      [integrationId],
    )
  ).rows[0]?.secret_ids ?? [];

const integrationCount = async (): Promise<number> =>
  (await pool.query<{ count: number }>('select count(*)::int as count from integrations')).rows[0]
    ?.count ?? -1;

const bind = (projectId: string, integrationId: string) =>
  replaceProjectBindings(db, projectId, [{ integrationId }], { egress: allowAnyIntegrationHost() });

beforeAll(async () => {
  database = await createMigratedDatabase('static-run-credential');
  pool = createTestPool(database.connectionString, { max: 4 });
  db = drizzle(pool) as unknown as Database;
  orgId =
    (
      await pool.query<{ id: string }>(
        "insert into organizations (name) values ('wp137') returning id",
      )
    ).rows[0]?.id ?? '';
  userId =
    (
      await pool.query<{ id: string }>(
        "insert into users (email, name) values ('admin@example.test', 'Admin') returning id",
      )
    ).rows[0]?.id ?? '';
  for (const projectKey of ['autix', 'other']) {
    projects.push(
      (
        await pool.query<{ id: string }>(
          `insert into projects (org_id, key, name, repo_url)
           values ($1, $2, $2, 'https://gitlab.example.test/acme/' || $2 || '.git') returning id`,
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

describe('declaring a static run credential (WP-137, TD-028 decision 13)', () => {
  it('refuses each broken create by name and writes nothing', async () => {
    const before = await integrationCount();
    await expect(
      create('no run token', { ...STATIC }, { token: 'API_TOKEN' }),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'run_credential_refused',
      message: expect.stringMatching(/run_token — .*needs the run token itself/),
    });
    const same = create(
      'api as run',
      { ...STATIC },
      { token: 'API_TOKEN', run_token: 'API_TOKEN' },
    );
    await expect(same).rejects.toMatchObject({
      code: 'run_credential_refused',
      message: expect.stringMatching(/own API token/),
    });
    await expect(same.catch((error: Error) => error.message)).resolves.not.toContain(API_TOKEN);
    await expect(
      create(
        'both sources',
        { ...STATIC, mint_credentials: true },
        { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_integration_config',
      message: expect.stringMatching(/mint_credentials/),
    });
    for (const expiry of ['2026-10-01', '2027-03-01']) {
      await expect(
        create(
          `expiry ${expiry}`,
          { ...STATIC, run_token_expires_at: expiry },
          { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
        ),
      ).rejects.toMatchObject({ code: 'run_credential_refused' });
    }
    expect(await integrationCount()).toBe(before);
  });

  it('creates a valid one and never publishes run_token, even from a row written by hand', async () => {
    const id = await create(
      'autix gitlab',
      { ...STATIC },
      { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
    );
    // A run_token pasted into the column before any refusal existed: the read API still strips it.
    await pool.query(
      `update integrations set config = config || jsonb_build_object('run_token', $2::text) where id = $1`,
      [id, RUN_TOKEN],
    );
    const row = await findIntegrationRow(db, id);
    if (row === undefined) throw new Error('the integration row exists');
    const summary = toIntegrationSummary(row, gitlab, null);
    expect(summary.config).toMatchObject({ run_credential: 'static' });
    expect(JSON.stringify(summary)).not.toContain(RUN_TOKEN);
    expect(JSON.stringify(summary)).not.toContain('run_token"');
    await pool.query(`update integrations set config = config - 'run_token' where id = $1`, [id]);
  });

  it('refuses a second project’s binding of a static integration, and a PATCH into static of a shared one', async () => {
    const [autix, other] = projects as [string, string];
    const id = await create(
      'bind once',
      { ...STATIC },
      { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
    );
    await bind(autix, id);
    // The same project re-submitting its own set is not a second binding.
    await bind(autix, id);
    await expect(bind(other, id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'static_run_credential_shared',
      message: expect.stringContaining(autix),
    });
    expect(
      (await pool.query('select 1 from bindings where integration_id = $1', [id])).rowCount,
    ).toBe(1);

    const shared = await create(
      'shared minted',
      { base_url: 'https://gitlab.example.test' },
      { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
    );
    await replaceProjectBindings(db, autix, [{ integrationId: shared }], {
      egress: allowAnyIntegrationHost(),
    });
    await bind(other, shared);
    await expect(
      updateIntegrationConfig(db, {
        integrationId: shared,
        set: { ...STATIC },
        remove: [],
        egress: allowAnyIntegrationHost(),
        secretKey: key,
        now: NOW,
        audit: { userId, action: 'integration.config.write', params: {} },
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'static_run_credential_shared' });
    expect((await findIntegrationRow(db, shared))?.config).toEqual({
      base_url: 'https://gitlab.example.test',
    });
    await replaceProjectBindings(db, autix, [], { egress: allowAnyIntegrationHost() });
    await replaceProjectBindings(db, other, [], { egress: allowAnyIntegrationHost() });
  });

  /**
   * WP-141 (TD-028 decision 13a): an operator's own token is declared like decision 13's — refused
   * beside a minted integration — and the probe reads the bound project's **stored** default branch,
   * which is what `boundProjectReader`'s SQL returns beside the repository path.
   */
  it('declares an operator’s own token only as static, and reads the bound project’s stored default branch', async () => {
    const [autix] = projects as [string, string];
    const before = await integrationCount();
    await expect(
      create(
        'operator minted',
        { base_url: 'https://gitlab.example.test', run_token_owner: 'operator' },
        { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_integration_config' });
    expect(await integrationCount()).toBe(before);

    const id = await create(
      'operator static',
      { ...STATIC, run_token_owner: 'operator', run_token_username: 'acme-owner' },
      { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
    );
    await pool.query("update projects set default_branch = 'develop' where id = $1", [autix]);
    expect(await boundProjectReader(pool)(id), 'nothing bound yet').toBeNull();
    await bind(autix, id);
    expect(await boundProjectReader(pool)(id)).toEqual({
      path: 'acme/autix',
      defaultBranch: 'develop',
    });
    await replaceProjectBindings(db, autix, [], { egress: allowAnyIntegrationHost() });
    await pool.query("update projects set default_branch = 'main' where id = $1", [autix]);
  });

  /** Review round 1: a project's binding cannot turn minting on under a static account. */
  it('refuses a binding that sets mint_credentials: true on a static account, writing nothing', async () => {
    const [autix] = projects as [string, string];
    const id = await create(
      'no minting overlay',
      { ...STATIC },
      { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
    );
    await expect(
      replaceProjectBindings(
        db,
        autix,
        [{ integrationId: id, config: { mint_credentials: true } }],
        {
          egress: allowAnyIntegrationHost(),
        },
      ),
    ).rejects.toMatchObject({
      statusCode: 400,
      code: 'invalid_binding_config',
      message: expect.stringMatching(/mint_credentials/),
    });
    expect(
      (await pool.query('select 1 from bindings where integration_id = $1', [id])).rowCount,
    ).toBe(0);
  });

  it('refuses a PATCH into static with no sealed run token, and admits it once one is sealed', async () => {
    const id = await create(
      'patch me',
      { base_url: 'https://gitlab.example.test' },
      { token: 'API_TOKEN' },
    );
    const patch = () =>
      updateIntegrationConfig(db, {
        integrationId: id,
        set: { ...STATIC },
        remove: [],
        egress: allowAnyIntegrationHost(),
        secretKey: key,
        now: NOW,
        audit: { userId, action: 'integration.config.write', params: {} },
      });
    await expect(patch()).rejects.toMatchObject({
      code: 'run_credential_refused',
      message: expect.stringMatching(/needs the run token itself/),
    });
    await resealIntegrationSecrets(db, {
      integrationId: id,
      secretRefs: { run_token: 'RUN_TOKEN' },
      secretSource: source,
      secretKey: key,
      newId: () => crypto.randomUUID(),
      idempotency: { key: crypto.randomUUID(), digest: 'wp137-seal' },
      now: NOW,
      audit: { userId, action: 'integration.secrets.write', params: {} },
    });
    await expect(patch()).resolves.toMatchObject({ status: 'written' });
  });

  it('refuses a re-seal that makes the run token the API token, sealing nothing', async () => {
    const id = await create(
      'reseal me',
      { ...STATIC },
      { token: 'API_TOKEN', run_token: 'RUN_TOKEN' },
    );
    const before = await secretIdsOf(id);
    await expect(
      resealIntegrationSecrets(db, {
        integrationId: id,
        secretRefs: { run_token: 'API_TOKEN' },
        secretSource: source,
        secretKey: key,
        newId: () => crypto.randomUUID(),
        idempotency: { key: crypto.randomUUID(), digest: 'wp137-same' },
        now: NOW,
        audit: { userId, action: 'integration.secrets.write', params: {} },
      }),
    ).rejects.toMatchObject({
      code: 'run_credential_refused',
      message: expect.stringMatching(/own API token/),
    });
    expect(await secretIdsOf(id)).toEqual(before);
  });
});
