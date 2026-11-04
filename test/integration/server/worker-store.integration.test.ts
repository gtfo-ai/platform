/**
 * The `WorkerStore` contract against PostgreSQL 18 (WP-280, migration 0096), plus what only this
 * tier can show: the migration's checks refuse a malformed row, the poll's row lock makes two
 * concurrent polls of one approved code mint **one** worker, and the outstanding-code count is
 * serialised with its insert.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import { createPostgresWorkerStore } from '../../../apps/server/src/queries/worker-queries.js';
import { describeWorkerStoreContract } from '../../contract/support/worker-store-suite.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let db: Database;
let projectId: string;
let users = 0;

beforeAll(async () => {
  database = await createMigratedDatabase('workers');
  pool = createTestPool(database.connectionString, { max: 6 });
  db = drizzle(pool) as unknown as Database;
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('workers') returning id",
  );
  const project = await pool.query<{ id: string }>(
    `insert into projects (org_id, key, name, repo_url)
     values ($1, 'wkr', 'Workers', 'https://git.example.test/acme/api.git') returning id`,
    [org.rows[0]?.id],
  );
  projectId = project.rows[0]?.id as string;
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const reset = async (): Promise<void> => {
  await pool.query('delete from runs');
  await pool.query('delete from tasks');
  await pool.query('delete from worker_device_codes');
  await pool.query('delete from workers');
  await pool.query('delete from human_actions');
};

const addUser = async (email: string): Promise<string> => {
  users += 1;
  const user = await pool.query<{ id: string }>(
    'insert into users (email, name) values ($1, $2) returning id',
    [`${users}-${email}`, 'Someone'],
  );
  return user.rows[0]?.id as string;
};

let tickets = 0;
const seedRun = async (workerId: string, status: string): Promise<string> => {
  tickets += 1;
  const task = await pool.query<{ id: string }>(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, template_snapshot, mode)
     values ($1, 'fake-jira', $2, 'https://jira.example.test/browse/WKR', 'feature',
             'active', 'implementation', '{}'::jsonb, 'normal') returning id`,
    [projectId, `WKR-${tickets}`],
  );
  const run = await pool.query<{ id: string }>(
    `insert into runs (task_id, project_id, role, model, effort, prompt_version, attempt, status,
                       lease_owner, lease_expires_at, worker_id)
     values ($1, $2, 'developer', 'claude-opus-5', 'high', 'feature@1+developer', 1, $3::run_status,
             $4, now() + interval '1 hour', $5) returning id`,
    [task.rows[0]?.id, projectId, status, `worker:${workerId}`, workerId],
  );
  return run.rows[0]?.id as string;
};

describeWorkerStoreContract({
  name: 'PostgreSQL',
  create: async () => {
    await reset();
    return {
      store: createPostgresWorkerStore(db),
      addUser,
      setUserMayAct: async (userId, mayAct) => {
        await pool.query('update users set status = $2 where id = $1', [
          userId,
          mayAct ? 'active' : 'disabled',
        ]);
      },
      banUser: async (userId, expiresAt) => {
        await pool.query('update users set banned = true, ban_expires = $2 where id = $1', [
          userId,
          expiresAt,
        ]);
      },
      seedRun,
      leaseExpired: async (runId) => {
        const row = await pool.query<{ expired: boolean }>(
          'select lease_expires_at <= now() as expired from runs where id = $1',
          [runId],
        );
        return row.rows[0]?.expired === true;
      },
      audit: async () => {
        const rows = await pool.query<{ action: string; user_id: string; params: never }>(
          'select action, user_id, params from human_actions order by created_at, id',
        );
        return rows.rows.map((row) => ({
          action: row.action,
          userId: row.user_id,
          params: row.params,
        }));
      },
    };
  },
});

describe('what only PostgreSQL can show (WP-280)', () => {
  const hex = (seed: string): string => seed.padEnd(64, '0');

  it('mints one worker when two polls of one approved code race', async () => {
    await reset();
    const store = createPostgresWorkerStore(db);
    const user = await addUser('race@example.test');
    const now = new Date();
    await store.createDeviceCode(
      {
        id: '00000000-0000-4000-8000-00000000ace1',
        deviceCodeHash: hex('a1'),
        userCodeHash: hex('b1'),
        clientAddress: '192.0.2.1',
        userAgent: null,
        createdAt: now,
        expiresAt: new Date(now.getTime() + 600_000),
        intervalSeconds: 5,
      },
      now,
    );
    await store.decideDeviceCode({
      userCodeHash: hex('b1'),
      decision: 'approve',
      name: 'race',
      confirmedStale: false,
      actorUserId: user,
      now,
      auditParams: {},
    });
    const later = new Date(now.getTime() + 10_000);
    const outcomes = await Promise.all(
      ['c1', 'c2', 'c3', 'c4'].map((seed, index) =>
        store.pollDeviceCode({
          deviceCodeHash: hex('a1'),
          now: later,
          mint: {
            workerId: `00000000-0000-4000-8000-00000000ace${index + 2}`,
            credentialHash: hex(seed),
          },
        }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.outcome === 'issued')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.outcome === 'expired_token')).toHaveLength(3);
    expect((await pool.query('select count(*)::int as n from workers')).rows[0]).toEqual({ n: 1 });
  });

  it('holds the per-address limit under concurrent requests', async () => {
    await reset();
    const store = createPostgresWorkerStore(db);
    const now = new Date();
    const results = await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        store.createDeviceCode(
          {
            id: `00000000-0000-4000-8000-${(0xb000 + index).toString(16).padStart(12, '0')}`,
            deviceCodeHash: hex(`d${index.toString(16).padStart(2, '0')}`),
            userCodeHash: hex(`e${index.toString(16).padStart(2, '0')}`),
            clientAddress: '192.0.2.9',
            userAgent: null,
            createdAt: now,
            expiresAt: new Date(now.getTime() + 600_000),
            intervalSeconds: 5,
          },
          now,
        ),
      ),
    );
    expect(results.filter((result) => result.status === 'created')).toHaveLength(20);
  });

  it('refuses a credential hash that is not SHA-256 hex, and a revoked row without its instant', async () => {
    await reset();
    const user = await addUser('checks@example.test');
    await expect(
      pool.query(
        "insert into workers (id, user_id, name, credential_hash) values (gen_random_uuid(), $1, 'm', 'wkr_plaintext')",
        [user],
      ),
    ).rejects.toThrow(/workers_credential_hash_shape/);
    await expect(
      pool.query(
        "insert into workers (id, user_id, name, credential_hash, state) values (gen_random_uuid(), $1, 'm', $2, 'revoked')",
        [user, hex('ab')],
      ),
    ).rejects.toThrow(/workers_revoked_shape/);
  });
});
