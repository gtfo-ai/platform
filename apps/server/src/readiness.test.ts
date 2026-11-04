import { db as dbAdapters } from '@platform/infrastructure';
import { describe, expect, it } from 'vitest';
import type { Database } from './queries/identity-queries.js';
import { createReadinessCheck, migrationStatus } from './readiness.js';

/**
 * A Drizzle handle that answers only the one query readiness makes. `names` are rows recorded with
 * no class (every row before 0092); `rows` carry one.
 */
const fakeDatabase = (behaviour: {
  names?: string[];
  rows?: { name: string; class: string | null }[];
  fail?: boolean;
  hang?: boolean;
}): Database =>
  ({
    execute: async () => {
      if (behaviour.hang === true) {
        await new Promise(() => {});
      }
      if (behaviour.fail === true) {
        throw new Error('connection refused');
      }
      return {
        rows: [
          ...(behaviour.names ?? []).map((name) => ({ name, class: null })),
          ...(behaviour.rows ?? []),
        ],
      };
    },
  }) as unknown as Database;

/** Rows recorded with no class, as `appliedMigrations` returns them for a pre-0092 database. */
const unclassified = (names: readonly string[]) => names.map((name) => ({ name, class: null }));

/** Every migration this build ships, which is what readiness compares the database against. */
const shipped = (): string[] => dbAdapters.loadMigrations().map((migration) => migration.name);

describe('migrationStatus', () => {
  it('is ok when the database has exactly what this build ships', () => {
    expect(migrationStatus(['0001_a', '0002_b'], unclassified(['0001_a', '0002_b']))).toEqual({
      status: 'ok',
      pending: [],
      unknown: [],
      schema: 'known',
    });
  });

  it('is down when a migration has not been applied — migrate has not run', () => {
    expect(migrationStatus(['0001_a', '0002_b'], unclassified(['0001_a']))).toMatchObject({
      status: 'down',
      pending: ['0002_b'],
      unknown: [],
    });
  });

  it('is down when the database carries a migration this build does not know', () => {
    // TD-019: serving traffic against a schema the code has never seen is how a rollback corrupts
    // data. The two cases are reported separately because they need different actions.
    expect(
      migrationStatus(['0001_a'], unclassified(['0001_a', '0002_from_the_future'])),
    ).toMatchObject({
      status: 'down',
      pending: [],
      unknown: ['0002_from_the_future'],
      schema: 'ahead',
    });
  });

  /** TD-032 decision 2 (WP-272): the guard's own decision, so the two readers cannot disagree. */
  it('is ok and ahead_additive when every unknown row is additive, down when one is contract', () => {
    const additive = { name: '0099_future', class: 'additive' };
    expect(migrationStatus(['0001_a'], [...unclassified(['0001_a']), additive])).toEqual({
      status: 'ok',
      pending: [],
      unknown: ['0099_future'],
      schema: 'ahead_additive',
    });
    expect(
      migrationStatus(
        ['0001_a'],
        [...unclassified(['0001_a']), additive, { name: '0100_drop', class: 'contract' }],
      ),
    ).toMatchObject({ status: 'down', schema: 'ahead' });
    // Ahead by additive rows and behind by a pending one is still `down`: migrate has not run.
    expect(
      migrationStatus(['0001_a', '0002_b'], [...unclassified(['0001_a']), additive]),
    ).toMatchObject({ status: 'down', pending: ['0002_b'], schema: 'ahead_additive' });
  });
});

describe('createReadinessCheck', () => {
  it('reports ok against a database at this build’s schema', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ names: shipped() }),
      jobsStarted: () => true,
      dispatchReady: () => true,
    });
    await expect(check()).resolves.toEqual({
      status: 'ok',
      checks: { database: 'ok', migrations: 'ok', queue: 'ok', dispatch: 'ok' },
    });
  });

  it('reports the database down when the query fails, and does not guess at migrations', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ fail: true }),
      jobsStarted: null,
      dispatchReady: null,
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
      dispatchReady: () => true,
    });
    const report = await check();
    expect(report.checks.queue).toBe('down');
    expect(report.status).toBe('down');
  });

  it('omits the queue check in a process that runs no job runtime', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ names: shipped() }),
      jobsStarted: null,
      dispatchReady: null,
    });
    expect(Object.keys((await check()).checks)).toEqual(['database', 'migrations']);
  });

  /**
   * The check WP-15a's review added, and the state it exists for.
   *
   * `apps/server` cannot compose the pipeline on its own in this build, so `main.ts` starts a
   * worker whose bus has **no handlers**: it can reach the database, its schema matches and
   * pg-boss is up, so every other check here is `ok` and an orchestrator was told a process was
   * ready to serve a product that would never advance a ticket. Deleting the `checks.dispatch`
   * block in `readiness.ts` kills this test by name.
   */
  it('is down when the dispatcher has no handlers, however healthy everything else is', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ names: shipped() }),
      jobsStarted: () => true,
      dispatchReady: () => false,
    });
    const report = await check();
    expect(report.checks).toEqual({
      database: 'ok',
      migrations: 'ok',
      queue: 'ok',
      dispatch: 'down',
    });
    expect(report.status).toBe('down');
  });

  it('omits the dispatch check in a process that runs no dispatcher', async () => {
    const check = createReadinessCheck({
      database: fakeDatabase({ names: shipped() }),
      jobsStarted: () => true,
      dispatchReady: null,
    });
    expect(Object.keys((await check()).checks)).toEqual(['database', 'migrations', 'queue']);
  });

  it('answers within its deadline rather than hanging the probe', async () => {
    // A readiness probe that never answers is read as "still deciding", so the instance stays in
    // the load balancer while it cannot serve.
    const check = createReadinessCheck({
      database: fakeDatabase({ hang: true }),
      jobsStarted: null,
      dispatchReady: null,
      timeoutMs: 20,
    });
    await expect(check()).resolves.toMatchObject({ status: 'down' });
  });

  /**
   * WP-277 (TD-031 decision 13): `claimants` says who claims agent runs — `server` composed here,
   * `workers: <n>`, or `none` — and `none` is **not** degraded by itself: only an offer that waited
   * past the bound with no claimant degrades it, naming the offer. Degraded, never down.
   */
  describe('claimants (WP-277)', () => {
    const OLD_OFFER = {
      runId: '00000000-0000-4000-8000-000000000277',
      offeredAt: '2026-11-04T09:00:00.000Z',
      waitedSeconds: 400,
    };
    const withClaimants = (input: {
      readonly composedHere: 'server' | null;
      readonly elsewhere?: boolean;
      readonly workers?: number;
      readonly oldest?: typeof OLD_OFFER | null;
      readonly fails?: boolean;
    }) =>
      createReadinessCheck({
        database: fakeDatabase({ names: shipped() }),
        jobsStarted: () => true,
        dispatchReady: null,
        claimants: {
          composedHere: input.composedHere,
          serverClaimantRunning: async () => input.elsewhere ?? false,
          workersConnected: async () => {
            if (input.fails === true) throw new Error('relation "run_offers" does not exist');
            return input.workers ?? 0;
          },
          oldestUnclaimedOffer: async () => input.oldest ?? null,
        },
      });

    it('reads server where this process composes the claimant, ok even with an old offer', async () => {
      await expect(withClaimants({ composedHere: 'server', oldest: OLD_OFFER })()).resolves.toEqual(
        {
          status: 'ok',
          checks: { database: 'ok', migrations: 'ok', queue: 'ok', claimants: 'ok' },
          claimants: 'server',
        },
      );
    });

    /**
     * Backlog 722 (WP-281): the `app` process beside a busy `runner` composes no claimant, and the
     * instance still has one — its `server_claimants` row is fresh — so it reads `server` and an old
     * offer does not degrade it; without the row the same process reads `none` and degrades.
     */
    it('reads server, not degraded, where another process’s server claimant is alive (backlog 722)', async () => {
      await expect(
        withClaimants({ composedHere: null, elsewhere: true, oldest: OLD_OFFER })(),
      ).resolves.toEqual({
        status: 'ok',
        checks: { database: 'ok', migrations: 'ok', queue: 'ok', claimants: 'ok' },
        claimants: 'server',
      });
      const alone = await withClaimants({
        composedHere: null,
        elsewhere: false,
        oldest: OLD_OFFER,
      })();
      expect(alone.claimants).toBe('none');
      expect(alone.checks.claimants).toBe('degraded');
    });

    it('reads workers: <n> when workers are connected', async () => {
      const report = await withClaimants({ composedHere: null, workers: 2 })();
      expect(report.claimants).toBe('workers: 2');
      expect(report.checks.claimants).toBe('ok');
    });

    it('is none and NOT degraded on a workers_only core with nothing waiting past the bound', async () => {
      await expect(withClaimants({ composedHere: null })()).resolves.toEqual({
        status: 'ok',
        checks: { database: 'ok', migrations: 'ok', queue: 'ok', claimants: 'ok' },
        claimants: 'none',
      });
    });

    it('is degraded — never down — naming the oldest offer once one waited past the bound', async () => {
      await expect(withClaimants({ composedHere: null, oldest: OLD_OFFER })()).resolves.toEqual({
        status: 'degraded',
        checks: { database: 'ok', migrations: 'ok', queue: 'ok', claimants: 'degraded' },
        details: { claimants: 'unclaimed' },
        claimants: 'none',
        oldest_unclaimed_offer: {
          run_id: OLD_OFFER.runId,
          offered_at: OLD_OFFER.offeredAt,
          waited_seconds: 400,
        },
      });
    });

    it('is degraded and unknown, never ok, when the read fails', async () => {
      const report = await withClaimants({ composedHere: null, fails: true })();
      expect(report.checks.claimants).toBe('degraded');
      expect(report.details).toEqual({ claimants: 'unknown' });
    });

    it('is omitted where no job client is held', async () => {
      const check = createReadinessCheck({
        database: fakeDatabase({ names: shipped() }),
        jobsStarted: null,
        dispatchReady: null,
        claimants: null,
      });
      expect(Object.keys((await check()).checks)).toEqual(['database', 'migrations']);
    });
  });

  /**
   * `/readyz` on an all-additive future (TD-032 decision 2, WP-272): `schema: degraded` with
   * `details.schema: ahead_additive` — a degraded report, which `routes/ops.ts` answers with 200 —
   * and `down` again as soon as one unknown row is not additive.
   */
  it('reports schema ahead_additive, degraded and not down, when every unknown row is additive', async () => {
    const future = { name: '9999_future', class: 'additive' };
    const check = createReadinessCheck({
      database: fakeDatabase({ names: shipped(), rows: [future] }),
      jobsStarted: () => true,
      dispatchReady: () => true,
    });
    await expect(check()).resolves.toEqual({
      status: 'degraded',
      checks: { database: 'ok', migrations: 'ok', schema: 'degraded', queue: 'ok', dispatch: 'ok' },
      details: { schema: 'ahead_additive' },
    });

    const refused = createReadinessCheck({
      database: fakeDatabase({ names: shipped(), rows: [{ ...future, class: 'contract' }] }),
      jobsStarted: () => true,
      dispatchReady: () => true,
    });
    await expect(refused()).resolves.toEqual({
      status: 'down',
      checks: { database: 'ok', migrations: 'down', queue: 'ok', dispatch: 'ok' },
    });
  });

  it('reports migrations down when the database is behind this build', async () => {
    const behind = shipped().slice(0, -1);
    const check = createReadinessCheck({
      database: fakeDatabase({ names: behind }),
      jobsStarted: null,
      dispatchReady: null,
    });
    const report = await check();
    expect(report.checks.database).toBe('ok');
    expect(report.checks.migrations).toBe('down');
  });
});
