/**
 * The event store's structural invariants (TD-005).
 *
 * technical/03 asks for `UNIQUE(stream_type, stream_id, stream_seq)` on `events`, which a
 * partitioned table cannot carry — every unique constraint must contain the partition key, which
 * would weaken it to "unique within one month". The guarantee is provided instead by
 * `event_streams` plus the `events_stream_seq_guard` trigger, so this proves it holds across a
 * month boundary, which is exactly the case a per-partition index would have missed.
 */
import { inspect } from 'node:util';
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

/**
 * The outcome of a query the test refuses to race — see `outcomeOf`.
 *
 * `where` is PostgreSQL's context line, and it is asserted because it says *which* guard refused
 * the append: the trigger, not a unique index, not a check constraint.
 */
type QueryOutcome =
  | { readonly kind: 'fulfilled' }
  | {
      readonly kind: 'rejected';
      readonly code: string | undefined;
      readonly where: string | undefined;
    };

/**
 * Hands a query's rejection a handler **on the line that starts it**.
 *
 * `const blocked = client.query(…)`, then `await somethingElse()`, and only then
 * `await expect(blocked).rejects…` leaves the rejection unowned for the whole of the `await` in
 * between. If it lands inside that window — and releasing the row lock is exactly what makes it
 * land there — Node reports an `unhandledRejection`, vitest turns that into an unhandled error,
 * and the job goes **red with every test passing**. That is CI run `34692908462` on `38f3d82`, a
 * docs-only commit: `stream task/…017 is at sequence 2, cannot append 1` (`23505`, raised in
 * `events_enforce_stream_seq`), `22 passed (22)`, `231 passed (231)`, `FAIL: verify:integration`.
 * Reproduced here before it was fixed, byte for byte, by forcing the losing order below.
 *
 * `Promise.allSettled` would close the same hole; this exists so the assertion can name *which*
 * side was rejected and which committed, and so the two sides can be read in either order.
 */
const outcomeOf = (query: Promise<unknown>): Promise<QueryOutcome> =>
  query.then(
    (): QueryOutcome => ({ kind: 'fulfilled' }),
    (error: unknown): QueryOutcome => ({
      kind: 'rejected',
      code: (error as { code?: string }).code,
      where: (error as { where?: string }).where,
    }),
  );

/**
 * Blocks until `promise` has settled **without attaching a handler to it**, so the dangerous
 * interleaving is forced rather than waited for (rule 76: a flake's rate can be the only random
 * thing about it).
 *
 * `util.inspect` reads V8's promise state instead of subscribing to it — measured on
 * `node v25.1.0`: polling a rejected promise this way still fires `unhandledRejection`, and
 * attaching a handler afterwards produces `PromiseRejectionHandledWarning`. The renders are
 * `Promise { <pending> }`, `Promise { <rejected> [Error] }` and, at `depth: 0`, a bare
 * `Promise { [Object] }` when fulfilled — so "not pending" is the only usable test for settled.
 *
 * None of that is documented (nodejs.org/api/util.html describes neither), and the measurement is
 * from **one** runtime: this machine runs v25.1.0 while `.nvmrc` pins CI to 24, which could not be
 * measured here. That is why the first read is asserted rather than assumed — a caller reaches
 * this line one statement after issuing the query, so the promise cannot yet have settled, and a
 * Node that renders a pending promise some other way fails here by name instead of silently
 * turning this wait into no wait at all.
 */
const settleUnobserved = async (promise: Promise<unknown>, what: string): Promise<void> => {
  const rendered = (): string => inspect(promise, { depth: 0 });
  const first = rendered();
  if (!first.includes('<pending>')) {
    throw new Error(
      `node ${process.version} renders a freshly issued query as ${first}: this wait no longer forces anything`,
    );
  }
  const deadline = Date.now() + 10_000;
  while (rendered().includes('<pending>')) {
    if (Date.now() > deadline) {
      throw new Error(`${what} never settled`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

/**
 * The two orders the losing append can settle in, both run every time (rule 68).
 *
 * They differ only in when the test looks: CI's green runs read the winner's commit first and
 * found the rejection already owned; CI's red run had the rejection land while nothing was
 * looking. Each case gets its own stream so neither can borrow the other's counter.
 */
const interleavings = [
  {
    name: 'the winner’s commit is observed first',
    stream: '01890000-0000-7000-8000-000000000017',
    forceLoserFirst: false,
  },
  {
    name: 'the loser’s rejection settles before anything observes it',
    stream: '01890000-0000-7000-8000-000000000018',
    forceLoserFirst: true,
  },
];

/** What the database must look like once the pair is over, whichever order the test read. */
const assertOnlyTheWinnerLanded = async (
  connectionString: string,
  stream: string,
): Promise<void> => {
  await withClient(connectionString, async (client) => {
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
};

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

  it.each(interleavings)(
    'serialises concurrent appends to one stream: one commits, the other is rejected ($name)',
    async ({ stream, forceLoserFirst }) => {
      await withClient(database.connectionString, async (winner) => {
        await withClient(database.connectionString, async (loser) => {
          await winner.query('begin');
          await loser.query('begin');

          // The upsert inside the trigger takes the event_streams row lock, so the loser's insert
          // blocks there rather than reading a stale counter. The contract WP-04 relies on.
          await winner.query(append(stream, 1));

          // Both outcomes are owned from the line that starts them; nothing below can leak one.
          const loserOutcome = outcomeOf(loser.query(append(stream, 1)));
          const winnerOutcome = outcomeOf(winner.query('commit'));

          if (forceLoserFirst) {
            await settleUnobserved(loserOutcome, 'the losing append');
          } else {
            await winnerOutcome;
          }

          // Which side lost, and what refused it — not merely "something raised 23505".
          expect(await loserOutcome).toMatchObject({
            kind: 'rejected',
            code: UNIQUE_VIOLATION,
            where: expect.stringContaining('events_enforce_stream_seq'),
          });
          expect(await winnerOutcome).toEqual({ kind: 'fulfilled' });
          await loser.query('rollback');
        });
      });

      await assertOnlyTheWinnerLanded(database.connectionString, stream);
    },
  );

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
