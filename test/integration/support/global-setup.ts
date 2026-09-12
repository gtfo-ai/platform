/**
 * Starts the one PostgreSQL container the `integration` project shares (technical/10).
 *
 * Vitest runs this once per project, before any worker; `provide()` hands the connection string to
 * the tests. Setting `TEST_DATABASE_URL` in the environment skips the container entirely, which is
 * what a developer with a local PostgreSQL 18 — or a CI job with a service container — wants.
 */
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import { POSTGRES_IMAGE } from './postgres.js';

declare module 'vitest' {
  export interface ProvidedContext {
    postgresUrl: string;
  }
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const external = process.env.TEST_DATABASE_URL?.trim();
  if (external !== undefined && external !== '') {
    project.provide('postgresUrl', external);
    return async () => {};
  }

  let container: StartedPostgreSqlContainer;
  try {
    container = await new PostgreSqlContainer(POSTGRES_IMAGE)
      .withDatabase('platform_test')
      .withUsername('platform_test')
      .withPassword('platform_test')
      .withCommand([
        'postgres',
        // The suite is throwaway: durability costs wall-clock and buys nothing.
        '-c',
        'fsync=off',
        '-c',
        'full_page_writes=off',
        /**
         * **300, because the e2e tier's demand is the product's pool floor times the number of
         * instances vitest runs at once** — and the floor grows with the product.
         *
         * The default is 100. At WP-18b the floor for `ROLE=all` at dispatch concurrency 1 became
         * **16** (`requiredPoolConnections`: the Librarian's three job workers joined WP-18a's
         * index worker), and a single e2e file may start two whole instances while a dozen files
         * run in parallel. The symptom when it is short is not a slow test: it is
         * `error: sorry, too many clients already` inside an unrelated file — measured on this tree,
         * in `sse.e2e.test.ts`, the first time the tier ran with the librarian instances in it.
         *
         * This is the **harness following the product**, not a workaround: a connection ceiling
         * that was chosen when a process needed 11 connections is not a statement about a process
         * that needs 16. A test container's backends are cheap; a red tier that names somebody
         * else's file is not.
         */
        '-c',
        'max_connections=300',
      ])
      .start();
  } catch (error) {
    throw new Error(
      `could not start ${POSTGRES_IMAGE}: the integration tier needs a running Docker daemon, or TEST_DATABASE_URL pointing at a PostgreSQL 18 server. ${String(error)}`,
      { cause: error },
    );
  }

  project.provide('postgresUrl', container.getConnectionUri());

  return async () => {
    await container.stop();
  };
}
