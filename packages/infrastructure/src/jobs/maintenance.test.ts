import { JOB_QUEUES } from '@platform/application';
import { describe, expect, it } from 'vitest';
import type { Queryable } from '../db/partitions.js';
import { createInMemoryJobs } from './in-memory-jobs.js';
import {
  PARTITION_MAINTENANCE_CRON,
  PARTITION_MAINTENANCE_JOB,
  registerPartitionMaintenance,
} from './maintenance.js';

interface FakeDatabase extends Queryable {
  /** Every statement the job issued, in order. */
  readonly calls: { text: string; values: readonly unknown[] }[];
}

/** A `Queryable` that answers the two SECURITY DEFINER functions the job calls. */
const fakeDatabase = (created: string[], dropped: string[]): FakeDatabase => {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  return {
    calls,
    query: async <R extends Record<string, unknown>>(text: string, values?: readonly unknown[]) => {
      calls.push({ text, values: values ?? [] });
      const row = text.includes('platform_ensure_partitions') ? { created } : { dropped };
      return { rows: [row as unknown as R] };
    },
  };
};

describe('registerPartitionMaintenance', () => {
  it('uses the queue name and cron WP-03 published, on the queue the port names', async () => {
    expect(PARTITION_MAINTENANCE_JOB).toBe(JOB_QUEUES.partitionMaintenance);
    expect(PARTITION_MAINTENANCE_CRON).toBe('20 3 * * *');
  });

  it('declares the queue, registers the schedule in an explicit zone and runs the job', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    const database = fakeDatabase(['run_messages_2026_10'], []);
    const results: unknown[] = [];

    await registerPartitionMaintenance(runtime.jobs, {
      db: database,
      partitionMonthsAhead: 6,
      timezone: 'Europe/Prague',
      onResult: (result) => results.push(result),
    });

    expect(await runtime.jobs.listCronSchedules()).toEqual([
      {
        queue: PARTITION_MAINTENANCE_JOB,
        key: '',
        cron: PARTITION_MAINTENANCE_CRON,
        timezone: 'Europe/Prague',
      },
    ]);

    await runtime.jobs.enqueue({ queue: PARTITION_MAINTENANCE_JOB });
    await runtime.drain();

    expect(results).toEqual([{ created: ['run_messages_2026_10'], dropped: [] }]);
    expect(database.calls).toEqual([
      { text: 'select platform_ensure_partitions($1::int) as created', values: [6] },
      {
        text: 'select platform_drop_expired_partitions($1::text) as dropped',
        values: ['transcripts'],
      },
    ]);
  });

  it('fires from its own cron schedule', async () => {
    const runtime = createInMemoryJobs({ startTime: new Date('2026-06-01T01:00:00Z') });
    await runtime.start();
    const database = fakeDatabase([], []);
    const results: unknown[] = [];

    await registerPartitionMaintenance(runtime.jobs, {
      db: database,
      partitionMonthsAhead: 3,
      timezone: 'UTC',
      onResult: (result) => results.push(result),
    });

    // 03:20 UTC is more than an hour away, so nothing should have run yet.
    await runtime.advance(60 * 60 * 1000);
    expect(results).toHaveLength(0);

    await runtime.advance(90 * 60 * 1000);
    expect(results).toHaveLength(1);
  });

  it('is exclusive, so a second replica cannot queue the same maintenance twice', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await registerPartitionMaintenance(runtime.jobs, {
      db: fakeDatabase([], []),
      partitionMonthsAhead: 3,
      timezone: 'UTC',
    });

    const first = await runtime.jobs.enqueue({ queue: PARTITION_MAINTENANCE_JOB });
    const second = await runtime.jobs.enqueue({ queue: PARTITION_MAINTENANCE_JOB });
    expect(first.status).toBe('enqueued');
    expect(second.status).toBe('coalesced');
  });

  it('works without an onResult hook', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await registerPartitionMaintenance(runtime.jobs, {
      db: fakeDatabase([], []),
      partitionMonthsAhead: 3,
      timezone: 'UTC',
    });
    await runtime.jobs.enqueue({ queue: PARTITION_MAINTENANCE_JOB });
    await expect(runtime.drain()).resolves.toBeUndefined();
  });
});
