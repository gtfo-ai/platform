import { db as dbAdapters } from '@platform/infrastructure';
import { describe, expect, it } from 'vitest';
import type { Database } from './queries/identity-queries.js';
import { createReadinessCheck, migrationStatus } from './readiness.js';

/** A Drizzle handle that answers only the one query readiness makes. */
const fakeDatabase = (behaviour: { names?: string[]; fail?: boolean; hang?: boolean }): Database =>
  ({
    execute: async () => {
      if (behaviour.hang === true) {
        await new Promise(() => {});
      }
      if (behaviour.fail === true) {
        throw new Error('connection refused');
      }
      return { rows: (behaviour.names ?? []).map((name) => ({ name })) };
    },
  }) as unknown as Database;

/** Every migration this build ships, which is what readiness compares the database against. */
const shipped = (): string[] => dbAdapters.loadMigrations().map((migration) => migration.name);

describe('migrationStatus', () => {
  it('is ok when the database has exactly what this build ships', () => {
    expect(migrationStatus(['0001_a', '0002_b'], ['0001_a', '0002_b'])).toEqual({
      status: 'ok',
      pending: [],
      unknown: [],
    });
  });

  it('is down when a migration has not been applied — migrate has not run', () => {
    expect(migrationStatus(['0001_a', '0002_b'], ['0001_a'])).toMatchObject({
      status: 'down',
      pending: ['0002_b'],
      unknown: [],
    });
  });

  it('is down when the database carries a migration this build does not know', () => {
    // TD-019: serving traffic against a schema the code has never seen is how a rollback corrupts
    // data. The two cases are reported separately because they need different actions.
    expect(migrationStatus(['0001_a'], ['0001_a', '0002_from_the_future'])).toMatchObject({
      status: 'down',
      pending: [],
      unknown: ['0002_from_the_future'],
    });
  });
});

describe('createReadinessCheck', () => {
  it('reports ok against a database at this build’s schema', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ names: shipped() }),
      jobsStarted: () => true,
    });
    await expect(check()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok', migrations: 'ok', queue: 'ok' },
    });
  });

  it('reports the database down when the query fails, and does not guess at migrations', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ fail: true }),
      jobsStarted: null,
    });
    await expect(check()).resolves.toEqual({
      status: 'down',
      checks: { database: 'down', migrations: 'down' },
    });
  });

  it('reports the queue down when the job runtime has stopped', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ names: shipped() }),
      jobsStarted: () => false,
    });
    const report = await check();
    expect(report.checks.queue).toBe('down');
    expect(report.status).toBe('down');
  });

  it('omits the queue check in a process that runs no job runtime', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ names: shipped() }),
      jobsStarted: null,
    });
    expect(Object.keys((await check()).checks)).toEqual(['database', 'migrations']);
  });

  it('answers within its deadline rather than hanging the probe', async () => {
    // A readiness probe that never answers is read as "still deciding", so the instance stays in
    // the load balancer while it cannot serve.
    const check = createReadinessCheck({
      database: fakeDatabase({ hang: true }),
      jobsStarted: null,
      timeoutMs: 20,
    });
    await expect(check()).resolves.toMatchObject({ status: 'down' });
  });

  it('reports migrations down when the database is behind this build', async () => {
    const behind = shipped().slice(0, -1);
    const check = createReadinessCheck({
      database: fakeDatabase({ names: behind }),
      jobsStarted: null,
    });
    const report = await check();
    expect(report.checks.database).toBe('ok');
    expect(report.checks.migrations).toBe('down');
  });
});
