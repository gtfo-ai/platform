import { describe, expect, it } from 'vitest';
import {
  dropExpiredTranscriptPartitions,
  ensureMonthlyPartitions,
  maintainPartitions,
  PARTITION_MAINTENANCE_CRON,
  PARTITION_MAINTENANCE_JOB,
  type Queryable,
  TRANSCRIPT_RETENTION_SCOPE,
} from './partitions.js';

interface Call {
  readonly queryText: string;
  readonly values: readonly unknown[];
}

const recorder = (results: Record<string, unknown>[]): { db: Queryable; calls: Call[] } => {
  const calls: Call[] = [];
  let index = 0;
  const db: Queryable = {
    query: async <R extends Record<string, unknown>>(
      queryText: string,
      values?: readonly unknown[],
    ) => {
      calls.push({ queryText, values: values ?? [] });
      const row = results[index];
      index += 1;
      await Promise.resolve();
      return { rows: row === undefined ? [] : [row as R] };
    },
  };
  return { db, calls };
};

describe('partition maintenance', () => {
  it('asks the database to create the window and returns what it created', async () => {
    const { db, calls } = recorder([{ created: ['events_2026_10'] }]);

    await expect(ensureMonthlyPartitions(db, 3)).resolves.toEqual(['events_2026_10']);
    expect(calls[0]?.queryText).toContain('platform_ensure_partitions');
    expect(calls[0]?.values).toEqual([3]);
  });

  it('never passes a retention window: the server holds it (grants bypass)', async () => {
    const { db, calls } = recorder([{ dropped: ['run_messages_2020_01'] }]);

    await expect(dropExpiredTranscriptPartitions(db)).resolves.toEqual(['run_messages_2020_01']);
    expect(calls[0]?.queryText).toContain('platform_drop_expired_partitions');
    expect(calls[0]?.values).toEqual([TRANSCRIPT_RETENTION_SCOPE]);
    expect(calls[0]?.values).toHaveLength(1);
  });

  it('tolerates a function returning no row', async () => {
    const { db } = recorder([]);
    await expect(ensureMonthlyPartitions(db, 1)).resolves.toEqual([]);
    await expect(dropExpiredTranscriptPartitions(db)).resolves.toEqual([]);
  });

  it('extends the window before applying retention', async () => {
    const { db, calls } = recorder([{ created: ['events_2026_10'] }, { dropped: ['x_2020_01'] }]);

    await expect(maintainPartitions(db, { partitionMonthsAhead: 3 })).resolves.toEqual({
      created: ['events_2026_10'],
      dropped: ['x_2020_01'],
    });
    expect(calls.map((call) => call.queryText.includes('ensure'))).toEqual([true, false]);
  });

  it('names the job and its schedule for WP-05 to register', () => {
    expect(PARTITION_MAINTENANCE_JOB).toBe('db.partitions.maintain');
    expect(PARTITION_MAINTENANCE_CRON).toMatch(/^\d+ \d+ \* \* \*$/);
  });
});
