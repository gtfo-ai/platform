/**
 * Queue migrations (TD-004's 2026-11-26 amendment, BD-034, BACKLOG 1656) against recording fakes:
 * each applied once, in order, update before record; a recorded one skipped; an edited one refused
 * before anything is applied; a newer build's unknown row ignored. The integration tier runs the
 * same function against a real pg-boss (`test/integration/db/migrations.integration.test.ts`).
 */
import { JOB_QUEUE_MIGRATIONS, type JobQueueMigration } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  applyJobQueueMigrations,
  canonicalQueueMigrationOptions,
  JobQueueMigrationChangedError,
  pgBossQueueUpdateOptions,
} from './job-queue-migrations.js';

const MIGRATIONS: readonly JobQueueMigration[] = [
  { name: '0001_a', queue: 'queue.a', options: { retryLimit: 24, retryDelayMaxSeconds: 900 } },
  { name: '0002_b', queue: 'queue.b', options: { retryLimit: 5, retryBackoff: true } },
];

const recorder = (
  recorded: Record<string, string> = {},
  options: { readonly tableMissing?: boolean } = {},
) => {
  const calls: string[] = [];
  const rows = new Map(Object.entries(recorded));
  return {
    calls,
    rows,
    ports: {
      query: async (text: string, values?: readonly unknown[]) => {
        if (text.includes('to_regclass')) {
          return [{ present: options.tableMissing !== true }];
        }
        if (text.startsWith('select')) {
          return [...rows].map(([name, options]) => ({ name, options }));
        }
        calls.push(`record ${String(values?.[0])} ${String(values?.[2])}`);
        rows.set(String(values?.[0]), String(values?.[2]));
        return [];
      },
      updateQueue: async (queue: string, options: Record<string, unknown>) => {
        calls.push(`update ${queue} ${JSON.stringify(options)}`);
      },
    },
  };
};

describe('applyJobQueueMigrations', () => {
  it('applies each migration once, in order, the update before its record', async () => {
    const fake = recorder();
    expect(await applyJobQueueMigrations(fake.ports, MIGRATIONS)).toEqual(['0001_a', '0002_b']);
    expect(fake.calls).toEqual([
      'update queue.a {"retryLimit":24,"retryDelayMax":900}',
      'record 0001_a {"retryDelayMaxSeconds":900,"retryLimit":24}',
      'update queue.b {"retryLimit":5,"retryBackoff":true}',
      'record 0002_b {"retryBackoff":true,"retryLimit":5}',
    ]);
    // The second run finds both recorded and applies nothing.
    fake.calls.length = 0;
    expect(await applyJobQueueMigrations(fake.ports, MIGRATIONS)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it('applies only what is not recorded, and ignores a recorded name this build does not carry', async () => {
    const fake = recorder({
      '0001_a': '{"retryLimit": 24, "retryDelayMaxSeconds": 900}',
      '0009_newer_build': '{"retryLimit": 99}',
    });
    expect(await applyJobQueueMigrations(fake.ports, MIGRATIONS)).toEqual(['0002_b']);
    expect(fake.calls.filter((call) => call.startsWith('update'))).toEqual([
      'update queue.b {"retryLimit":5,"retryBackoff":true}',
    ]);
  });

  it('refuses a recorded migration whose options this build changed, before applying anything (forward-only)', async () => {
    const fake = recorder({ '0002_b': '{"retryLimit": 4, "retryBackoff": true}' });
    const applying = applyJobQueueMigrations(fake.ports, MIGRATIONS);
    await expect(applying).rejects.toThrow(JobQueueMigrationChangedError);
    await expect(applyJobQueueMigrations(fake.ports, MIGRATIONS)).rejects.toThrow(
      /0002_b was applied with options \{"retryBackoff":true,"retryLimit":4\} but this build carries \{"retryBackoff":true,"retryLimit":5\}/,
    );
    // 0001_a is not recorded, and still nothing was applied: the refusal comes first.
    expect(fake.calls).toEqual([]);
  });
});

describe('a database migrated short of the record table', () => {
  it('applies nothing and reads nothing more: the migrate that creates the table applies them all', async () => {
    const fake = recorder({}, { tableMissing: true });
    expect(await applyJobQueueMigrations(fake.ports, MIGRATIONS)).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe('the mapping onto pg-boss', () => {
  it('names pg-boss’s options and states only the keys the row states', () => {
    expect(
      pgBossQueueUpdateOptions({
        retryLimit: 24,
        retryDelaySeconds: 30,
        retryBackoff: true,
        retryDelayMaxSeconds: 900,
      }),
    ).toEqual({ retryLimit: 24, retryDelay: 30, retryBackoff: true, retryDelayMax: 900 });
    expect(pgBossQueueUpdateOptions({ expireInSeconds: 60 })).toEqual({ expireInSeconds: 60 });
  });

  it('records the options with sorted keys, so a reordered literal is the same migration', () => {
    expect(canonicalQueueMigrationOptions({ retryLimit: 1, retryBackoff: false })).toBe(
      canonicalQueueMigrationOptions({ retryBackoff: false, retryLimit: 1 }),
    );
  });

  it('ships the BD-034 migrations, each stating what pg-boss can update', () => {
    for (const migration of JOB_QUEUE_MIGRATIONS) {
      expect(Object.keys(pgBossQueueUpdateOptions(migration.options)).length).toBeGreaterThan(0);
      expect(pgBossQueueUpdateOptions(migration.options)).not.toHaveProperty('policy');
    }
  });
});
