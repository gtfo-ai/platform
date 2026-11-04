/**
 * WP-291: the sign-in page's bootstrap hint disappears after the first sign-in, **and stays gone**.
 *
 * A whole instance on a real PostgreSQL 18, because the claim is about what is durable: a session
 * row is deleted at sign-out and when Better Auth finds it expired, so "somebody signed in" read off
 * `sessions` would bring the hint back. The cases therefore delete every session and then ask a
 * **second instance** on the same database — a process whose in-memory cache has never seen a
 * sign-in — so the answer can only have come from `users.first_signed_in_at` (migration 0093).
 * Nothing is written into `human_actions`: the audit lists what people did, and a sign-in is not
 * one of them.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedDatabase,
  type MigratedDatabase,
} from '../../integration/support/migrated.js';
import { createTestClient } from '../../integration/support/postgres.js';
import {
  BOOTSTRAP_EMAIL,
  BOOTSTRAP_PASSWORD,
  Client,
  type Instance,
  startInstance,
} from '../support/instance.js';

let database: MigratedDatabase;
let instance: Instance;

beforeAll(async () => {
  database = await createMigratedDatabase('setup-state');
  instance = await startInstance({ database });
}, 180_000);

afterAll(async () => {
  await instance?.stop();
  await database?.drop();
});

const setupState = async (baseUrl: string) =>
  new Client(baseUrl).json<{ first_sign_in_pending: boolean }>('/api/setup-state');

const sql = async (text: string): Promise<unknown[]> => {
  const client = createTestClient(database.connectionString);
  await client.connect();
  try {
    return (await client.query(text)).rows;
  } finally {
    await client.end();
  }
};

describe('GET /api/setup-state', () => {
  it('is pending on a fresh instance, although the bootstrap administrator exists', async () => {
    // The bootstrap account is created by the server, not signed in to by the operator.
    expect(await sql(`select email from users where email = '${BOOTSTRAP_EMAIL}'`)).toHaveLength(1);
    const read = await setupState(instance.baseUrl);
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ first_sign_in_pending: true });
  });

  it('turns false at the first sign-in, stamps the account once, and writes no audit row', async () => {
    const client = new Client(instance.baseUrl);
    const signedIn = await client.post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    expect(signedIn.status, JSON.stringify(signedIn.body)).toBe(200);
    expect((await setupState(instance.baseUrl)).body).toEqual({ first_sign_in_pending: false });

    const [first] = (await sql(
      `select first_signed_in_at from users where email = '${BOOTSTRAP_EMAIL}'`,
    )) as { first_signed_in_at: Date | null }[];
    expect(first?.first_signed_in_at).toBeInstanceOf(Date);

    // A second sign-in keeps the first instant.
    await new Client(instance.baseUrl).post('/api/auth/sign-in/email', {
      email: BOOTSTRAP_EMAIL,
      password: BOOTSTRAP_PASSWORD,
    });
    const [again] = (await sql(
      `select first_signed_in_at from users where email = '${BOOTSTRAP_EMAIL}'`,
    )) as { first_signed_in_at: Date | null }[];
    expect(again?.first_signed_in_at?.getTime()).toBe(first?.first_signed_in_at?.getTime());
    expect(await sql('select action from human_actions')).toEqual([]);
  });

  it('stays false with every session gone, read by a process that never saw the sign-in', async () => {
    await sql('delete from sessions');
    expect(await sql('select id from sessions')).toEqual([]);

    const second = await startInstance({ database, label: 'setup-state-second' });
    try {
      expect((await setupState(second.baseUrl)).body).toEqual({ first_sign_in_pending: false });
    } finally {
      await second.stop();
    }
  }, 180_000);
});

describe('GET /api/setup-state on an instance in use before migration 0093', () => {
  it('is not pending when people already acted here, although no account carries the stamp', async () => {
    // An instance upgraded across 0093: its accounts signed in before the column existed, so
    // `first_signed_in_at` is null for all of them, and the migration cannot backfill (an UPDATE is
    // not additive). The audit's rows are the evidence the instance is in use (review round 2).
    const upgraded = await createMigratedDatabase('setup-state-upgraded');
    const client = createTestClient(upgraded.connectionString);
    await client.connect();
    try {
      await client.query("insert into human_actions (action) values ('project.create')");
      const stamped = await client.query(
        'select id from users where first_signed_in_at is not null',
      );
      expect(stamped.rows).toEqual([]);
    } finally {
      await client.end();
    }
    const upgradedInstance = await startInstance({
      database: upgraded,
      label: 'setup-state-upgraded',
    });
    try {
      expect((await setupState(upgradedInstance.baseUrl)).body).toEqual({
        first_sign_in_pending: false,
      });
    } finally {
      await upgradedInstance.stop();
      await upgraded.drop();
    }
  }, 180_000);
});
