/**
 * WP-42, TD-019: **the app refuses to start when the database is newer than the code.**
 *
 * The rule existed as `findUnknownMigrations` from WP-03 and had no caller — and the half that did
 * run, `/readyz`'s `migrations: down`, reports *after* the process is up and serving. So the
 * property under test here is not "the comparison is right" (the unit tier drives that against a
 * fake catalogue); it is **"a whole `apps/server` instance does not come up"**, which is a
 * statement about `startRuntime` and can only be shown by starting one.
 *
 * Against a real PostgreSQL 18, because the whole point of the rule is what happens to a real
 * upgrade: the row this plants is one an *older* build would find after somebody rolled the image
 * back, and a fake would only prove that a fake can be made to say so.
 *
 * **Both directions, in the same file and against the same database** (standing rule 42): a guard
 * that refused everything would pass the first case, and one that refused nothing the second. The
 * same database is used for both so the only difference between them is the planted row.
 */
import { db } from '@platform/infrastructure';
import { loadServerConfig, requiredPoolConnections, startRuntime } from '@platform/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { withClient } from '../support/postgres.js';

/** A name no migration file can ever have: the four-digit prefixes are allocated in order. */
const FROM_THE_FUTURE = '9999_a_migration_this_build_cannot_know';

let database: MigratedDatabase;

beforeAll(async () => {
  database = await createMigratedDatabase('schema-guard');
}, 120_000);

afterAll(async () => {
  await database?.drop();
});

/**
 * The environment a container gives the process, minus the port: nothing here listens.
 *
 * `ROLE=all` on purpose — the refusal has to hold for the process an operator actually runs, and
 * the pool floor below is the one `requiredPoolConnections` computes for that role.
 */
const environmentFor = (connectionString: string): Record<string, string> => {
  const environment = {
    ROLE: 'all',
    PORT: '0',
    HOST: '127.0.0.1',
    APP_BASE_URL: 'http://127.0.0.1:8080',
    DATABASE_URL: connectionString,
    APP_SECRET_KEY: 'schema-guard-integration-secret-not-a-real-secret-0000',
    LOG_LEVEL: 'silent',
    TZ: 'UTC',
  };
  // The floor itself, read off `requiredPoolConnections` rather than spelled (WP-56): this line said
  // `'21'` and was the one site of PROGRESS backlog 22's arithmetic a `git grep` over `test/e2e`
  // missed when `deadline.sweep` moved the floor to 22 — found by this tier refusing to boot.
  const floor = requiredPoolConnections(
    loadServerConfig({ ...environment, APP_DB_POOL_MAX: '1000' }),
  );
  return { ...environment, APP_DB_POOL_MAX: String(floor) };
};

const plantFutureMigration = async (): Promise<void> => {
  await withClient(database.connectionString, async (client) => {
    await client.query(
      'insert into platform_migrations (name, checksum, duration_ms) values ($1, $2, 0)',
      [FROM_THE_FUTURE, 'not-a-real-checksum'],
    );
  });
};

const removeFutureMigration = async (): Promise<void> => {
  await withClient(database.connectionString, async (client) => {
    await client.query('delete from platform_migrations where name = $1', [FROM_THE_FUTURE]);
  });
};

describe('startRuntime against a database it does not know (TD-019)', () => {
  it('refuses to start and names the migration', async () => {
    await plantFutureMigration();
    try {
      const start = startRuntime({ env: environmentFor(database.connectionString) });
      await expect(start).rejects.toThrow(db.DatabaseSchemaAheadError);
      const error = await start.then(
        () => null,
        (caught: unknown) => caught,
      );
      expect((error as db.DatabaseSchemaAheadError).unknownMigrations).toEqual([FROM_THE_FUTURE]);
      // The operator's next action is in the message, not only the fact of the failure.
      expect((error as Error).message).toContain(FROM_THE_FUTURE);
      expect((error as Error).message).toContain('forward-only');

      // The pool the refused start opened is closed by `startRuntime`'s own `catch`. That is
      // deliberately *not* asserted here by counting backends: `pool.end()` resolves before the
      // sockets it removed are closed (standing rule 85), so the count is a claim about pg-pool's
      // bookkeeping and a race, not about this guard.
    } finally {
      await removeFutureMigration();
    }
  }, 120_000);

  it('starts when the database is at the build’s own migration set', async () => {
    const runtime = await startRuntime({ env: environmentFor(database.connectionString) });
    try {
      // It started — the branch the refusal above did not take (standing rule 10) — and the same
      // comparison, reported by `/readyz`, says the schema is the one this build knows. The
      // overall readiness status is not asserted: it belongs to the queue and dispatch checks,
      // which are a different work package's subject.
      const report = await runtime.app.inject({ method: 'GET', url: '/readyz' });
      expect(report.json<{ checks: Record<string, string> }>().checks.migrations).toBe('ok');
    } finally {
      await runtime.stop();
    }
  }, 120_000);
});
