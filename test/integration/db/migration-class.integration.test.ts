/**
 * Migration **0092** on a database at 0091 (WP-271 criterion (5), TD-032 decision 1): the upgrade
 * adds `platform_migrations.class`, every row applied before it keeps `null` (read as `contract`),
 * 0092's own row is recorded `additive` in the same transaction as the column, and the column holds
 * only the two classes.
 */
import { cpSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, withClient } from '../support/postgres.js';

const MIGRATIONS = fileURLToPath(
  new URL('../../../packages/infrastructure/src/db/migrations/', import.meta.url),
);
const CLASS_MIGRATION = '0092_migration_class.sql';

let database: TestDatabase;
let before: string;
let atUpgrade: readonly string[];

const classes = async (): Promise<Map<string, string | null>> =>
  withClient(database.connectionString, async (client) => {
    const { rows } = await client.query<{ name: string; class: string | null }>(
      'select name, class from platform_migrations order by name',
    );
    return new Map(rows.map((row) => [row.name, row.class]));
  });

describe('migration 0092: platform_migrations.class on an upgraded database (WP-271)', () => {
  beforeAll(async () => {
    database = await createTestDatabase('migration_class_upgrade');
    before = mkdtempSync(join(tmpdir(), 'wp271-migrations-'));
    for (const file of readdirSync(MIGRATIONS)) {
      if (file.endsWith('.sql') && file < CLASS_MIGRATION) {
        cpSync(join(MIGRATIONS, file), join(before, file));
      }
    }
    const first = await db.runMigrations({
      connectionString: database.connectionString,
      migrationsDirectory: before,
    });
    atUpgrade = first.applied;
    await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ present: boolean }>(
        `select exists (select 1 from information_schema.columns
                         where table_name = 'platform_migrations' and column_name = 'class') as present`,
      );
      // At 0091 the column does not exist yet.
      expect(rows[0]?.present).toBe(false);
    });
    await db.runMigrations({ connectionString: database.connectionString });
  }, 180_000);

  afterAll(async () => {
    rmSync(before, { recursive: true, force: true });
    await database?.drop();
  });

  it('was at 0091 before the upgrade', () => {
    expect(atUpgrade.at(-1)).toBe('0091_task_duty_leases');
  });

  it('keeps null on every row applied before 0092 and records 0092 as additive', async () => {
    const recorded = await classes();
    expect([...recorded.entries()].filter(([name]) => atUpgrade.includes(name))).toEqual(
      atUpgrade.map((name) => [name, null]),
    );
    expect(recorded.get('0092_migration_class')).toBe('additive');
    // Every file after 0092 is recorded with the class its header declares.
    for (const migration of db.loadMigrations().filter((m) => m.name > '0092')) {
      expect(recorded.get(migration.name), migration.name).toBe(migration.header?.class);
    }
  });

  it('is a nullable text column holding only the two classes', async () => {
    await withClient(database.connectionString, async (client) => {
      const { rows } = await client.query<{ data_type: string; is_nullable: string }>(
        `select data_type, is_nullable from information_schema.columns
          where table_name = 'platform_migrations' and column_name = 'class'`,
      );
      expect(rows).toEqual([{ data_type: 'text', is_nullable: 'YES' }]);
      await expect(
        client.query(
          "insert into platform_migrations (name, checksum, duration_ms, class) values ('9999_x', 'x', 0, 'destructive')",
        ),
      ).rejects.toThrow(/platform_migrations_class_known/);
      const { rows: validated } = await client.query<{ convalidated: boolean }>(
        "select convalidated from pg_constraint where conname = 'platform_migrations_class_known'",
      );
      expect(validated).toEqual([{ convalidated: true }]);
    });
  });

  it('applies nothing on a second run', async () => {
    const again = await db.runMigrations({ connectionString: database.connectionString });
    expect(again.applied).toEqual([]);
  });
});
