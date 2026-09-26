/**
 * The two `user_identities` queries against a real PostgreSQL 18 — and the driver behaviour that
 * made the endpoint over them answer 500 on every request (WP-31's defect, found by WP-29).
 *
 * `test/e2e/server/identity-api.e2e.test.ts` asserts the **symptom** where a user meets it: the
 * route, over HTTP, on a whole instance. This file pins the **cause**, one layer down, because it
 * is a property of a library version rather than of this code: drizzle-orm 0.45.2's node-postgres
 * session gives every raw query a `getTypeParser` that returns `TIMESTAMPTZ`, `TIMESTAMP`, `DATE`
 * and `INTERVAL` unparsed (`node_modules/drizzle-orm/node-postgres/session.js`), because drizzle
 * maps timestamps itself — per column, on the **builder** path only. A `sql` template through
 * `database.execute` is therefore not "the same query, hand-written": it answers a different type,
 * and nothing in the type system says so.
 *
 * The first case below is that measurement, kept rather than described: a raw `execute` of the same
 * column, asserted to be a string that is *not* ISO-8601. It is what a dependency bump would
 * falsify, and the day it does the second case still holds — which is the honest division, because
 * the fix was to stop being on that path rather than to parse the string.
 */
import { db } from '@platform/infrastructure';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listIdentityMappings,
  upsertIdentityMapping,
} from '../../../apps/server/src/queries/identity-queries.js';
import { toWireIdentityMapping } from '../../../apps/server/src/routes/org.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

let database: MigratedDatabase;
let pool: pg.Pool;
let drizzled: ReturnType<typeof drizzle<typeof db.schema>>;
let ada: string;
let grace: string;

const user = async (email: string, name: string): Promise<string> => {
  const result = await pool.query<{ id: string }>(
    'insert into users (email, name) values ($1, $2) returning id',
    [email, name],
  );
  return result.rows[0]?.id as string;
};

beforeAll(async () => {
  database = await createMigratedDatabase('identity-queries');
  pool = createTestPool(database.connectionString, { options: '-c role=platform_app', max: 4 });
  drizzled = drizzle(pool, { schema: db.schema });
  ada = await user('ada@example.test', 'Ada Lovelace');
  grace = await user('grace@example.test', 'Grace Hopper');
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

describe('user_identities through drizzle', () => {
  it('answers a timestamptz as an unparsed string on the raw `execute` path', async () => {
    await upsertIdentityMapping(drizzled, {
      provider: 'raw-check',
      externalId: 'acct-raw',
      userId: ada,
      displayName: null,
    });

    const raw = await drizzled.execute<{ created_at: unknown }>(
      sql`select created_at from user_identities where provider = 'raw-check'`,
    );
    const value = raw.rows[0]?.created_at;
    // Not a `Date` — which is the whole finding, because the route's mapping used to branch on
    // exactly that and publish this value untouched when the branch was false.
    expect(value).toBeTypeOf('string');
    expect(value).not.toBeInstanceOf(Date);
    // PostgreSQL's own rendering — `2026-09-14 11:47:18.53969+00`, measured here: a space instead
    // of the `T` and an offset with no minutes. `isoDateTimeSchema` refuses both. The pattern
    // rather than the literal, because the instant is `now()`.
    expect(value as string).toMatch(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?[+-]\d\d$/);

    // …and the same column through the builder is a `Date` for the same row, which is the
    // difference the fix rests on.
    const [mapping] = await listIdentityMappings(drizzled);
    expect(mapping?.created_at).toBeInstanceOf(Date);
    expect(mapping?.created_at.toISOString()).toBe(new Date(value as string).toISOString());
  });

  it('upserts on (provider, external_id) and publishes the instant the row holds', async () => {
    const first = await upsertIdentityMapping(drizzled, {
      provider: 'jira-cloud',
      externalId: 'acct-ada',
      userId: ada,
      displayName: 'Ada Lovelace',
    });
    expect(first).toMatchObject({
      provider: 'jira-cloud',
      external_id: 'acct-ada',
      user_id: ada,
      display_name: 'Ada Lovelace',
    });
    expect(first.created_at).toBeInstanceOf(Date);
    // What the endpoint publishes, from the record the query returns: a real ISO instant, equal to
    // the row the database holds. Asserted here as well as at the route because this is the pair
    // that has to agree — the route test can only ever assert it about its own fake.
    const stored = await pool.query<{ created_at: Date }>(
      "select created_at from user_identities where provider = 'jira-cloud' and external_id = 'acct-ada'",
    );
    expect(toWireIdentityMapping(first).created_at).toBe(stored.rows[0]?.created_at.toISOString());

    // The same account, another person: one row, moved. An upsert on `(provider, user_id)` — the
    // mistake the query's docblock refuses — would leave two rows here.
    const second = await upsertIdentityMapping(drizzled, {
      provider: 'jira-cloud',
      externalId: 'acct-ada',
      userId: grace,
      displayName: null,
    });
    expect(second.user_id).toBe(grace);
    expect(second.display_name).toBeNull();
    expect(second.created_at.toISOString()).toBe(first.created_at.toISOString());

    const rows = await pool.query<{ count: string }>(
      "select count(*) as count from user_identities where external_id = 'acct-ada'",
    );
    expect(rows.rows[0]?.count).toBe('1');

    // One person, two accounts of the same provider — the case the conflict target exists to keep
    // possible.
    await upsertIdentityMapping(drizzled, {
      provider: 'jira-cloud',
      externalId: 'acct-ada-second',
      userId: grace,
      displayName: null,
    });
    const listed = await listIdentityMappings(drizzled);
    expect(listed.filter((row) => row.user_id === grace).map((row) => row.external_id)).toEqual([
      'acct-ada',
      'acct-ada-second',
    ]);
    // Ordered by provider then external id, and `email` is not one of the columns published.
    expect(listed.map((row) => `${row.provider}:${row.external_id}`)).toEqual([
      'jira-cloud:acct-ada',
      'jira-cloud:acct-ada-second',
      'raw-check:acct-raw',
    ]);
    expect(Object.keys(listed[0] ?? {})).toEqual([
      'provider',
      'external_id',
      'kind',
      'user_id',
      'display_name',
      'created_at',
    ]);
  });

  it('declares a machine as the same row, with no user, and the table refuses the two apart', async () => {
    // WP-61, migration 0045: `kind` follows from `user_id` in the writer, and the check constraint
    // is what holds a writer that forgot — measured here rather than trusted.
    const machine = await upsertIdentityMapping(drizzled, {
      provider: 'gitlab',
      externalId: 'renovate',
      userId: null,
      displayName: 'Renovate',
    });
    expect(machine).toMatchObject({ kind: 'machine', user_id: null });
    await expect(
      pool.query(
        "insert into user_identities (provider, external_id, user_id, kind) values ('gitlab', 'half', null, 'person')",
      ),
    ).rejects.toThrow(/user_identities_kind_has_user/);
    await expect(
      pool.query(
        "insert into user_identities (provider, external_id, user_id, kind) values ('gitlab', 'odd', null, 'robot')",
      ),
    ).rejects.toThrow(/user_identities_kind_known/);
  });
});
