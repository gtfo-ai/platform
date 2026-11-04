/**
 * The harness's stale-write refusal (ci-fix, session 21), against a real PostgreSQL 18.
 *
 * `createMigratedDatabase` puts a `before insert` trigger on every partitioned table that refuses a
 * row more than `staleWriteDays` before `now()`, so a fixture that writes a fixed calendar instant
 * fails with a message naming it a fortnight before the event log's partition window would fail it
 * on the 1st of a month. Held here: the refusal and its message, the boundary on either side, every
 * partitioned table covered (read off `platform_table_policy`, so a new one is covered too), and
 * the `null` switch.
 */
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase, STALE_WRITE_REFUSAL } from './migrated.js';
import { withClient } from './postgres.js';

const DAY_MS = 24 * 60 * 60_000;

/** Appends one event row at `occurredAt` with raw SQL, so no application guard runs first. */
const insertEvent = (connectionString: string, occurredAt: Date): Promise<unknown> =>
  withClient(connectionString, (client) =>
    client.query(
      `insert into events (stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
       values ('task', $1, 1, 'task.created', '{}'::jsonb, '{"kind":"system","component":"t"}'::jsonb, $2)`,
      [randomUUID(), occurredAt.toISOString()],
    ),
  );

/** Every partition of a partitioned table, and which tables carry the harness trigger. */
const coverage = (connectionString: string) =>
  withClient(connectionString, async (client) => {
    const partitions = await client.query<{ name: string }>(
      `select c.relname as name
         from platform_table_policy p
         join pg_inherits i on i.inhparent = format('public.%I', p.table_name)::regclass
         join pg_class c on c.oid = i.inhrelid
        where p.partition_column is not null
        order by c.relname`,
    );
    const triggered = await client.query<{ name: string }>(
      `select c.relname as name
         from pg_trigger t join pg_class c on c.oid = t.tgrelid
        where t.tgname = 'test_harness_refuse_stale_write'
        order by c.relname`,
    );
    return {
      partitions: partitions.rows.map((row) => row.name),
      triggered: triggered.rows.map((row) => row.name),
    };
  });

describe('createMigratedDatabase refuses a stale write to a partitioned table', () => {
  let database: MigratedDatabase;
  let unguarded: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('stale-write');
    unguarded = await createMigratedDatabase('stale-write-off', { staleWriteDays: null });
  }, 120_000);

  afterAll(async () => {
    await database?.drop();
    await unguarded?.drop();
  });

  it('covers every partition the clock decided, and no partitioned parent', async () => {
    const { partitions, triggered } = await coverage(database.connectionString);
    // Six partitioned tables today (events, run_messages, redaction_log, config_audit,
    // cost_entries, integration_actions), each with three past months, the current one and three
    // ahead; a new table only adds to it.
    // The three months ahead are `APP_DB_PARTITION_MONTHS_AHEAD`'s default; a lower setting fails this.
    expect(partitions.length).toBeGreaterThanOrEqual(6 * 7);
    expect(triggered).toEqual(partitions);
  });

  it('refuses a row older than the bound, naming the table, the column and the remedy', async () => {
    const stale = new Date(Date.now() - 15 * DAY_MS);
    await expect(insertEvent(database.connectionString, stale)).rejects.toThrow(
      new RegExp(`^${STALE_WRITE_REFUSAL}: events\\.occurred_at = .* is more than 14 days`),
    );
  });

  it('accepts a row inside the bound, and one in the future', async () => {
    await insertEvent(database.connectionString, new Date(Date.now() - 13 * DAY_MS));
    await insertEvent(database.connectionString, new Date(Date.now() + DAY_MS));
  });

  it('leaves alone a fixed month a suite partitions for itself, which no calendar moves', async () => {
    await withClient(database.connectionString, (client) =>
      client.query(
        `create table events_2020_01 partition of events
           for values from ('2020-01-01') to ('2020-02-01')`,
      ),
    );
    await insertEvent(database.connectionString, new Date('2020-01-05T10:00:00.000Z'));
  });

  it('installs nothing when staleWriteDays is null', async () => {
    expect((await coverage(unguarded.connectionString)).triggered).toEqual([]);
    await insertEvent(unguarded.connectionString, new Date(Date.now() - 40 * DAY_MS));
  });
});
