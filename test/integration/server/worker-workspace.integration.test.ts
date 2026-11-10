/**
 * **A machine that cannot provision a workspace, against PostgreSQL 18** (S-28.12, migration
 * 0117): the store's one writer of `workers.workspace_unavailable_*` — the cause and the cool-down
 * recorded (the first instant kept across a repeat), the cool-down lifted by a retry while the cause
 * stays, and the record cleared — and the listed row reading all of it back.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import { createPostgresWorkerStore } from '../../../apps/server/src/queries/worker-queries.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let workerId: string;

beforeAll(async () => {
  database = await createMigratedDatabase('worker-workspace');
  pool = createTestPool(database.connectionString, { max: 2 });
  const user = await pool.query<{ id: string }>(
    "insert into users (email, name, role) values ('ws@example.test', 'Jan', 'member') returning id",
  );
  const worker = await pool.query<{ id: string }>(
    `insert into workers (user_id, name, credential_hash)
     values ($1, 'jan-mbp', repeat('a', 64)) returning id`,
    [user.rows[0]?.id],
  );
  workerId = worker.rows[0]?.id as string;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('workers.workspace_unavailable_* (S-28.12)', () => {
  it('records the cause and the cool-down, lifts the cool-down on a retry, and clears', async () => {
    const store = createPostgresWorkerStore(drizzle(pool) as unknown as Database);
    const read = async () =>
      (await store.listWorkers(null, null, workerId))[0]?.workspaceUnavailable ?? null;
    expect(await read()).toBeNull();

    const first = new Date('2026-11-10T04:40:00.000Z');
    await store.setWorkspaceUnavailable({
      workerId,
      value: {
        cause: 'docker_networks_exhausted',
        detail:
          'Docker engine answered 400: all predefined address pools have been fully subnetted',
        at: first,
        until: new Date(first.getTime() + 60_000),
      },
    });
    expect(await read()).toEqual({
      cause: 'docker_networks_exhausted',
      detail: 'Docker engine answered 400: all predefined address pools have been fully subnetted',
      since: first,
      until: new Date(first.getTime() + 60_000),
    });

    // A repeat keeps the first instant and takes the new cause and cool-down.
    const later = new Date(first.getTime() + 300_000);
    await store.setWorkspaceUnavailable({
      workerId,
      value: {
        cause: 'disk_full',
        detail: null,
        at: later,
        until: new Date(later.getTime() + 60_000),
      },
    });
    expect(await read()).toMatchObject({ cause: 'disk_full', detail: null, since: first });

    // The retry lifts the cool-down and keeps the cause.
    await store.retryWorkspace(workerId);
    expect(await read()).toMatchObject({ cause: 'disk_full', until: null });

    await store.setWorkspaceUnavailable({ workerId, value: null });
    expect(await read()).toBeNull();
    const { rows } = await pool.query(
      `select workspace_unavailable_at, workspace_unavailable_cause, workspace_unavailable_detail,
              workspace_unavailable_until
         from workers where id = $1`,
      [workerId],
    );
    expect(rows[0]).toEqual({
      workspace_unavailable_at: null,
      workspace_unavailable_cause: null,
      workspace_unavailable_detail: null,
      workspace_unavailable_until: null,
    });
  });
});
