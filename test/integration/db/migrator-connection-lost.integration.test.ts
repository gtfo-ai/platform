/**
 * The migrator losing its connection mid-run — WP-73b, PROGRESS backlog 247 (backlog 30's labelled
 * hypothesis, now exercised on the migrator itself).
 *
 * `runMigrations` held a `pg.Client` with no `'error'` listener, and WP-68 measured that such a
 * client ends the process on an uncaught `57P01` (`test/integration/support/postgres.integration.test.ts`).
 * Here the migrator's own backend is terminated while a migration is running — a one-file
 * migrations directory whose only statement sleeps, so there is a window to hit — and the
 * assertions are the two halves of the entry's "done": the run **rejects with the typed error**,
 * and **nothing** reaches the process as an uncaught exception, including the
 * `Connection terminated unexpectedly` report that follows the termination.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db } from '@platform/infrastructure';
import { afterAll, describe, expect, it } from 'vitest';
import { createTestDatabase, type TestDatabase, withClient } from '../support/postgres.js';

const scratch: string[] = [];
const databases: TestDatabase[] = [];

afterAll(async () => {
  for (const directory of scratch) {
    rmSync(directory, { recursive: true, force: true });
  }
  for (const database of databases) {
    await database.drop();
  }
});

/** A bounded wait that names what never happened. */
const until = async (what: string, ready: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + 20_000;
  while (!(await ready())) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never happened`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
};

describe('a migrate whose connection is terminated mid-run (backlog 247)', () => {
  it('rejects with MigrationConnectionLostError and leaks nothing to the process', async () => {
    const database = await createTestDatabase('migrate-terminated');
    databases.push(database);
    const directory = mkdtempSync(join(tmpdir(), 'migrate-terminated-'));
    scratch.push(directory);
    // The marker is in the statement so `pg_stat_activity` can find exactly this backend.
    writeFileSync(join(directory, '0001_sleep.sql'), 'select pg_sleep(30) /* backlog-247 */;\n');

    const uncaught: unknown[] = [];
    const onUncaught = (error: unknown): void => {
      uncaught.push(error);
    };
    process.on('uncaughtException', onUncaught);
    try {
      const run = db
        .runMigrations({
          connectionString: database.connectionString,
          migrationsDirectory: directory,
          appRole: '',
        })
        .then(
          () => null,
          (error: unknown) => error,
        );

      let terminated = false;
      await until('the migration to start sleeping and be terminated', async () => {
        terminated = await withClient(database.connectionString, async (admin) => {
          const { rows } = await admin.query<{ terminated: boolean }>(
            `select pg_terminate_backend(pid) as terminated
               from pg_stat_activity
              where datname = current_database()
                and pid <> pg_backend_pid()
                and query like '%backlog-247%'`,
          );
          return rows.some((row) => row.terminated);
        });
        return terminated;
      });

      const failure = await run;
      // Hold the watch open for the connection-closed report that follows the termination.
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(failure).toBeInstanceOf(db.MigrationConnectionLostError);
      // Measured at WP-73b: the in-flight query is rejected with pg's own "Connection terminated
      // unexpectedly", which carries no SQLSTATE — so the typed error is decided by the rejection's
      // shape, and `code` is null here rather than the server's `57P01`.
      expect((failure as Error).message).toContain('Connection terminated unexpectedly');
      expect(uncaught).toEqual([]);
      // Transactional: the interrupted file is not recorded, so the next migrate applies it again.
      const recorded = await withClient(database.connectionString, async (admin) => {
        const { rows } = await admin.query<{ name: string }>(
          'select name from platform_migrations',
        );
        return rows.map((row) => row.name);
      });
      expect(recorded).toEqual([]);
    } finally {
      process.off('uncaughtException', onUncaught);
    }
  }, 60_000);
});
