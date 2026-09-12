/**
 * The price-table maintenance job, against the in-memory `Jobs` fake.
 *
 * Standing rule 1 first: the fake's divergence register says cron fires when the expression's
 * previous occurrence is less than a minute old and nothing else fired in that minute, and that
 * handlers run only inside `advance`/`drain` — which is what the schedule case below leans on. The
 * SQL itself is asserted against a real database in `test/integration/cost/`; here the subject is
 * the registration and the shape of the pass.
 */
import { describe, expect, it } from 'vitest';
import type { SqlExecutor } from '../events/sql.js';
import { createInMemoryJobs } from '../jobs/in-memory-jobs.js';
import {
  maintainPriceList,
  PRICE_LIST_MAINTENANCE_CRON,
  PRICE_LIST_MAINTENANCE_JOB,
  registerPriceListMaintenance,
} from './price-list-maintenance.js';

interface FakeSql extends SqlExecutor {
  readonly calls: string[];
}

const fakeSql = (unpriced: { model: string; rows: number }[] = [], closed = 0): FakeSql => {
  const calls: string[] = [];
  return {
    calls,
    query: async <R extends Record<string, unknown>>(text: string) => {
      calls.push(text.trim().split('\n')[0]?.trim() ?? '');
      if (text.includes('update price_list')) {
        return { rows: [] as R[], rowCount: closed };
      }
      return {
        rows: unpriced.map((row) => row as unknown as R),
        rowCount: unpriced.length,
      };
    },
  };
};

describe('maintainPriceList', () => {
  it('reports the rows it closed and the models it could not price', async () => {
    const sql = fakeSql(
      [
        { model: 'claude-new-6', rows: 3 },
        { model: 'some-other', rows: 1 },
      ],
      2,
    );
    expect(await maintainPriceList(sql)).toEqual({
      closed: 2,
      unpricedModels: ['claude-new-6', 'some-other'],
      unpricedRows: 4,
    });
  });

  it('reports nothing to do as zeros, which is a measurement rather than an absence', async () => {
    expect(await maintainPriceList(fakeSql())).toEqual({
      closed: 0,
      unpricedModels: [],
      unpricedRows: 0,
    });
  });

  it('never inserts a price: the platform has no verified feed to write one from', async () => {
    const sql = fakeSql();
    await maintainPriceList(sql);
    expect(sql.calls.some((text) => /insert\s+into\s+price_list/i.test(text))).toBe(false);
  });
});

describe('registerPriceListMaintenance', () => {
  it('declares the queue, schedules the cron in an explicit zone and runs a pass', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    const results: unknown[] = [];

    await registerPriceListMaintenance(runtime.jobs, {
      db: fakeSql([{ model: 'claude-new-6', rows: 1 }], 1),
      timezone: 'Europe/Prague',
      onResult: (result) => results.push(result),
    });

    expect(await runtime.jobs.listCronSchedules()).toEqual([
      {
        queue: PRICE_LIST_MAINTENANCE_JOB,
        key: '',
        cron: PRICE_LIST_MAINTENANCE_CRON,
        timezone: 'Europe/Prague',
      },
    ]);

    await runtime.jobs.enqueue({ queue: PRICE_LIST_MAINTENANCE_JOB });
    await runtime.drain();
    expect(results).toEqual([{ closed: 1, unpricedModels: ['claude-new-6'], unpricedRows: 1 }]);
  });

  it('fires from its own schedule, and not before', async () => {
    const runtime = createInMemoryJobs({ startTime: new Date('2026-06-01T02:00:00Z') });
    await runtime.start();
    const results: unknown[] = [];
    await registerPriceListMaintenance(runtime.jobs, {
      db: fakeSql(),
      timezone: 'UTC',
      onResult: (result) => results.push(result),
    });

    // 04:10 UTC is two hours out.
    await runtime.advance(60 * 60 * 1000);
    expect(results).toHaveLength(0);

    await runtime.advance(90 * 60 * 1000);
    expect(results).toHaveLength(1);
  });

  it('is exclusive, so two replicas cannot run one pass twice', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await registerPriceListMaintenance(runtime.jobs, { db: fakeSql(), timezone: 'UTC' });
    const first = await runtime.jobs.enqueue({ queue: PRICE_LIST_MAINTENANCE_JOB });
    const second = await runtime.jobs.enqueue({ queue: PRICE_LIST_MAINTENANCE_JOB });
    expect(first.status).toBe('enqueued');
    expect(second.status).toBe('coalesced');
  });

  it('works without an onResult hook', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await registerPriceListMaintenance(runtime.jobs, { db: fakeSql(), timezone: 'UTC' });
    await runtime.jobs.enqueue({ queue: PRICE_LIST_MAINTENANCE_JOB });
    await expect(runtime.drain()).resolves.toBeUndefined();
  });
});
