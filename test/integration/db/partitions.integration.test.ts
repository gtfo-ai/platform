/**
 * WP-03 acceptance: the partition auto-creation job.
 *
 * `migrate` creates the current month plus a few ahead; the scheduled job keeps that window moving
 * (WP-05 registers it on pg-boss cron). Retention drops whole partitions and only for the scope
 * technical/03 allows — transcripts — leaving events, cost and audit alone.
 */
import { db } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { withClient } from '../support/postgres.js';

const monthSuffix = (offset: number): string => {
  const now = new Date();
  const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  return `${month.getUTCFullYear()}_${String(month.getUTCMonth() + 1).padStart(2, '0')}`;
};

const partitionsOf = async (client: pg.Client, parent: string): Promise<string[]> => {
  const { rows } = await client.query<{ relname: string }>(
    `select c.relname
       from pg_class parent
       join pg_inherits i on i.inhparent = parent.oid
       join pg_class c on c.oid = i.inhrelid
      where parent.relname = $1
        and parent.relnamespace = 'public'::regnamespace
      order by c.relname`,
    [parent],
  );
  return rows.map((row) => row.relname);
};

describe('monthly partitions', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('partitions');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('migrate creates the current month and three ahead for every partitioned table', async () => {
    expect(database.report.partitionsCreated.length).toBe(6 * 4);

    await withClient(database.connectionString, async (client) => {
      for (const parent of ['events', 'run_messages', 'cost_entries']) {
        const partitions = await partitionsOf(client, parent);
        expect(partitions).toEqual([0, 1, 2, 3].map((n) => `${parent}_${monthSuffix(n)}`));
      }
    });
  });

  it('the maintenance job is idempotent and extends the window on demand', async () => {
    await withClient(database.connectionString, async (client) => {
      await expect(db.ensureMonthlyPartitions(client, 3)).resolves.toEqual([]);

      const created = await db.ensureMonthlyPartitions(client, 5);
      expect(created).toEqual(
        [
          'events',
          'run_messages',
          'config_audit',
          'cost_entries',
          'integration_actions',
          'redaction_log',
        ]
          .flatMap((parent) => [4, 5].map((n) => `${parent}_${monthSuffix(n)}`))
          .sort(),
      );

      await expect(db.ensureMonthlyPartitions(client, 5)).resolves.toEqual([]);
    });
  });

  it('routes a row into the partition its timestamp belongs to', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query(
        `insert into events (stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
         values ('task', '01890000-0000-7000-8000-0000000000aa', 1, 'task.created', '{}'::jsonb, '{"kind":"system"}'::jsonb,
                 date_trunc('month', now()) + interval '2 months' + interval '3 days')`,
      );
      const { rows } = await client.query<{ count: string }>(
        `select count(*)::text as count from events_${monthSuffix(2)}`,
      );
      expect(Number(rows[0]?.count)).toBe(1);
    });
  });

  it('fails loudly rather than silently when no partition covers a row (no DEFAULT partition)', async () => {
    await withClient(database.connectionString, async (client) => {
      await expect(
        client.query(
          `insert into events (stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
           values ('task', '01890000-0000-7000-8000-0000000000bb', 1, 'task.created', '{}'::jsonb, '{"kind":"system"}'::jsonb,
                   now() + interval '10 years')`,
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('drops nothing at all while no retention is configured, which is the default', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query(
        "create table run_messages_2020_01 partition of run_messages for values from ('2020-01-01') to ('2020-02-01')",
      );

      expect(database.report.transcriptRetentionDays).toBeNull();
      await expect(db.dropExpiredTranscriptPartitions(client)).resolves.toEqual([]);
      expect(await partitionsOf(client, 'run_messages')).toContain('run_messages_2020_01');
    });
  });

  it('applies the configured window and touches nothing outside the transcripts scope', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query(
        "create table events_2020_01 partition of events for values from ('2020-01-01') to ('2020-02-01')",
      );
      // Only the schema owner can set this; see the grants suite for the proof.
      await client.query(
        "update platform_table_policy set retention_days = 30 where retention_scope = 'transcripts'",
      );

      await expect(db.dropExpiredTranscriptPartitions(client)).resolves.toEqual([
        'run_messages_2020_01',
      ]);
      expect(await partitionsOf(client, 'events')).toContain('events_2020_01');
      expect(await partitionsOf(client, 'run_messages')).not.toContain('run_messages_2020_01');
    });
  });

  it('never drops a partition that could still hold a retained row', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query(
        "create table run_messages_2019_01 partition of run_messages for values from ('2019-01-01') to ('2019-02-01')",
      );
      // 100 years of retention: the cutoff predates every partition.
      await client.query(
        "update platform_table_policy set retention_days = 36500 where retention_scope = 'transcripts'",
      );

      const before = await partitionsOf(client, 'run_messages');
      await expect(db.dropExpiredTranscriptPartitions(client)).resolves.toEqual([]);
      expect(await partitionsOf(client, 'run_messages')).toEqual(before);
    });
  });

  it('maintainPartitions extends the window and applies the stored retention', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query(
        "update platform_table_policy set retention_days = null where retention_scope = 'transcripts'",
      );

      const kept = await db.maintainPartitions(client, { partitionMonthsAhead: 5 });
      expect(kept.dropped).toEqual([]);
      expect(await partitionsOf(client, 'run_messages')).toContain('run_messages_2019_01');

      await client.query(
        "update platform_table_policy set retention_days = 90 where retention_scope = 'transcripts'",
      );
      const purged = await db.maintainPartitions(client, { partitionMonthsAhead: 5 });
      expect(purged.dropped).toEqual(['run_messages_2019_01']);
    });
  });

  it('rejects a retention window below one day at the constraint level', async () => {
    await withClient(database.connectionString, async (client) => {
      await expect(
        client.query(
          "update platform_table_policy set retention_days = 0 where retention_scope = 'transcripts'",
        ),
      ).rejects.toMatchObject({ code: '23514' });
    });
  });

  it('rejects an absurd window instead of creating thousands of partitions', async () => {
    await withClient(database.connectionString, async (client) => {
      await expect(db.ensureMonthlyPartitions(client, 121)).rejects.toThrow(/between 0 and 120/);
    });
  });

  it('computes the same bounds from a non-UTC session (the function pins its own timezone)', async () => {
    await withClient(database.connectionString, async (client) => {
      await client.query("set timezone = 'Europe/Prague'");
      // Would abort with "partition would overlap" if the bounds were built in the caller's zone.
      await expect(db.ensureMonthlyPartitions(client, 5)).resolves.toEqual([]);
      await client.query("set timezone = 'Pacific/Kiritimati'");
      await expect(db.ensureMonthlyPartitions(client, 5)).resolves.toEqual([]);
      await client.query('reset timezone');
    });
  });
});
