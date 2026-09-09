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
      // The suite is throwaway: durability costs wall-clock and buys nothing.
      .withCommand(['postgres', '-c', 'fsync=off', '-c', 'full_page_writes=off'])
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
