/**
 * The harness's own teardown, against a real PostgreSQL 18.
 *
 * CI run 34671397340 failed the whole `e2e-fake-claude` job with every test in it passing: a
 * `drop database … with (force)` reached an idle connection of an `apps/server` instance whose
 * `stop()` had already returned, and the resulting `57P01` arrived as `pg.Pool`'s `'error'` event,
 * which is thrown when nothing listens. The race is in `pool.end()` — it resolves before the
 * sockets it just closed are gone (measured in `packages/infrastructure/src/db/pool-errors.ts`).
 *
 * **This file does not race anything** (standing rule 76). A flake whose only random element is
 * its rate is not evidence, so the interleaving is made certain instead: the pool here still holds
 * a live idle client at the moment the drop lands, which is the same instant the CI failure hit by
 * accident. What that cannot show is the *frequency* of the accident, only that the guard covers
 * it — the frequency is a property of the machine, and CI is its tier of record.
 */

import type { LogFields, Logger } from '@platform/application';
import { db } from '@platform/infrastructure';
import { describe, expect, it } from 'vitest';
import { createTestDatabase, createTestPool, strictPoolLogger, type TestPool } from './postgres.js';

/** Runs `fn` with every uncaught exception collected instead of ending the process. */
const withUncaughtWatch = async (fn: (seen: unknown[]) => Promise<void>): Promise<void> => {
  const seen: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    seen.push(error);
  };
  process.on('uncaughtException', onUncaught);
  try {
    await fn(seen);
  } finally {
    process.off('uncaughtException', onUncaught);
  }
};

/** Bounded wait for a condition, so a failure names what never happened rather than timing out. */
const until = async (what: string, ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 10_000;
  while (!ready()) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never happened`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

/** Connects one client and hands it back to the pool, so the pool is holding an idle connection. */
const holdIdleConnection = async (pool: TestPool): Promise<void> => {
  const client = await pool.connect();
  await client.query('select 1');
  client.release();
  expect(pool.idleCount).toBe(1);
};

describe('dropping a database out from under a pool that is still attached', () => {
  it('reaches the pool as a swallowed 57P01, not as an uncaught exception', async () => {
    const database = await createTestDatabase('drop-race');
    const pool = createTestPool(database.connectionString, { max: 2 });

    await withUncaughtWatch(async (seen) => {
      await holdIdleConnection(pool);

      // The force is what terminates the idle backend. Without it the drop would fail instead.
      await database.drop();

      // The wait ends on **either** outcome, so the unguarded harness fails on the assertion that
      // names the defect rather than on a ten-second timeout that names nothing. Measured against
      // a mutated copy with the listener deleted: it reports the `57P01` here.
      await until(
        'the terminated connection to reach the pool',
        () => pool.terminations.length > 0 || seen.length > 0,
      );
      expect(seen).toEqual([]);

      // And the swallow branch is the one that ran, on the code it is allowed to swallow: "no
      // uncaught exception" is also what a pool that never connected produces.
      expect(pool.terminations).toHaveLength(1);
      expect((pool.terminations[0] as { code?: string }).code).toBe('57P01');
    });

    await pool.end();
  });

  it('re-throws an idle-client error that is not a termination', async () => {
    const database = await createTestDatabase('drop-race-other');
    const pool = createTestPool(database.connectionString, { max: 2 });
    try {
      // The other side of the boundary (standing rule 10). `emit` is synchronous, so the throw a
      // socket callback would have suffered is catchable here — pg-pool re-emits exactly this way.
      const unrelated = Object.assign(new Error('relation "nope" does not exist'), {
        code: '42P01',
      });
      expect(() => pool.emit('error', unrelated)).toThrow('relation "nope" does not exist');
      expect(pool.terminations).toEqual([]);
    } finally {
      await pool.end();
      await database.drop();
    }
  });

  it('makes a production pool built inside this tier as strict as a createTestPool one', () => {
    // Ten sites need a *real* `createDatabasePool` pool rather than `createTestPool` — `grants`
    // tests the factory itself, `pg-boss-jobs` hands pg-boss the pool a runtime would. Their only
    // seam into the guard is its logger, so `strictPoolLogger` is where their half of the
    // asymmetry lives, and this is the case that holds it from both sides. No connection is made:
    // pg-pool re-emits on the pool exactly this way, which is what the listener sees.
    const handle = db.createDatabasePool(
      {
        url: 'postgres://platform:not-a-real-password@127.0.0.1:1/unused',
        appRole: '',
        poolMax: 1,
        connectionTimeoutMs: 1_000,
        partitionMonthsAhead: 3,
        transcriptRetentionDays: null,
      },
      strictPoolLogger,
    );

    const lost = Object.assign(new Error('terminating connection'), { code: '57P01' });
    expect(() => handle.pool.emit('error', lost)).not.toThrow();

    const surprise = Object.assign(new Error('relation "nope" does not exist'), { code: '42P01' });
    expect(() => handle.pool.emit('error', surprise)).toThrow('relation "nope" does not exist');
  });

  it('leaves the runtime pool an apps/server instance runs on logging instead of dying', async () => {
    // The pool that actually failed in CI is not one of this harness's: it is the one
    // `createDatabasePool` builds inside `startRuntime`. Same drop, same window, different owner.
    const lines: { level: string; fields: LogFields }[] = [];
    const at =
      (level: string) =>
      (fields: LogFields): void => {
        lines.push({ level, fields });
      };
    const logger: Logger = {
      debug: at('debug'),
      info: at('info'),
      warn: at('warn'),
      error: at('error'),
    };

    const database = await createTestDatabase('drop-race-runtime');
    const handle = db.createDatabasePool(
      {
        url: database.connectionString,
        appRole: '',
        poolMax: 2,
        connectionTimeoutMs: 5_000,
        partitionMonthsAhead: 3,
        transcriptRetentionDays: null,
      },
      logger,
    );

    await withUncaughtWatch(async (seen) => {
      const client = await handle.pool.connect();
      await client.query('select 1');
      client.release();

      await database.drop();

      await until(
        'the runtime pool to report the lost connection',
        () => lines.length > 0 || seen.length > 0,
      );
      expect(seen).toEqual([]);
      expect(lines).toHaveLength(1);
      expect(lines[0]?.level).toBe('warn');
      expect(lines[0]?.fields).toMatchObject({ code: '57P01' });
    });

    await handle.close();
  });
});
