/**
 * The event store's structural invariants (TD-005).
 *
 * technical/03 asks for `UNIQUE(stream_type, stream_id, stream_seq)` on `events`, which a
 * partitioned table cannot carry — every unique constraint must contain the partition key, which
 * would weaken it to "unique within one month". The guarantee is provided instead by
 * `event_streams` plus the `events_stream_seq_guard` trigger, so this proves it holds across a
 * month boundary, which is exactly the case a per-partition index would have missed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { withClient } from '../support/postgres.js';

const UNIQUE_VIOLATION = '23505';

const append = (streamId: string, seq: number, occurredAt = 'now()') => ({
  text: `insert into events (stream_type, stream_id, stream_seq, type, payload, actor, occurred_at)
         values ('task', $1, $2, 'task.created', '{}'::jsonb, '{"kind":"system"}'::jsonb, ${occurredAt})
         returning position`,
  values: [streamId, seq],
});

describe('append-only event log', () => {
  let database: MigratedDatabase;

  beforeAll(async () => {
    database = await createMigratedDatabase('eventlog');
  });

  afterAll(async () => {
    await database?.drop();
  });

  it('assigns a gapless per-stream sequence and a globally increasing position', async () => {
    await withClient(database.connectionString, async (client) => {
      const stream = '01890000-0000-7000-8000-000000000010';
      const first = await client.query<{ position: string }>(append(stream, 1));
      const second = await client.query<{ position: string }>(append(stream, 2));
      expect(Number(second.rows[0]?.position)).toBeGreaterThan(Number(first.rows[0]?.position));

      const { rows } = await client.query<{ last_seq: number }>(
        'select last_seq from event_streams where stream_type = $1 and stream_id = $2',
        ['task', stream],
      );
      expect(rows[0]?.last_seq).toBe(2);
    });
  });

  it('rejects a duplicate sequence, including across a partition boundary', async () => {
    await withClient(database.connectionString, async (client) => {
      const stream = '01890000-0000-7000-8000-000000000011';
      await client.query(append(stream, 1));

      await expect(client.query(append(stream, 1))).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });

      // Same sequence, next month's partition: a per-partition unique index would have allowed it.
      await expect(
        client.query(append(stream, 1, "date_trunc('month', now()) + interval '1 month 2 days'")),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  it('rejects a gap in the sequence', async () => {
    await withClient(database.connectionString, async (client) => {
      const stream = '01890000-0000-7000-8000-000000000012';
      await client.query(append(stream, 1));
      await expect(client.query(append(stream, 5))).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
      });
    });
  });

  it('keeps sequences independent per stream', async () => {
    await withClient(database.connectionString, async (client) => {
      const a = '01890000-0000-7000-8000-000000000013';
      const b = '01890000-0000-7000-8000-000000000014';
      await client.query(append(a, 1));
      await client.query(append(b, 1));
      await client.query(append(a, 2));

      const { rows } = await client.query<{ stream_id: string; last_seq: number }>(
        'select stream_id, last_seq from event_streams where stream_id in ($1, $2) order by stream_id',
        [a, b],
      );
      expect(rows).toEqual([
        { stream_id: a, last_seq: 2 },
        { stream_id: b, last_seq: 1 },
      ]);
    });
  });

  it('stamps every event with the transaction that wrote it (research/07 fencing)', async () => {
    await withClient(database.connectionString, async (client) => {
      const stream = '01890000-0000-7000-8000-000000000015';
      await client.query('begin');
      await client.query(append(stream, 1));
      await client.query(append(stream, 2));
      await client.query('commit');

      const { rows } = await client.query<{ distinct_xacts: string }>(
        'select count(distinct xact_id)::text as distinct_xacts from events where stream_id = $1',
        [stream],
      );
      expect(Number(rows[0]?.distinct_xacts)).toBe(1);
    });
  });

  it('deduplicates webhook deliveries in the inbox', async () => {
    // `redaction_count` is stated because migration 0014 dropped its default: "nobody wrote the
    // column" and "nothing was redacted" must not be spelled the same way (standing rule 18), and
    // this insert is a writer like any other.
    const insert =
      'insert into inbox (provider, delivery_id, payload, redaction_count, verified)' +
      " values ('gitlab', 'd-1', '{}'::jsonb, 0, true)";
    await withClient(database.connectionString, async (client) => {
      await client.query(insert);
      await expect(client.query(insert)).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });

  it('serialises concurrent appends to one stream: one commits, the other is rejected', async () => {
    const stream = '01890000-0000-7000-8000-000000000017';

    await withClient(database.connectionString, async (first) => {
      await withClient(database.connectionString, async (second) => {
        await first.query('begin');
        await second.query('begin');

        // The upsert inside the trigger takes the event_streams row lock, so the second insert
        // blocks here rather than reading a stale counter. This is the contract WP-04 relies on.
        await first.query(append(stream, 1));
        const blocked = second.query(append(stream, 1));

        await first.query('commit');
        await expect(blocked).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
        await second.query('rollback');
      });
    });

    await withClient(database.connectionString, async (client) => {
      const events = await client.query<{ count: string }>(
        'select count(*)::text as count from events where stream_id = $1',
        [stream],
      );
      expect(Number(events.rows[0]?.count)).toBe(1);

      // The loser's counter increment rolled back with its transaction.
      const counter = await client.query<{ last_seq: number }>(
        'select last_seq from event_streams where stream_type = $1 and stream_id = $2',
        ['task', stream],
      );
      expect(counter.rows[0]?.last_seq).toBe(1);

      // And the stream is still appendable at the next sequence.
      await client.query(append(stream, 2));
    });
  });

  it('records a handler execution once per (event, handler)', async () => {
    await withClient(database.connectionString, async (client) => {
      const stream = '01890000-0000-7000-8000-000000000016';
      const { rows } = await client.query<{ position: string }>(append(stream, 1));
      const position = rows[0]?.position;

      await client.query(
        "insert into handler_executions (event_position, handler, priority, status) values ($1, 'intake', 10, 'succeeded')",
        [position],
      );
      await expect(
        client.query(
          "insert into handler_executions (event_position, handler, priority, status) values ($1, 'intake', 10, 'succeeded')",
          [position],
        ),
      ).rejects.toMatchObject({ code: UNIQUE_VIOLATION });
    });
  });
});
