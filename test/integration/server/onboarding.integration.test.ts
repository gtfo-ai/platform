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
import { allowAnyIntegrationHost } from '@platform/application';
import type { Id, IntegrationType } from '@platform/contracts';
import {
  knowledge as knowledgeAdapters,
  secrets as secretAdapters,
} from '@platform/infrastructure';
import { SHIPPED_PROVIDERS } from '@platform/integrations';
import { drizzle } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
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
  writeIntegrationHealth,
  writeProjectConfig,
} from '../../../apps/server/src/queries/onboarding-queries.js';
import { runReadinessStoreContract } from '../../contract/support/readiness-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

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
    const client = new pg.Client({ connectionString: database.connectionString });
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
        config: {},
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
          config: {},
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
          config: {},
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
});

describe('bindings and configuration', () => {
  it('replaces the whole binding set, so a removed binding is gone', async () => {
    const integration = await pool.query<{ id: string }>(
      `insert into integrations (org_id, type, provider, name)
       values ($1, 'task_management', 'jira_cloud', 'wiz jira') returning id`,
      [orgId],
    );
    const jiraId = integration.rows[0]?.id as string;
    await replaceProjectBindings(db, projectId, [{ integrationId: jiraId }]);
    expect((await listProjectBindings(db, projectId)).map((item) => item.provider)).toEqual([
      'jira_cloud',
    ]);
    await replaceProjectBindings(db, projectId, []);
    expect(await listProjectBindings(db, projectId)).toEqual([]);
    await pool.query('delete from integrations where id = $1', [jiraId]);
  });

  it('refuses a binding to an integration that does not exist, and writes nothing', async () => {
    const missing = '00000000-0000-4000-8000-0000000000ff';
    await expect(
      replaceProjectBindings(db, projectId, [{ integrationId: missing }]),
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
