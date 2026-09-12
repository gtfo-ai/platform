/**
 * Shared Testcontainers harness for the `integration` tier (technical/10).
 *
 * One PostgreSQL 18 container is started for the whole project by `global-setup.ts` and its
 * connection string is handed to the workers. A test file that needs a schema calls
 * `createTestDatabase()`, migrates it and drops it afterwards — so files stay isolated from each
 * other without paying for a container each.
 *
 * The container image is pinned by digest for the same reason every `uses:` in CI is: a moving tag
 * turns an unrelated upstream push into a red build.
 *
 * ## Dropping a database is violent, and the caller has to survive it
 *
 * `drop()` uses `with (force)`, which `pg_terminate_backend`s every backend still attached. Any
 * connection that outlives its owner's shutdown therefore receives `57P01` — and on a `pg.Pool`
 * that arrives as the pool's `'error'` event, which is **thrown** when nothing listens. That is not
 * hypothetical: it failed CI run 34671397340 with every test in the job passing, because
 * `await pool.end()` resolves while the sockets it just closed are still open (the measurement is
 * in `packages/infrastructure/src/db/pool-errors.ts`). So a pool in this tier is built by
 * `createTestPool`, never by hand, and `postgres.integration.test.ts` holds that.
 *
 * A bare `pg.Client` does **not** need the same care: `client.end()` resolves on the connection's
 * `end` event, so a client the caller closed is genuinely closed before the drop can reach it. One
 * that is *leaked* still takes the process down, which is the intended direction of that error.
 */
import { randomUUID } from 'node:crypto';
import type { Logger } from '@platform/application';
import pg from 'pg';
import { inject } from 'vitest';

/**
 * `postgres:18` multi-arch manifest index, resolved from Docker Hub on 2026-09-09.
 * Renovate keeps it current alongside the other pinned digests in this repository.
 */
export const POSTGRES_IMAGE =
  'postgres:18@sha256:4ef4dbc939d61acea57712655ddb4b4ab27419c913f94cca0cd57cb3ea3c2280';

/** Connection string of the shared container's maintenance database. */
export const adminConnectionString = (): string => {
  const url = inject('postgresUrl');
  if (typeof url !== 'string' || url === '') {
    throw new Error(
      'the integration tier needs a PostgreSQL container; check test/integration/support/global-setup.ts',
    );
  }
  return url;
};

/** Builds the connection string of a sibling database inside the same container. */
export const connectionStringFor = (databaseName: string): string => {
  const url = new URL(adminConnectionString());
  url.pathname = `/${databaseName}`;
  return url.toString();
};

export interface TestDatabase {
  readonly name: string;
  readonly connectionString: string;
  /**
   * Drops the database, terminating whatever is still attached. Safe to call twice.
   *
   * The termination is the point: a leaked connection must not be able to block the drop and leak
   * a database into the next file too. What it costs is stated in this module's docblock — every
   * pool that might still be attached needs an `'error'` listener, which is what `createTestPool`
   * is for.
   */
  readonly drop: () => Promise<void>;
}

/**
 * The pool shape this tier uses: a `pg.Pool` that records the teardown terminations it swallowed.
 *
 * The record exists so a test can assert **which branch ran** rather than assert that nothing
 * happened — "no uncaught exception" is also what a pool that never connected produces.
 */
export interface TestPool extends pg.Pool {
  readonly terminations: readonly Error[];
}

/**
 * A pool that survives its database being dropped out from under it, and nothing else.
 *
 * It swallows **exactly** `57P01` — the code PostgreSQL sends to a backend it has been told to
 * terminate, which in this tier means `drop()` ran while this pool still held an idle connection.
 * pg-pool has already discarded that client by the time the event fires, so there is nothing left
 * to fail and nobody to fail it at.
 *
 * Everything else is re-thrown, deliberately and not symmetrically with the production listener
 * (`guardIdleClientErrors`, which logs and keeps serving because a server must not exit when an
 * idle socket dies). A *harness* has the opposite duty: an error it hides is hidden from the only
 * person who would have fixed it, and a green run is the whole product here. The residual is that
 * a forced drop surfacing as something other than `57P01` — a bare `ECONNRESET`, say — would fail
 * the run instead of being absorbed. That is the direction this should fail in, and it has not
 * been observed: the measured code is `57P01`.
 */
export const createTestPool = (
  connectionString: string,
  options: Omit<pg.PoolConfig, 'connectionString'> = {},
): TestPool => {
  const terminations: Error[] = [];
  const pool = new pg.Pool({ connectionString, ...options });
  pool.on('error', (error: Error) => {
    if ((error as { code?: unknown }).code === '57P01') {
      terminations.push(error);
      return;
    }
    throw error;
  });
  return Object.assign(pool, { terminations }) as TestPool;
};

/**
 * The logger a harness pool built by `createDatabasePool` must be given.
 *
 * A few files need a **production** pool rather than `createTestPool` — they are testing
 * `createDatabasePool` itself, or handing pg-boss the pool a runtime would. Those get
 * `guardIdleClientErrors`, whose default logger is `silentLogger`, and a silent guard in a harness
 * is worse than the production one it imitates: the server at least leaves a line behind. This
 * restores `createTestPool`'s asymmetry through the only seam those callers have. `warn` is the
 * branch a connection loss takes, and is dropped; `error` is the branch a code nobody recognised
 * takes, and it **throws**, so the run fails where the surprise happened rather than three files
 * later.
 *
 * It follows that this logger reports nothing: it is a filter, not a log. A test that wants to see
 * the `warn` passes its own recorder, as `postgres.integration.test.ts` does.
 */
export const strictPoolLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: (fields, message) => {
    const error = (fields as { err?: unknown }).err;
    throw error instanceof Error
      ? error
      : new Error(`${message} (${JSON.stringify(fields)})`, { cause: error });
  },
};

const withAdminClient = async <T>(fn: (client: pg.Client) => Promise<T>): Promise<T> => {
  const client = new pg.Client({ connectionString: adminConnectionString() });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};

/**
 * Creates an empty database with a unique name. The caller owns it and must `drop()` it; a leaked
 * one dies with the container at the end of the run.
 */
export const createTestDatabase = async (label = 'test'): Promise<TestDatabase> => {
  const name = `${label}_${randomUUID().replaceAll('-', '')}`.slice(0, 63);
  await withAdminClient(async (client) => {
    await client.query(`create database "${name}"`);
  });

  let dropped = false;
  return {
    name,
    connectionString: connectionStringFor(name),
    drop: async () => {
      if (dropped) {
        return;
      }
      dropped = true;
      await withAdminClient(async (client) => {
        await client.query(`drop database if exists "${name}" with (force)`);
      });
    },
  };
};

/** Opens a client against `connectionString` and closes it when `fn` resolves or throws. */
export const withClient = async <T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> => {
  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
};
