/**
 * Migration 0011 against Better Auth's own idea of what it needs (TD-022).
 *
 * The auth tables are hand-written SQL like every other migration (TD-011/TD-019), and their shape
 * is dictated by a third-party library plus a plugin. A comment claiming "these are the columns
 * Better Auth wants" would be worth nothing the day Better Auth adds one — the login would break,
 * not the build. So the library is asked, through `pendingAuthSchema`, which runs the check against
 * the same options object the server actually starts with.
 */
import { loadServerConfig, pendingAuthSchema } from '@platform/server';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

let database: MigratedDatabase;
let pool: pg.Pool;

beforeAll(async () => {
  database = await createMigratedDatabase('betterauth');
  pool = new pg.Pool({ connectionString: database.connectionString });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.drop();
});

const config = () =>
  loadServerConfig({
    DATABASE_URL: database.connectionString,
    APP_SECRET_KEY: 'integration-test-secret-not-a-real-secret',
  });

describe('Better Auth schema parity', () => {
  it('finds nothing left to create or add after migration 0011', async () => {
    const pending = await pendingAuthSchema({ pool, config: config() });

    expect(
      pending.tablesToCreate,
      'Better Auth wants tables that migration 0011 did not create',
    ).toEqual([]);
    expect(
      pending.columnsToAdd,
      'Better Auth wants columns that migration 0011 did not create',
    ).toEqual([]);
  });

  it('stores those tables under the platform’s snake_case column names', async () => {
    // The field maps are the risky half: a wrong one produces a column Better Auth is happy with
    // and the platform's own queries cannot see. So the shape is checked from the other side.
    const columns = async (table: string): Promise<string[]> => {
      const { rows } = await pool.query<{ column_name: string }>(
        'select column_name from information_schema.columns where table_name = $1 order by column_name',
        [table],
      );
      return rows.map((row) => row.column_name);
    };

    expect(await columns('users')).toEqual([
      'ban_expires',
      'ban_reason',
      'banned',
      'created_at',
      'email',
      'email_verified',
      'id',
      'image',
      'name',
      'role',
      'status',
      'updated_at',
    ]);
    expect(await columns('sessions')).toEqual([
      'created_at',
      'expires_at',
      'id',
      'impersonated_by',
      'ip_address',
      'token',
      'updated_at',
      'user_agent',
      'user_id',
    ]);
    expect(await columns('verifications')).toEqual([
      'created_at',
      'expires_at',
      'id',
      'identifier',
      'updated_at',
      'value',
    ]);

    // The placeholder credential column of migration 0003 is gone: credentials live in
    // `accounts.password`, and a second, unread hash would be a place for a stale one to sit and
    // look authoritative.
    expect(await columns('users')).not.toContain('password_hash');
    expect(await columns('accounts')).toContain('password');
  });

  it('keeps the role column an enum, so the database enforces TD-022’s four roles', async () => {
    const { rows } = await pool.query<{ data_type: string; udt_name: string }>(
      "select data_type, udt_name from information_schema.columns where table_name = 'users' and column_name = 'role'",
    );
    // Better Auth's admin plugin writes the role as text and warns about the type; the warning is
    // this guarantee working. A plugin default outside the vocabulary fails at the database.
    expect(rows[0]).toMatchObject({ data_type: 'USER-DEFINED', udt_name: 'user_role' });

    await expect(
      pool.query("insert into users (email, name, role) values ('x@example.test', 'X', 'wizard')"),
    ).rejects.toThrow(/invalid input value for enum user_role/);
  });

  it('registers all four tables in the storage policy registry', async () => {
    // WP-03's convention: every table registers itself, so `platform_table_policy` is readable as
    // the answer to "what may the application do to this table?". A missing row means the default
    // is doing the work and the registry has silently stopped being that answer.
    const { rows } = await pool.query<{ table_name: string; app_access: string }>(
      `select table_name, app_access
         from platform_table_policy
        where table_name in ('users', 'sessions', 'accounts', 'verifications')
        order by table_name`,
    );
    expect(rows).toEqual([
      { table_name: 'accounts', app_access: 'read_write' },
      { table_name: 'sessions', app_access: 'read_write' },
      { table_name: 'users', app_access: 'read_write' },
      { table_name: 'verifications', app_access: 'read_write' },
    ]);
  });

  it('grants the least-privilege application role full DML on the auth tables', async () => {
    // WP-03's grants are re-applied after every migration and default to read_write; authentication
    // cannot work without INSERT/UPDATE/DELETE on all four.
    const { rows } = await pool.query<{ table_name: string; privilege_type: string }>(
      `select table_name, privilege_type
         from information_schema.role_table_grants
        where grantee = 'platform_app'
          and table_name in ('users', 'sessions', 'accounts', 'verifications')`,
    );
    for (const table of ['accounts', 'sessions', 'users', 'verifications']) {
      const granted = rows
        .filter((row) => row.table_name === table)
        .map((row) => row.privilege_type);
      expect(granted, table).toEqual(
        expect.arrayContaining(['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
      );
    }
  });
});
