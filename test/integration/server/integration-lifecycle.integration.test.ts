/**
 * **An integration can be re-sealed and retired** (WP-114, PROGRESS backlog 331) — the two writes
 * against a real PostgreSQL 18.
 *
 * What only this tier can check:
 *
 *  - the retire's two refusals read the rows they name — a `bindings` row, and an unexpired,
 *    unconfirmed `mint_credential` audit row (TD-028 decision 10) — and leave the credential in
 *    place when they refuse;
 *  - the retire **deletes the `secrets` rows and keeps the integration**, so every
 *    `integration_actions` row still resolves to the integration it names (the restricting foreign
 *    key, BD-003);
 *  - **the lock** (standing rule 9): a bind and a retire of one integration serialise on its row, in
 *    both orders, measured by holding one side's transaction open while the other waits;
 *  - a retired integration is never loaded: the binding repository answers no account for it and
 *    flags a binding of it, and every write refuses it;
 *  - the re-seal replaces exactly the named field's sealed row, deletes the old one, resets
 *    `health`, and answers a replay under its key without sealing anything.
 */
import { allowAnyIntegrationHost } from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import { secrets as secretAdapters } from '@platform/infrastructure';
import { accountOnlyFieldsOf, SHIPPED_PROVIDERS } from '@platform/integrations';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  findIntegrationRow,
  listIntegrationRows,
  toIntegrationSummary,
} from '../../../apps/server/src/queries/integration-queries.js';
import {
  createIntegration,
  environmentSecretSource,
  ForbiddenSecretNameError,
  replaceProjectBindings,
  resealIntegrationSecrets,
  retireIntegration,
  updateIntegrationConfig,
  writeIntegrationHealth,
} from '../../../apps/server/src/queries/onboarding-queries.js';
import { replaceOrganisationSettings } from '../../../apps/server/src/queries/org-settings-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

/** Obviously fake (BD-002), shaped past GitLab's token alphabet by its hyphens (rule 93). */
const OLD_TOKEN = 'glpat-FAKE-wp114-old-credential-00000000';
const NEW_TOKEN = 'glpat-FAKE-wp114-new-credential-00000000';
const WEBHOOK_SECRET = 'FAKE-wp114-webhook-secret-not-rotated-0';
const SECRET_KEY = 'not-a-real-app-secret-key-wp114-000000000';

const gitlab = SHIPPED_PROVIDERS.find((entry) => entry.id === 'gitlab');

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let orgId: string;
let userId: string;
let projectId: string;

const key = secretAdapters.deriveSecretKey(SECRET_KEY);
const source = environmentSecretSource({ OLD_TOKEN, NEW_TOKEN, WEBHOOK_SECRET }, async () => '', [
  'OLD_TOKEN',
  'NEW_TOKEN',
  'WEBHOOK_SECRET',
]);

const createGitlab = async (name: string): Promise<string> => {
  if (gitlab === undefined) {
    throw new Error('this build ships a gitlab provider');
  }
  const result = await createIntegration(db, {
    orgId,
    integration: {
      type: 'git' as IntegrationType,
      provider: 'gitlab',
      name,
      config: { base_url: 'https://gitlab.example.test' },
      secretRefs: { token: 'OLD_TOKEN', webhook_secret_token: 'WEBHOOK_SECRET' },
    },
    provider: gitlab,
    egress: allowAnyIntegrationHost(),
    secretSource: source,
    secretKey: key,
    newId: () => crypto.randomUUID(),
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

const secretRowCount = async (ids: readonly string[]): Promise<number> =>
  (
    await pool.query<{ count: number }>(
      'select count(*)::int as count from secrets where id = any($1::uuid[])',
      [ids],
    )
  ).rows[0]?.count ?? -1;

const retire = (integrationId: string) =>
  retireIntegration(db, {
    integrationId,
    audit: { userId, action: 'integration.retire', params: { integration_id: integrationId } },
  });

/** One audit row of the shape the executor writes for a mint (`runCredentialWrites.mint`). */
const audit = async (
  integrationId: string,
  action: 'mint_credential' | 'revoke_credential',
  row: { status: string; payload?: object; result?: object },
): Promise<void> => {
  await pool.query(
    `insert into integration_actions
       (integration_id, direction, action, payload, result, status, attempts, redaction_count)
     values ($1, 'out', $2, $3::jsonb, $4::jsonb, $5, 1, 0)`,
    [
      integrationId,
      action,
      JSON.stringify(row.payload ?? {}),
      JSON.stringify(row.result ?? {}),
      row.status,
    ],
  );
};

beforeAll(async () => {
  database = await createMigratedDatabase('integration-lifecycle');
  pool = createTestPool(database.connectionString, { max: 6 });
  db = drizzle(pool) as unknown as Database;
  orgId =
    (
      await pool.query<{ id: string }>(
        "insert into organizations (name) values ('wp114') returning id",
      )
    ).rows[0]?.id ?? '';
  userId =
    (
      await pool.query<{ id: string }>(
        "insert into users (email, name) values ('admin@example.test', 'Admin') returning id",
      )
    ).rows[0]?.id ?? '';
  projectId =
    (
      await pool.query<{ id: string }>(
        `insert into projects (org_id, key, name, repo_url)
         values ($1, 'acme', 'Acme', 'https://git.example.test/acme/api.git') returning id`,
        [orgId],
      )
    ).rows[0]?.id ?? '';
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('retiring an integration (WP-114, backlog 331)', () => {
  it('is refused while bound and while a live mint exists, each by name, then retires', async () => {
    const id = await createGitlab('wp114 retire');
    const sealed = await secretIdsOf(id);
    expect(sealed).toHaveLength(2);

    // ── bound: refused, naming the project, and nothing destroyed ──────────────────────────
    await replaceProjectBindings(db, projectId, [{ integrationId: id }], {
      egress: allowAnyIntegrationHost(),
    });
    await expect(retire(id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'integration_bound',
      message: expect.stringContaining('bound to project acme'),
    });
    expect(await secretRowCount(sealed)).toBe(2);
    await replaceProjectBindings(db, projectId, [], { egress: allowAnyIntegrationHost() });

    // ── a live mint: refused; an unconfirmed revoke does not count as one ──────────────────
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
    await audit(id, 'mint_credential', {
      status: 'ok',
      payload: { run_id: crypto.randomUUID() },
      result: { revoke_id: 'acme/api#41', expires_at: tomorrow, scope: 'push' },
    });
    // A mint that expired, and one with no revoke address, are not live (the recovery's reading).
    await audit(id, 'mint_credential', {
      status: 'ok',
      result: { revoke_id: 'acme/api#40', expires_at: '2026-01-01T00:00:00.000Z' },
    });
    await audit(id, 'mint_credential', { status: 'ok', result: { expires_at: tomorrow } });
    await expect(retire(id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'integration_has_live_credential',
      message: expect.stringContaining('minted 1 run credential'),
    });
    await audit(id, 'revoke_credential', {
      status: 'ok',
      payload: { revoke_id: 'acme/api#41', origin: 'recovery' },
      result: { revoked: false },
    });
    await expect(retire(id)).rejects.toMatchObject({ code: 'integration_has_live_credential' });
    expect(await secretRowCount(sealed)).toBe(2);
    await audit(id, 'revoke_credential', {
      status: 'ok',
      payload: { revoke_id: 'acme/api#41' },
      result: { revoked: true },
    });

    // ── retired: the secrets go, the row stays, the audit still resolves ───────────────────
    expect(await retire(id)).toEqual({ status: 'retired', destroyedSecrets: 2 });
    expect(await secretRowCount(sealed)).toBe(0);
    const row = await pool.query<{ secret_ids: string[]; health: object; retired: boolean }>(
      'select secret_ids, health, retired_at is not null as retired from integrations where id = $1',
      [id],
    );
    expect(row.rows[0]).toEqual({ secret_ids: [], health: {}, retired: true });
    const resolved = await pool.query<{ actions: number; named: number }>(
      `select count(*)::int as actions, count(i.id)::int as named
         from integration_actions a left join integrations i on i.id = a.integration_id
        where a.integration_id = $1`,
      [id],
    );
    expect(resolved.rows[0]).toEqual({ actions: 5, named: 5 });
    const audited = await pool.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'integration.retire'",
    );
    expect(audited.rows.map((each) => each.params)).toEqual([
      { integration_id: id, destroyed_secrets: 2 },
    ]);

    // A repeat changes nothing and records nothing.
    expect(await retire(id)).toEqual({ status: 'already_retired' });
    expect(
      (await pool.query("select 1 from human_actions where action = 'integration.retire'"))
        .rowCount,
    ).toBe(1);
    expect(await retire('00000000-0000-4000-8000-0000000000fe')).toEqual({
      status: 'not_found',
    });
  });

  it('refuses every write to a retired integration, lists it as retired and never loads it', async () => {
    const id = await createGitlab('wp114 refused writes');
    await retire(id);

    await expect(
      replaceProjectBindings(db, projectId, [{ integrationId: id }], {
        egress: allowAnyIntegrationHost(),
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'integration_retired' });
    expect(
      (await pool.query('select 1 from bindings where integration_id = $1', [id])).rowCount,
    ).toBe(0);
    await expect(
      updateIntegrationConfig(db, {
        integrationId: id,
        set: { max_pages: 5 },
        remove: [],
        egress: allowAnyIntegrationHost(),
        audit: { userId, action: 'integration.config.write', params: {} },
      }),
    ).rejects.toMatchObject({ code: 'integration_retired' });
    await expect(
      resealIntegrationSecrets(db, {
        integrationId: id,
        secretRefs: { token: 'NEW_TOKEN' },
        secretSource: source,
        secretKey: key,
        newId: () => crypto.randomUUID(),
        idempotency: { key: 'wp114-retired', digest: 'd' },
        audit: { userId, action: 'integration.secrets.write', params: {} },
      }),
    ).rejects.toMatchObject({ code: 'integration_retired' });
    // A probe that raced the retire writes no verdict back.
    await writeIntegrationHealth(db, id, {
      ok: true,
      checkedAt: new Date().toISOString(),
      detail: 'ok',
    });
    // Its name stays taken, and a create under it is refused by name rather than answered with it.
    await expect(createGitlab('wp114 refused writes')).rejects.toMatchObject({
      code: 'integration_name_retired',
    });

    const stored = await findIntegrationRow(db, id);
    expect(stored?.health).toEqual({});
    const listed = (await listIntegrationRows(db)).find((each) => each.id === id);
    expect(listed).toBeDefined();
    const summary = toIntegrationSummary(listed as never, gitlab, null);
    expect(summary.retired_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(summary.config_refusal).toBeNull();

    // The repository answers no account for it, and flags a binding written past the refusal.
    const repository = secretAdapters.createPostgresBindingRepository(pool, accountOnlyFieldsOf);
    expect(await repository.forIntegration(id as Id)).toBeNull();
    await pool.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
      projectId,
      id,
    ]);
    try {
      const bound = await repository.forProject(projectId as Id);
      expect(bound.find((each) => each.integrationId === id)?.retired).toBe(true);
    } finally {
      await pool.query('delete from bindings where integration_id = $1', [id]);
    }
  });

  /**
   * Standing rule 9: whichever of a bind and a retire commits first decides, because both take the
   * integration's row lock — the retire `for update`, the bind `for share`. Each order is held open
   * on a second connection while the other side waits on it.
   */
  it('serialises with a bind and a mint on the integration’s row lock, in both orders', async () => {
    const egress = allowAnyIntegrationHost();
    // A bind in flight: its share lock and its binding row, uncommitted, while the retire waits.
    const first = await createGitlab('wp114 bind first');
    const binder = createTestClient(database.connectionString);
    await binder.connect();
    try {
      await binder.query('begin');
      await binder.query('select 1 from integrations where id = $1 for share', [first]);
      await binder.query('insert into bindings (project_id, integration_id) values ($1, $2)', [
        projectId,
        first,
      ]);
      const retiring = retire(first);
      const outcome = retiring.then(
        () => 'retired',
        (error: { code?: string }) => error.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await binder.query('commit');
      expect(await outcome).toBe('integration_bound');
    } finally {
      await binder.end();
    }
    await replaceProjectBindings(db, projectId, [], { egress });

    // WP-114 review round 1 (orchestrator): the mint's half. A mint's audit insert, uncommitted, holds
    // `for key share` through the foreign key; only the retire's `for update` waits on it (a
    // `for no key update` would not), so the retire sees the committed mint and refuses.
    const minted = await createGitlab('wp114 mint in flight');
    const minter = createTestClient(database.connectionString);
    await minter.connect();
    try {
      await minter.query('begin');
      await minter.query(
        `insert into integration_actions
           (integration_id, direction, action, payload, result, status, attempts, redaction_count)
         values ($1, 'out', 'mint_credential', $2::jsonb, $3::jsonb, 'ok', 1, 0)`,
        [
          minted,
          JSON.stringify({ run_id: crypto.randomUUID() }),
          JSON.stringify({
            revoke_id: 'acme/api#77',
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            scope: 'push',
          }),
        ],
      );
      const retiring = retire(minted).then(
        () => 'retired',
        (error: { code?: string }) => error.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await minter.query('commit');
      expect(await retiring).toBe('integration_has_live_credential');
    } finally {
      await minter.end();
    }

    // A retire in flight: its update lock and its mark, uncommitted, while the bind waits.
    const second = await createGitlab('wp114 retire first');
    const retirer = createTestClient(database.connectionString);
    await retirer.connect();
    try {
      await retirer.query('begin');
      await retirer.query('select 1 from integrations where id = $1 for update', [second]);
      await retirer.query('update integrations set retired_at = now() where id = $1', [second]);
      const binding = replaceProjectBindings(db, projectId, [{ integrationId: second }], {
        egress,
      }).then(
        () => 'bound',
        (error: { code?: string }) => error.code,
      );
      await new Promise((resolve) => setTimeout(resolve, 300));
      await retirer.query('commit');
      expect(await binding).toBe('integration_retired');
    } finally {
      await retirer.end();
    }
  });
});

describe('re-sealing an integration’s credentials (WP-114, backlog 331)', () => {
  const reseal = (integrationId: string, refs: Record<string, string>, idempotencyKey: string) =>
    resealIntegrationSecrets(db, {
      integrationId,
      secretRefs: refs,
      secretSource: source,
      secretKey: key,
      newId: () => crypto.randomUUID(),
      idempotency: { key: idempotencyKey, digest: `digest-${idempotencyKey}` },
      audit: {
        userId,
        action: 'integration.secrets.write',
        params: { integration_id: integrationId },
      },
    });

  it('replaces the named field, keeps the other, deletes the old row and resets health', async () => {
    const id = await createGitlab('wp114 reseal');
    const before = await secretIdsOf(id);
    await writeIntegrationHealth(db, id, {
      ok: true,
      checkedAt: new Date().toISOString(),
      detail: 'reachable',
    });

    expect(await reseal(id, { token: 'NEW_TOKEN' }, 'wp114-reseal-1')).toEqual({
      status: 'resealed',
      sealedFields: ['token'],
      destroyedSecrets: 1,
    });
    const after = await secretIdsOf(id);
    expect(after).toHaveLength(2);
    // Exactly one of the old rows survives (the webhook secret's), and the other is gone.
    expect(await secretRowCount(before)).toBe(1);
    const store = secretAdapters.createPostgresSecretStore({ sql: pool, key });
    expect(await store.resolve(after as never)).toEqual({
      token: NEW_TOKEN,
      webhook_secret_token: WEBHOOK_SECRET,
    });
    expect((await findIntegrationRow(db, id))?.health).toEqual({});
    const audited = await pool.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'integration.secrets.write'",
    );
    expect(audited.rows.map((each) => each.params)).toEqual([
      {
        integration_id: id,
        secret_fields: ['token'],
        destroyed_secrets: 1,
        unreadable_destroyed: 0,
        idempotency_key: 'wp114-reseal-1',
        body_digest: 'digest-wp114-reseal-1',
      },
    ]);
    // No value anywhere in the audit.
    expect(JSON.stringify(audited.rows)).not.toContain(NEW_TOKEN);

    // A replay under the key seals nothing and records nothing.
    const secretsBefore = (await pool.query('select id from secrets')).rowCount;
    expect(await reseal(id, { token: 'NEW_TOKEN' }, 'wp114-reseal-1')).toEqual({
      status: 'replayed',
    });
    expect((await pool.query('select id from secrets')).rowCount).toBe(secretsBefore);
    expect(await secretIdsOf(id)).toEqual(after);
  });

  it('refuses a name off the allow-list and a field the provider does not declare, sealing nothing', async () => {
    const id = await createGitlab('wp114 reseal refused');
    const before = await secretIdsOf(id);
    await expect(reseal(id, { token: 'APP_SECRET_KEY' }, 'wp114-refused-1')).rejects.toBeInstanceOf(
      ForbiddenSecretNameError,
    );
    await expect(reseal(id, { password: 'NEW_TOKEN' }, 'wp114-refused-2')).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(await secretIdsOf(id)).toEqual(before);
    expect(await secretRowCount(before)).toBe(2);
    expect(
      await reseal('00000000-0000-4000-8000-0000000000fd', { token: 'NEW_TOKEN' }, 'k'),
    ).toEqual({ status: 'not_found' });
  });

  it('destroys a stored row it cannot open, which only ever failed the load', async () => {
    const id = await createGitlab('wp114 reseal unreadable');
    const [unreadable] = await secretIdsOf(id);
    await pool.query("update secrets set ciphertext = '\\x00'::bytea where id = $1", [unreadable]);
    const result = await reseal(id, { token: 'NEW_TOKEN' }, 'wp114-unreadable');
    expect(result).toMatchObject({ status: 'resealed', sealedFields: ['token'] });
    expect(await secretRowCount([unreadable as string])).toBe(0);
    const audited = await pool.query<{ params: { unreadable_destroyed: number } }>(
      "select params from human_actions where params ->> 'idempotency_key' = 'wp114-unreadable'",
    );
    expect(audited.rows[0]?.params.unreadable_destroyed).toBe(1);
  });
});

/**
 * WP-114 pre-review, PROGRESS backlog 387: the organisation's flagged chat account and a retire.
 * Each way is refused by name — the retire of the flagged account, and a `PATCH /api/org` write that
 * flags a retired one — and the refusal writes nothing.
 */
describe('the organisation’s chat account and a retire (backlog 387)', () => {
  const chatAccount = async (name: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `insert into integrations (org_id, type, provider, name, config)
         values ($1, 'communication', 'slack', $2, '{"channel": "#ops"}'::jsonb) returning id`,
        [orgId, name],
      )
    ).rows[0]?.id ?? '';
  const flag = (id: string | null) =>
    replaceOrganisationSettings(
      db,
      () => ({ notifications: { organisation_default: id } }) as never,
    );

  it('refuses to retire the flagged account, and retires it once the flag moves', async () => {
    const id = await chatAccount('wp114 flagged chat');
    await flag(id);
    await expect(retire(id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'integration_is_organisation_default',
      message: expect.stringContaining('PATCH /api/org'),
    });
    expect(
      (await pool.query('select 1 from integrations where id = $1 and retired_at is null', [id]))
        .rowCount,
    ).toBe(1);
    await flag(null);
    expect(await retire(id)).toMatchObject({ status: 'retired' });
  });

  it('refuses to flag a retired account, writing nothing', async () => {
    const id = await chatAccount('wp114 retired chat');
    expect(await retire(id)).toMatchObject({ status: 'retired' });
    const before = await pool.query<{ settings: unknown }>('select settings from organizations');
    await expect(flag(id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'integration_retired',
      message: expect.stringContaining('notifications.organisation_default'),
    });
    const after = await pool.query<{ settings: unknown }>('select settings from organizations');
    expect(after.rows).toEqual(before.rows);
  });
});
