/**
 * **A person's task limit, against PostgreSQL 18** (S-28.6, the M28 ruling B; migration 0114):
 * the column's range is the database's too, the writer refuses a number above the organisation's
 * maximum and writes nothing, a change writes one `user.task_limit` row and a repeat none, a raise
 * names the projects holding the person's queued tasks, and the read counts exactly the states the
 * scheduler counts.
 */
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Database } from '../../../apps/server/src/queries/identity-queries.js';
import {
  readPersonTaskLoad,
  setPersonTaskLimit,
} from '../../../apps/server/src/queries/task-limits.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: Database;
let orgId: string;
let counter = 0;

const LIMITS = { default: 3, maximum: 5, organisationStates: true };

beforeAll(async () => {
  database = await createMigratedDatabase('task-limits');
  pool = createTestPool(database.connectionString, { max: 2 });
  drizzled = drizzle(pool) as unknown as Database;
  orgId = (
    await pool.query<{ id: string }>(
      "insert into organizations (name) values ('limits') returning id",
    )
  ).rows[0]?.id as string;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const person = async (): Promise<string> => {
  counter += 1;
  return (
    await pool.query<{ id: string }>(
      "insert into users (email, name, role) values ($1, 'Jan', 'member') returning id",
      [`limit-${counter}@example.test`],
    )
  ).rows[0]?.id as string;
};

const project = async (): Promise<string> => {
  counter += 1;
  return (
    await pool.query<{ id: string }>(
      `insert into projects (org_id, key, name, repo_url)
       values ($1, $2, 'Limits', 'https://git.example.test/acme/limits.git') returning id`,
      [orgId, `lim${counter}`],
    )
  ).rows[0]?.id as string;
};

const task = async (projectId: string, state: string, owner: string) => {
  counter += 1;
  const key = `LIM-${counter}`;
  await pool.query(
    `insert into tasks (project_id, ticket_provider, ticket_key, ticket_url, template, state,
                        current_stage, stage_attempts, owner_user_id)
     values ($1, 'jira-cloud', $2, 'https://jira.example.test/browse/' || $2, 'feature', $3,
             'implementation', '{"implementation": 1}'::jsonb, $4)`,
    [projectId, key, state, owner],
  );
};

const audits = async (userId: string) =>
  (
    await pool.query<{ params: { max_tasks_in_flight: number | null } }>(
      "select params from human_actions where action = 'user.task_limit' and params->>'user_id' = $1",
      [userId],
    )
  ).rows;

describe('a person’s task limit over PostgreSQL (S-28.6)', () => {
  it('holds the range in the database itself', async () => {
    const user = await person();
    for (const value of [0, 201]) {
      await expect(
        pool.query('update users set max_tasks_in_flight = $2 where id = $1', [user, value]),
      ).rejects.toThrow(/users_max_tasks_in_flight_range/);
    }
  });

  it('refuses a number above the maximum, writes a change once, and a repeat not at all', async () => {
    const user = await person();
    const set = (personal: number | null) =>
      setPersonTaskLimit(drizzled, {
        userId: user,
        actorUserId: user,
        personal,
        limits: LIMITS,
        via: 'self',
      });
    expect(await set(6)).toEqual({ status: 'above_maximum', maximum: 5 });
    expect(await audits(user)).toEqual([]);
    expect(await set(4)).toMatchObject({ status: 'set', personal: 4, limit: 4, performed: true });
    expect(await set(4)).toMatchObject({ status: 'set', performed: false });
    expect((await audits(user)).map((row) => row.params.max_tasks_in_flight)).toEqual([4]);
    expect(await set(null)).toMatchObject({ performed: true, limit: 3, raised: null });
  });

  it('names the projects holding the person’s queued tasks when their limit rises', async () => {
    const user = await person();
    const [a, b, c] = [await project(), await project(), await project()];
    await task(a, 'queued', user);
    await task(b, 'queued', user);
    await task(c, 'active', user);
    const result = await setPersonTaskLimit(drizzled, {
      userId: user,
      actorUserId: user,
      personal: 5,
      limits: LIMITS,
      via: 'self',
    });
    expect(result).toMatchObject({ raised: { from: 3, to: 5 } });
    expect(result.status === 'set' ? [...result.queuedProjects].sort() : []).toEqual([a, b].sort());
  });

  it('counts the tasks the scheduler counts, and not paused, needs_human or queued ones', async () => {
    const user = await person();
    const p = await project();
    for (const state of [
      'active',
      'returned',
      'waiting_answers',
      'waiting_approval',
      'paused',
      'needs_human',
      'queued',
      'ready_for_merge',
      'done',
    ]) {
      await task(p, state, user);
    }
    const load = await readPersonTaskLoad(drizzled, user, 20);
    expect(load).toMatchObject({ personal: null, inFlight: 4, queued: 1 });
    expect(load?.holders.map((holder) => holder.state).sort()).toEqual(
      ['active', 'returned', 'waiting_answers', 'waiting_approval'].sort(),
    );
  });
});
