/**
 * `held_connection_liveness` against a real PostgreSQL 18 (migration 0054, WP-72, PROGRESS
 * backlog 200).
 *
 * What only a database can answer: that freshness is read on the **database's** clock (a row whose
 * `expires_at` has passed is not held, whatever the caller's clock says), that the last renewal
 * wins the row across holders, that a holder releases only its own row, and that the row goes with
 * its integration.
 */
import type { Id } from '@platform/contracts';
import { integrations as integrationAdapters } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let orgId: string;

const insertIntegration = async (name: string): Promise<Id> => {
  const { rows } = await pool.query<{ id: string }>(
    `insert into integrations (org_id, type, provider, name, config, secret_ids)
       values ($1, 'communication'::integration_type, 'slack', $2, '{}'::jsonb, '{}'::uuid[])
     returning id`,
    [orgId, name],
  );
  return rows[0]?.id as Id;
};

beforeAll(async () => {
  database = await createMigratedDatabase('liveness');
  pool = createTestPool(database.connectionString, { max: 3 });
  const org = await pool.query<{ id: string }>(
    "insert into organizations (name) values ('liveness') returning id",
  );
  orgId = org.rows[0]?.id as string;
});

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('held_connection_liveness', () => {
  it('is held after a renewal and not before, in both directions', async () => {
    const liveness = integrationAdapters.createPostgresHeldConnectionLiveness(pool);
    const account = await insertIntegration('never-held');
    expect(await liveness.isHeld(account)).toBe(false);

    await liveness.renew(account, 'api@host:1', 60_000);
    expect(await liveness.isHeld(account)).toBe(true);
  });

  it('reads freshness off the database clock: an expired row is not held', async () => {
    const liveness = integrationAdapters.createPostgresHeldConnectionLiveness(pool);
    const account = await insertIntegration('expired');
    await liveness.renew(account, 'api@host:1', 60_000);
    // Age the row by hand — what a holder that died a minute ago leaves behind.
    await pool.query(
      `update held_connection_liveness
          set renewed_at = now() - interval '2 minutes', expires_at = now() - interval '1 minute'
        where integration_id = $1`,
      [account],
    );
    expect(await liveness.isHeld(account)).toBe(false);
    // …and a renewal brings it back, overwriting the stale row rather than failing on it.
    await liveness.renew(account, 'api@host:2', 60_000);
    expect(await liveness.isHeld(account)).toBe(true);
  });

  it('lets the last holder win the row, and releases only a holder’s own', async () => {
    const liveness = integrationAdapters.createPostgresHeldConnectionLiveness(pool);
    const account = await insertIntegration('two-replicas');
    await liveness.renew(account, 'replica-a', 60_000);
    await liveness.renew(account, 'replica-b', 60_000);

    // Replica A stopping must not erase replica B's live renewal.
    await liveness.release(account, 'replica-a');
    expect(await liveness.isHeld(account)).toBe(true);
    const { rows } = await pool.query<{ holder: string }>(
      'select holder from held_connection_liveness where integration_id = $1',
      [account],
    );
    expect(rows.map((row) => row.holder)).toEqual(['replica-b']);

    await liveness.release(account, 'replica-b');
    expect(await liveness.isHeld(account)).toBe(false);
  });

  it('goes with its integration, and refuses a TTL that is not a positive whole number', async () => {
    const liveness = integrationAdapters.createPostgresHeldConnectionLiveness(pool);
    const account = await insertIntegration('deleted');
    await liveness.renew(account, 'api@host:1', 60_000);
    await pool.query('delete from integrations where id = $1', [account]);
    const { rows } = await pool.query<{ count: number }>(
      'select count(*)::int from held_connection_liveness where integration_id = $1',
      [account],
    );
    expect(rows[0]?.count).toBe(0);

    await expect(liveness.renew(account, 'api@host:1', 0)).rejects.toThrow(TypeError);
    await expect(liveness.renew(account, 'api@host:1', 1.5)).rejects.toThrow(TypeError);
  });
});
