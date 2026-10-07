/**
 * The onboarding wizard's writes against a real PostgreSQL 18 (WP-21, technical/10 integration
 * tier), and the `ReadinessStore` contract against the SQL that finally writes
 * `readiness_evaluations`.
 *
 * Three things only this tier can check:
 *
 *  - the **unique keys** the wizard's idempotency actually rests on. `createProject`'s
 *    `on conflict (key) do nothing` and `createIntegration`'s `(org_id, type, name)` lookup are
 *    claims about indexes, and an in-memory double would answer them from a `Map` whether the
 *    indexes existed or not;
 *  - a credential really is **sealed with the envelope the loader opens** — the plaintext is absent
 *    from `secrets.ciphertext` and from `integrations.config`, which is a statement about bytes on
 *    disk;
 *  - `record` writes **two** rows in one transaction: the evaluation and the narrow
 *    `projects.readiness_level` update. The contract suite reads the column through the harness for
 *    exactly that reason.
 */
import type { Transaction } from '@platform/application';
import { allowAnyIntegrationHost, createIntegrationEgressPolicy } from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import {
  knowledge as knowledgeAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createDiscoveryEscalationRead,
  createReadinessCiEvents,
} from '../../../apps/server/src/onboarding.js';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  claimIdempotentAttemptInTransaction,
  createIntegration,
  createProject,
  ensureOrganisation,
  environmentSecretSource,
  findIdempotentAttempt,
  findOrganisationId,
  listProjectBindings,
  MissingSecretError,
  recordHumanAction,
  replaceProjectBindings,
  updateIntegrationConfig,
  writeIntegrationHealth,
  writeProjectConfig,
} from '../../../apps/server/src/queries/onboarding-queries.js';
import { runReadinessStoreContract } from '../../contract/support/readiness-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestClient, createTestPool } from '../support/postgres.js';

/** Obviously fake (BD-002), planted so its absence from the sealed row is a measurement. */
const PLANTED_TOKEN = 'glpat-FAKE-wp21-planted-credential-000000';
const SECRET_KEY = 'not-a-real-app-secret-key-000000000000';

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let orgId: string;
let userId: string;
let projectId: string;
let otherProjectId: string;

const gitlab = SHIPPED_PROVIDERS.find((entry) => entry.id === 'gitlab');

beforeAll(async () => {
  database = await createMigratedDatabase('onboarding');
  // The harness's factory, not `new pg.Pool`: it attaches the stricter `error` listener backlog 28
  // earned, and `pool-errors.test.ts`'s census refuses a pool constructed anywhere else.
  pool = createTestPool(database.connectionString, { max: 4 });
  db = drizzle(pool) as unknown as Database;
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('onboarding') returning id",
  );
  orgId = org.rows[0]?.id as string;
  const user = await pool.query<{ id: string }>(
    "insert into users (email, name) values ('operator@example.test', 'Operator') returning id",
  );
  userId = user.rows[0]?.id as string;
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'readiness', 'Readiness', 'https://git.example.test/acme/readiness.git')
     returning id`,
    [orgId],
  );
  projectId = project.rows[0]?.id as string;
  const other = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'readiness-other', 'Other', 'https://git.example.test/acme/other.git')
     returning id`,
    [orgId],
  );
  otherProjectId = other.rows[0]?.id as string;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

runReadinessStoreContract({
  name: 'postgres',
  create: async () => {
    const client = createTestClient(database.connectionString);
    await client.connect();
    await client.query('begin');
    return {
      store: knowledgeAdapters.createPostgresReadinessStore(client),
      tx: { adapter: 'postgres', client } as unknown as Transaction,
      projectId: projectId as Id,
      otherProjectId: otherProjectId as Id,
      // The **column**, read inside the same transaction: `record` writes it and the suite's whole
      // point is that a store which skipped it would pass every other case.
      readLevel: async (id) => {
        const { rows } = await client.query<{ readiness_level: number }>(
          'select readiness_level from projects where id = $1',
          [id],
        );
        return Number(rows[0]?.readiness_level ?? 0);
      },
      cleanup: async () => {
        await client.query('rollback');
        await client.end();
      },
    };
  },
});

describe('the wizard’s project writes', () => {
  beforeEach(async () => {
    await pool.query("delete from projects where key like 'wiz-%'");
  });

  it('creates a project and answers with the same one on a retry', async () => {
    const first = await createProject(db, orgId, {
      key: 'wiz_one',
      name: 'Wizard One',
      repoUrl: 'https://git.example.test/acme/one.git',
    });
    const second = await createProject(db, orgId, {
      key: 'wiz_one',
      name: 'Wizard One',
      repoUrl: 'https://git.example.test/acme/one.git',
    });
    expect(first.status).toBe('created');
    // The idempotency of the command **is** the unique index, which only a database has.
    expect(second.status).toBe('exists');
    expect(second.project.id).toBe(first.project.id);
    const { rows } = await pool.query<{ count: number }>(
      "select count(*)::int as count from projects where key = 'wiz_one'",
    );
    expect(rows[0]?.count).toBe(1);
    await pool.query("delete from projects where key = 'wiz_one'");
  });

  it('starts a project at readiness 0 and the platform default dial', async () => {
    const created = await createProject(db, orgId, {
      key: 'wiz_two',
      name: 'Wizard Two',
      repoUrl: 'https://git.example.test/acme/two.git',
    });
    expect(created.project.readiness_level).toBe(0);
    expect(created.project.autonomy_level).toBe('supervised');
    await pool.query("delete from projects where key = 'wiz_two'");
  });

  it('finds the deployment’s organisation', async () => {
    expect(await findOrganisationId(db)).toBe(orgId);
  });
});

describe('ensureOrganisation', () => {
  /**
   * **Two first-project requests at once must produce one organisation**, and the only thing that
   * makes that true is the advisory lock.
   *
   * `organizations` has no unique column to conflict on, so under READ COMMITTED both transactions
   * see an empty table and both insert — which is why this is a lock rather than an upsert, and why
   * the lock needs a test of its own. The interleaving is written out by hand rather than produced
   * by load (standing rules 2 and 66): both calls are started before either can finish, and the
   * assertion is the **row count**, which is the only thing a lost race would move.
   *
   * It runs against a database of its own rather than deleting this file's seed: a case that
   * emptied `organizations` would take every other case's `org_id` with it, and a restore afterwards
   * is a second thing to get wrong.
   */
  let fresh: MigratedDatabase;
  let freshPool: pg.Pool;

  beforeAll(async () => {
    fresh = await createMigratedDatabase('onboarding-race');
    freshPool = createTestPool(fresh.connectionString, { max: 4 });
  }, 120_000);

  afterAll(async () => {
    await freshPool?.end();
    await fresh?.drop();
  });

  it('creates exactly one organisation when two requests race', async () => {
    const empty = drizzle(freshPool) as unknown as Database;
    expect(await findOrganisationId(empty)).toBeNull();

    const [first, second] = await Promise.all([
      ensureOrganisation(empty),
      ensureOrganisation(empty),
    ]);
    expect(first).toBe(second);
    const { rows } = await freshPool.query<{ count: number }>(
      'select count(*)::int as count from organizations',
    );
    expect(rows[0]?.count).toBe(1);

    // …and a third call reads rather than inserting — the fast path, which a broken read would fail
    // and which a lock-only implementation would pass (standing rule 10: assert which branch ran).
    expect(await ensureOrganisation(empty)).toBe(first);
    expect(await findOrganisationId(empty)).toBe(first);
  });
});

describe('the wizard’s integration writes', () => {
  // The operator-declared allow-list (`APP_INTEGRATION_SECRET_ENV`): a name outside it is refused
  // before the environment is read at all, which `onboarding-queries.test.ts` asserts.
  const source = environmentSecretSource(
    { GITLAB_TOKEN: PLANTED_TOKEN, EMPTY_TOKEN: '' },
    async () => '',
    ['GITLAB_TOKEN', 'EMPTY_TOKEN'],
  );
  const key = secretAdapters.deriveSecretKey(SECRET_KEY);
  let created: string | null = null;

  afterAll(async () => {
    await pool.query("delete from integrations where name like 'wiz %'");
  });

  it('seals the credential with the envelope the loader opens, and stores no plaintext', async () => {
    if (gitlab === undefined) {
      expect.unreachable('this build ships a gitlab provider');
      return;
    }
    const result = await createIntegration(db, {
      orgId,
      integration: {
        type: 'git' as IntegrationType,
        provider: 'gitlab',
        name: 'wiz gitlab',
        config: { base_url: 'https://gitlab.example.test', project: 'acme/api' },
        secretRefs: { token: 'GITLAB_TOKEN' },
      },
      provider: gitlab,
      egress: allowAnyIntegrationHost(),
      secretSource: source,
      secretKey: key,
      newId: () => crypto.randomUUID(),
    });
    expect(result.status).toBe('created');
    created = result.integration.id;

    const row = await pool.query<{ config: unknown; secret_ids: string[] }>(
      'select config, secret_ids from integrations where id = $1',
      [created],
    );
    expect(JSON.stringify(row.rows[0]?.config)).not.toContain(PLANTED_TOKEN);
    const secretIds = row.rows[0]?.secret_ids ?? [];
    expect(secretIds).toHaveLength(1);

    const sealed = await pool.query<{ ciphertext: Buffer }>(
      'select ciphertext from secrets where id = $1',
      [secretIds[0]],
    );
    // Bytes on disk: the whole point of the envelope is that the plaintext is not among them.
    expect(sealed.rows[0]?.ciphertext.includes(Buffer.from(PLANTED_TOKEN))).toBe(false);

    // …and the store the binding loader uses opens it — the other direction, which a test that
    // only checked for absence could satisfy by storing nothing at all (standing rule 42).
    const store = secretAdapters.createPostgresSecretStore({ sql: pool, key });
    expect(await store.resolve(secretIds as never)).toEqual({ token: PLANTED_TOKEN });
  });

  it('is idempotent on (org, type, name) and seals nothing a second time', async () => {
    if (gitlab === undefined) return;
    const before = await pool.query<{ count: number }>(
      'select count(*)::int as count from secrets',
    );
    const again = await createIntegration(db, {
      orgId,
      integration: {
        type: 'git' as IntegrationType,
        provider: 'gitlab',
        name: 'wiz gitlab',
        config: { base_url: 'https://gitlab.example.test' },
        secretRefs: { token: 'GITLAB_TOKEN' },
      },
      provider: gitlab,
      egress: allowAnyIntegrationHost(),
      secretSource: source,
      secretKey: key,
      newId: () => crypto.randomUUID(),
    });
    expect(again.status).toBe('exists');
    expect(again.integration.id).toBe(created);
    const after = await pool.query<{ count: number }>('select count(*)::int as count from secrets');
    // A second `secrets` row nothing points at is a credential nobody can rotate.
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  });

  it('refuses a credential field the provider does not declare', async () => {
    if (gitlab === undefined) return;
    await expect(
      createIntegration(db, {
        orgId,
        integration: {
          type: 'git' as IntegrationType,
          provider: 'gitlab',
          name: 'wiz gitlab bad field',
          config: { base_url: 'https://gitlab.example.test' },
          secretRefs: { not_a_field: 'GITLAB_TOKEN' },
        },
        provider: gitlab,
        egress: allowAnyIntegrationHost(),
        secretSource: source,
        secretKey: key,
        newId: () => crypto.randomUUID(),
      }),
    ).rejects.toThrow(/declares no credential field/);
  });

  /**
   * WP-73b, PROGRESS backlog 245: Sentry and Slack default `base_url`, and the host guard used to
   * sweep only the URLs a body contains — so a body that left `base_url` out was written with an
   * undeclared *effective* host and refused only at the first call. One case per defaulted provider,
   * read off the catalogue so a third provider with a defaulted URL is covered the day it exists.
   */
  const defaulted = SHIPPED_PROVIDERS.filter((entry) =>
    Object.values(entry.configDefaults).some(
      (value) => typeof value === 'string' && /^https?:\/\//.test(value),
    ),
  );

  it('finds exactly the providers whose URL is defaulted (the scope, before the cases)', () => {
    expect(defaulted.map((entry) => entry.id)).toEqual(['sentry', 'slack']);
  });

  it.each(defaulted.map((entry) => [entry.id, entry] as const))(
    'refuses a %s body that leaves base_url to its undeclared default, and writes nothing',
    async (id, provider) => {
      const before = await pool.query<{ count: number }>(
        'select count(*)::int as count from integrations',
      );
      await expect(
        createIntegration(db, {
          orgId,
          integration: {
            type: provider.type,
            provider: id,
            name: `wiz ${id} defaulted host`,
            config: {},
            secretRefs: {},
          },
          provider,
          // Declares a host — just not the default one.
          egress: createIntegrationEgressPolicy([`${id}.example.test`]),
          secretSource: source,
          secretKey: key,
          newId: () => crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 403, code: 'integration_host_not_permitted' });
      const after = await pool.query<{ count: number }>(
        'select count(*)::int as count from integrations',
      );
      expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
    },
  );

  it('refuses an empty environment value rather than sealing an empty credential', async () => {
    // Standing rule 18: an unset credential that produces a permissive result is the defect.
    if (gitlab === undefined) return;
    await expect(
      createIntegration(db, {
        orgId,
        integration: {
          type: 'git' as IntegrationType,
          provider: 'gitlab',
          name: 'wiz gitlab empty',
          config: { base_url: 'https://gitlab.example.test' },
          secretRefs: { token: 'EMPTY_TOKEN' },
        },
        provider: gitlab,
        egress: allowAnyIntegrationHost(),
        secretSource: source,
        secretKey: key,
        newId: () => crypto.randomUUID(),
      }),
    ).rejects.toBeInstanceOf(MissingSecretError);
  });

  it('writes only the health column', async () => {
    if (created === null) return;
    await writeIntegrationHealth(db, created, {
      ok: false,
      checkedAt: '2026-09-13T04:00:00.000Z',
      detail: 'the token was rejected',
    });
    const row = await pool.query<{ health: { status: string }; config: Record<string, unknown> }>(
      'select health, config from integrations where id = $1',
      [created],
    );
    expect(row.rows[0]?.health.status).toBe('down');
    // The create's columns are untouched — the narrow-write property (standing rule 79).
    expect(row.rows[0]?.config.project).toBe('acme/api');
  });

  /**
   * WP-100: `PATCH /api/integrations/:id`'s write, on a real row. It sets and removes keys, resets
   * the health verdict the old document earned, leaves `secret_ids` to the create (rule 79) and
   * writes one audit row with the changed key names — and a document the schema refuses writes
   * nothing at all (the refusal is a countable effect, not only a status code).
   */
  it('updates the configuration through the create’s checks, narrowly, with one audit row', async () => {
    if (created === null) return;
    const before = await pool.query<{ secret_ids: string[] }>(
      'select secret_ids from integrations where id = $1',
      [created],
    );
    await expect(
      updateIntegrationConfig(db, {
        integrationId: created,
        set: {},
        remove: ['base_url'],
        egress: allowAnyIntegrationHost(),
        audit: { userId, action: 'integration.config.write', params: { integration_id: created } },
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_integration_config' });

    const written = await updateIntegrationConfig(db, {
      integrationId: created,
      set: { max_pages: 5 },
      remove: ['project'],
      egress: allowAnyIntegrationHost(),
      audit: { userId, action: 'integration.config.write', params: { integration_id: created } },
    });
    expect(written).toEqual({ status: 'written', changed: ['max_pages', 'project'] });
    const row = await pool.query<{
      config: Record<string, unknown>;
      health: Record<string, unknown>;
      secret_ids: string[];
    }>('select config, health, secret_ids from integrations where id = $1', [created]);
    expect(row.rows[0]?.config).toEqual({ base_url: 'https://gitlab.example.test', max_pages: 5 });
    expect(row.rows[0]?.health).toEqual({});
    expect(row.rows[0]?.secret_ids).toEqual(before.rows[0]?.secret_ids);
    const audited = await pool.query<{ params: Record<string, unknown> }>(
      "select params from human_actions where action = 'integration.config.write'",
    );
    expect(audited.rows.map((each) => each.params)).toEqual([
      { integration_id: created, changed_keys: ['max_pages', 'project'] },
    ]);
    expect(
      await updateIntegrationConfig(db, {
        integrationId: '00000000-0000-4000-8000-0000000000fe',
        set: { max_pages: 5 },
        remove: [],
        egress: allowAnyIntegrationHost(),
        audit: { userId, action: 'integration.config.write', params: {} },
      }),
    ).toEqual({ status: 'not_found' });
  });

  /** WP-100, criterion 1 on a real database: each provider's refused create leaves no row. */
  it.each(SHIPPED_PROVIDERS.map((entry) => [entry.id, entry] as const))(
    'refuses a %s create whose config the schema refuses, and writes no row',
    async (id, provider) => {
      const count = async () =>
        (await pool.query<{ count: number }>('select count(*)::int as count from integrations'))
          .rows[0]?.count;
      const before = await count();
      await expect(
        createIntegration(db, {
          orgId,
          integration: {
            type: provider.type,
            provider: id,
            name: `wiz ${id} refused config`,
            config: { not_a_field: true },
            secretRefs: {},
          },
          provider,
          egress: allowAnyIntegrationHost(),
          secretSource: source,
          secretKey: key,
          newId: () => crypto.randomUUID(),
        }),
      ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_integration_config' });
      expect(await count()).toBe(before);
    },
  );
});

describe('bindings and configuration', () => {
  const egress = allowAnyIntegrationHost();
  it('replaces the whole binding set, so a removed binding is gone', async () => {
    const integration = await pool.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name)
       values ($1, 'task_management', 'jira_cloud', 'wiz jira') returning id`,
      [orgId],
    );
    const jiraId = integration.rows[0]?.id as string;
    await replaceProjectBindings(db, projectId, [{ integrationId: jiraId }], { egress });
    expect((await listProjectBindings(db, projectId)).map((item) => item.provider)).toEqual([
      'jira_cloud',
    ]);
    await replaceProjectBindings(db, projectId, [], { egress });
    expect(await listProjectBindings(db, projectId)).toEqual([]);
    await pool.query('delete from integrations where id = $1', [jiraId]);
  });

  /**
   * WP-148 (backlog 444): re-saving a project's bindings keeps each unchanged binding's poll state —
   * the ticket cursor, the merge-request cursor and the default-branch head — because the row is
   * updated in place. A binding to an integration not bound before starts fresh, and so does one
   * removed and added back (a changed identity). The canary is the delete-and-re-insert this
   * replaced: it would null all three on the first re-save.
   */
  it('keeps every poll field of a binding re-saved unchanged, and starts a new identity fresh (WP-148)', async () => {
    const created = await pool.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name)
       values ($1, 'task_management', 'jira_cloud', 'wiz poll a'),
              ($1, 'task_management', 'jira_cloud', 'wiz poll b')
       returning id`,
      [orgId],
    );
    const [first, second] = created.rows.map((row) => row.id) as [string, string];
    const pollState = async () =>
      (
        await pool.query<{
          integration_id: string;
          id: string;
          poll_cursor: Date | null;
          mr_poll_cursor: Date | null;
          mr_poll_default_head: string | null;
          config: unknown;
        }>(
          `select integration_id, id, poll_cursor, mr_poll_cursor, mr_poll_default_head, config
             from bindings where project_id = $1 order by integration_id`,
          [projectId],
        )
      ).rows;

    await replaceProjectBindings(db, projectId, [{ integrationId: first }], { egress });
    await pool.query(
      `update bindings set poll_cursor = '2026-10-04T10:00:00Z', mr_poll_cursor = '2026-10-04T11:00:00Z',
              mr_poll_default_head = 'b5f4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6'
        where project_id = $1 and integration_id = $2`,
      [projectId, first],
    );
    const [before] = await pollState();

    // The wizard's re-submission: the identical set.
    await replaceProjectBindings(db, projectId, [{ integrationId: first }], { egress });
    const [kept] = await pollState();
    expect(kept?.id, 'the same row, updated in place').toBe(before?.id);
    expect(kept?.poll_cursor?.toISOString()).toBe('2026-10-04T10:00:00.000Z');
    expect(kept?.mr_poll_cursor?.toISOString()).toBe('2026-10-04T11:00:00.000Z');
    expect(kept?.mr_poll_default_head).toBe('b5f4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6');

    // A changed overlay is the same identity: the config moves, the poll state stays.
    await replaceProjectBindings(
      db,
      projectId,
      [{ integrationId: first, config: { poll_interval_seconds: 120 } }, { integrationId: second }],
      { egress },
    );
    const both = await pollState();
    const overlaid = both.find((row) => row.integration_id === first);
    const added = both.find((row) => row.integration_id === second);
    expect(overlaid?.config).toEqual({ poll_interval_seconds: 120 });
    expect(overlaid?.poll_cursor?.toISOString()).toBe('2026-10-04T10:00:00.000Z');
    expect(overlaid?.mr_poll_default_head).toBe('b5f4c3d2e1f0a9b8c7d6e5f4a3b2c1d0e9f8a7b6');
    expect(added, 'a new identity is a new row').toMatchObject({
      poll_cursor: null,
      mr_poll_cursor: null,
      mr_poll_default_head: null,
    });

    // Removed, then added back: a changed identity starts fresh, stated.
    await replaceProjectBindings(db, projectId, [{ integrationId: second }], { egress });
    await replaceProjectBindings(
      db,
      projectId,
      [{ integrationId: first }, { integrationId: second }],
      {
        egress,
      },
    );
    expect((await pollState()).find((row) => row.integration_id === first)).toMatchObject({
      poll_cursor: null,
      mr_poll_cursor: null,
      mr_poll_default_head: null,
    });

    // One binding per integration: a repeated id is refused by name and writes nothing.
    await expect(
      replaceProjectBindings(db, projectId, [{ integrationId: first }, { integrationId: first }], {
        egress,
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'invalid_request' });
    expect(await pollState()).toHaveLength(2);

    await replaceProjectBindings(db, projectId, [], { egress });
    await pool.query('delete from integrations where id = any($1::uuid[])', [[first, second]]);
  });

  /**
   * WP-100 review round 1, backlog 330: a binding overlay carrying a credential field is refused at
   * the write and writes nothing, and a binding row stored before that refusal — written here the
   * way `psql` or a pre-WP-100 `PUT` wrote it — is served without the credential. The canary for
   * each direction: the non-credential key beside the token is still served, and the refusal is
   * the credential's, not a parse failure's.
   */
  it('refuses a credential in a binding overlay, and never serves one stored before', async () => {
    const TOKEN = 'sntrys_FAKE-stored-binding-token-000001';
    const inserted = await pool.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name, config)
       values ($1, 'errors', 'sentry', 'wiz sentry bindings',
               '{"organization":"acme","base_url":"https://sentry.example.test"}'::jsonb)
       returning id`,
      [orgId],
    );
    const sentryId = inserted.rows[0]?.id as string;
    await expect(
      replaceProjectBindings(
        db,
        projectId,
        [{ integrationId: sentryId, config: { auth_token: TOKEN, max_issues: 5 } }],
        { egress },
      ),
    ).rejects.toMatchObject({ statusCode: 400, code: 'credential_in_config' });
    expect(await listProjectBindings(db, projectId)).toEqual([]);

    await pool.query(
      `insert into bindings (project_id, integration_id, config) values ($1, $2, $3::jsonb)`,
      [projectId, sentryId, JSON.stringify({ auth_token: TOKEN, max_issues: 5 })],
    );
    const served = await listProjectBindings(db, projectId);
    expect(JSON.stringify(served)).not.toContain(TOKEN);
    expect(served.map((item) => item.config)).toEqual([{ max_issues: 5 }]);
    await pool.query('delete from bindings where project_id = $1', [projectId]);
    await pool.query('delete from integrations where id = $1', [sentryId]);
  });

  it('refuses a binding to an integration that does not exist, and writes nothing', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff';
    await expect(
      replaceProjectBindings(db, projectId, [{ integrationId: missing }], { egress }),
    ).rejects.toThrow(/no integration with id/);
    expect(await listProjectBindings(db, projectId)).toEqual([]);
  });

  it('writes the configuration and the dial, and refuses a stale base hash', async () => {
    const written = await writeProjectConfig(db, projectId, {
      config: { version: 1 },
      hash: 'hash-one',
      autonomyLevel: 'autonomous',
    });
    expect(written.status).toBe('written');
    const row = await pool.query<{ autonomy_level: string; config_hash: string }>(
      'select autonomy_level, config_hash from projects where id = $1',
      [projectId],
    );
    expect(row.rows[0]?.autonomy_level).toBe('autonomous');
    expect(row.rows[0]?.config_hash).toBe('hash-one');

    const stale = await writeProjectConfig(db, projectId, {
      config: { version: 1 },
      hash: 'hash-two',
      baseHash: 'hash-zero',
    });
    expect(stale.status).toBe('conflict');
    // The other side of the check (rule 42): the *current* hash is accepted.
    const fresh = await writeProjectConfig(db, projectId, {
      config: { version: 1 },
      hash: 'hash-two',
      baseHash: 'hash-one',
    });
    expect(fresh.status).toBe('written');
  });

  it('leaves readiness_level alone, because another writer owns it', async () => {
    // Standing rule 79: the config write and the readiness write share the row and run
    // concurrently, so neither may name the other's column.
    await pool.query('update projects set readiness_level = 3 where id = $1', [projectId]);
    await writeProjectConfig(db, projectId, { config: { version: 1 }, hash: 'hash-three' });
    const row = await pool.query<{ readiness_level: number }>(
      'select readiness_level from projects where id = $1',
      [projectId],
    );
    expect(Number(row.rows[0]?.readiness_level)).toBe(3);
  });

  it('answers not_found for a project that does not exist', async () => {
    const result = await writeProjectConfig(db, '00000000-0000-4000-8000-0000000000fe', {
      config: { version: 1 },
      hash: 'x',
    });
    expect(result.status).toBe('not_found');
  });
});

describe('the audit row', () => {
  it('records a human action with the params an operator needs', async () => {
    await recordHumanAction(db, {
      userId,
      action: 'project.create',
      params: { project_id: projectId, idempotency_key: 'wizard-1' },
    });
    const { rows } = await pool.query<{ action: string; params: Record<string, unknown> }>(
      "select action, params from human_actions where action = 'project.create' order by created_at desc limit 1",
    );
    expect(rows[0]?.action).toBe('project.create');
    expect(rows[0]?.params.idempotency_key).toBe('wizard-1');
  });

  it('finds an attempt only for the caller who made it, which only the `where` can decide', async () => {
    // The scope of an `Idempotency-Key` is `(user_id, action, key)`. A unit tier answers this from
    // whatever its double keys a `Map` by; the predicate is SQL, so this is the tier that reads it.
    const second = await pool.query<{ id: string }>(
      "insert into users (email, name) values ('second@example.test', 'Second') returning id",
    );
    const otherUserId = second.rows[0]?.id as string;
    await recordHumanAction(db, {
      userId,
      action: 'task.pause',
      params: { task_id: null, idempotency_key: 'shared-key', body_digest: 'digest-one' },
    });

    const mine = await findIdempotentAttempt(db, {
      userId,
      action: 'task.pause',
      key: 'shared-key',
    });
    expect(mine?.bodyDigest).toBe('digest-one');
    // The same string, the same command, another account: no attempt, so their command performs
    // rather than being refused `idempotency_key_reused` for a key they have never seen.
    expect(
      await findIdempotentAttempt(db, {
        userId: otherUserId,
        action: 'task.pause',
        key: 'shared-key',
      }),
    ).toBeNull();
    // …and the action is still part of the scope (rule 42), so one client's key per step is safe.
    expect(
      await findIdempotentAttempt(db, { userId, action: 'task.resume', key: 'shared-key' }),
    ).toBeNull();
  });
});

/**
 * R3's evidence for the readiness re-check (WP-64): `ci.pipeline.finished` events that carry a merge
 * request, for one project, inside the window — read off the real `events` table, because the
 * predicate is JSON in SQL and only this tier executes it. Every excluded shape has a row that
 * would be counted if its clause were dropped (rule 42).
 */
describe('the re-check’s CI-event read', () => {
  const MR = {
    provider: 'fake-git',
    project_path: 'acme/readiness',
    iid: 7,
    url: 'https://git.example.test/acme/readiness/-/merge_requests/7',
    branch: 'agentic/x',
    head_sha: 'a'.repeat(40),
  };
  const append = async (input: {
    readonly type: string;
    readonly project: string;
    readonly mr: unknown;
    readonly occurredAt: string;
  }) => {
    // The next sequence of the project's own stream — the trigger refuses a gap.
    const next = await pool.query<{ seq: number }>(
      `select coalesce(max(stream_seq), 0)::int + 1 as seq
         from events where stream_type = 'project' and stream_id = $1`,
      [input.project],
    );
    const seq = next.rows[0]?.seq ?? 1;
    await pool.query(
      `insert into events (id, stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
       values (gen_random_uuid(), 'project', $1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        input.project,
        seq,
        input.type,
        JSON.stringify({
          project_id: input.project,
          task_id: null,
          ...(input.mr === undefined ? {} : { mr: input.mr }),
          head_sha: 'b'.repeat(40),
          status: 'success',
          failed_jobs: [],
        }),
        JSON.stringify({ kind: 'system', component: 'test' }),
        input.occurredAt,
      ],
    );
  };

  it('counts merge-request pipelines of this project in the window, and nothing else', async () => {
    // Every row is written **now**, because `events` is partitioned by month and a fresh database
    // has partitions from the current month forward only; the window's clause is exercised by
    // asking from an instant after the rows instead of by writing a row before it.
    const now = new Date().toISOString();
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1_000).toISOString();
    const events = createReadinessCiEvents(pool);
    expect(await events.mergeRequestPipelinesSince(projectId as Id, since as never)).toBe(0);

    await append({ type: 'ci.pipeline.finished', project: projectId, mr: MR, occurredAt: now });
    await append({ type: 'ci.pipeline.finished', project: projectId, mr: MR, occurredAt: now });
    // Excluded, one clause each: no merge request (null and absent), another project, another
    // event type.
    await append({ type: 'ci.pipeline.finished', project: projectId, mr: null, occurredAt: now });
    await append({
      type: 'ci.pipeline.finished',
      project: projectId,
      mr: undefined,
      occurredAt: now,
    });
    await append({
      type: 'ci.pipeline.finished',
      project: otherProjectId,
      mr: MR,
      occurredAt: now,
    });
    await append({ type: 'mr.opened', project: projectId, mr: MR, occurredAt: now });

    expect(await events.mergeRequestPipelinesSince(projectId as Id, since as never)).toBe(2);
    // …and a window that starts after them sees none of them.
    const later = new Date(Date.now() + 60_000).toISOString();
    expect(await events.mergeRequestPipelinesSince(projectId as Id, later as never)).toBe(0);
  });
});

/**
 * WP-64 review round 1: the interview's audit row is claimed **inside** the command's transaction —
 * since WP-67 by inserting the key's `command_idempotency` row there, whose primary key the second
 * of two racing transactions blocks on (an advisory lock until then) — so the second of two
 * submits, sequential or racing, is refused and its caller rolls back. Asserted with two real
 * concurrent transactions.
 */
describe('claiming an attempt inside the command’s transaction', () => {
  const claim = async (client: pg.PoolClient, key: string) =>
    claimIdempotentAttemptInTransaction(client, {
      userId,
      action: 'project.interview.record',
      key,
      params: { idempotency_key: key, body_digest: 'digest' },
    });

  it('grants the first attempt and refuses a replay after it committed', async () => {
    const client = await pool.connect();
    try {
      await client.query('begin');
      expect(await claim(client, 'claim-sequential')).toBe(true);
      await client.query('commit');
      await client.query('begin');
      expect(await claim(client, 'claim-sequential')).toBe(false);
      await client.query('rollback');
    } finally {
      client.release();
    }
  });

  it('lets exactly one of two racing transactions record the attempt', async () => {
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      await first.query('begin');
      await second.query('begin');
      expect(await claim(first, 'claim-race')).toBe(true);
      // The second waits on the first's uncommitted key until it commits, then finds its row.
      const racing = claim(second, 'claim-race');
      await first.query('commit');
      expect(await racing).toBe(false);
      await second.query('rollback');
    } finally {
      first.release();
      second.release();
    }
    const rows = await pool.query(
      `select count(*)::int as count from human_actions
        where action = 'project.interview.record' and params ->> 'idempotency_key' = 'claim-race'`,
    );
    expect(rows.rows).toEqual([{ count: 1 }]);
  });
});

/**
 * Why a parked discovery waits for a person (WP-155, PROGRESS backlog 452): the newest
 * `task.escalated` off the task's own stream, read from the real `events` table because the order
 * and the JSON reads are SQL. Each excluded shape has a row that would answer if its clause were
 * dropped (rule 42).
 */
describe('the discovery escalation read', () => {
  const appendTask = async (
    taskId: string,
    type: string,
    payload: Record<string, unknown>,
    occurredAt: string,
  ) => {
    const next = await pool.query<{ seq: number }>(
      `select coalesce(max(stream_seq), 0)::int + 1 as seq
         from events where stream_type = 'task' and stream_id = $1`,
      [taskId],
    );
    await pool.query(
      `insert into events (id, stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
       values (gen_random_uuid(), 'task', $1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
      [
        taskId,
        next.rows[0]?.seq ?? 1,
        type,
        JSON.stringify({ project_id: projectId, task_id: taskId, ...payload }),
        JSON.stringify({ kind: 'system', component: 'test' }),
        occurredAt,
      ],
    );
  };
  const read = () => createDiscoveryEscalationRead(pool);

  it('answers the newest escalation of that task, and nothing of another task’s or another type', async () => {
    const task = crypto.randomUUID();
    const other = crypto.randomUUID();
    const earlier = new Date(Date.now() - 60_000).toISOString();
    const later = new Date(Date.now() - 1_000).toISOString();
    await appendTask(task, 'task.escalated', { reason: 'first', blocker_brief: 'old' }, earlier);
    await appendTask(
      task,
      'task.escalated',
      { reason: 'run_failed', blocker_brief: 'read it' },
      later,
    );
    // Newer than both, but not an escalation: the type clause is what keeps it out.
    await appendTask(
      task,
      'task.paused',
      { reason: 'manual', blocker_brief: 'x' },
      new Date().toISOString(),
    );
    // Another task's escalation, newest of all: the stream clause is what keeps it out.
    await appendTask(
      other,
      'task.escalated',
      { reason: 'other', blocker_brief: 'theirs' },
      new Date().toISOString(),
    );

    expect(await read()(task)).toEqual({ at: later, reason: 'run_failed', brief: 'read it' });
    expect(await read()(other)).toMatchObject({ reason: 'other', brief: 'theirs' });
  });

  it('answers null for a task that never escalated, and for half a reason', async () => {
    expect(await read()(crypto.randomUUID())).toBeNull();
    const half = crypto.randomUUID();
    await appendTask(half, 'task.escalated', { reason: 'run_failed' }, new Date().toISOString());
    expect(await read()(half)).toBeNull();
  });
});
