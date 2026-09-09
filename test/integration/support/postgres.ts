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
 */
import { randomUUID } from 'node:crypto';
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
  /** Drops the database. Safe to call twice. */
  readonly drop: () => Promise<void>;
}

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
