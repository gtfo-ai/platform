/**
 * The adapter's logic, against a recording executor.
 *
 * What is checked here is what SQL is issued and how a row comes back — the part a container test
 * would prove only indirectly and slowly. That the SQL means what it is meant to mean (locks,
 * ordering, the sequence guard) is proved against a real PostgreSQL 18 in
 * `test/integration/events/`.
 */
import {
  CorruptEventError,
  PartitionWindowError,
  StreamConflictError,
  streamId,
  taskQueued,
} from '@platform/application';
import type { DomainEvent } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  PostgresDispatchQueue,
  PostgresEventAppender,
  PostgresEventStore,
  PostgresHandlerExecutions,
} from './postgres-event-store.js';
import type { SqlExecutor } from './sql.js';

interface Call {
  readonly text: string;
  readonly values: unknown[];
}

/** Replies with scripted result sets and records every statement. */
const executor = (
  replies: { rows?: unknown[]; rowCount?: number }[] = [],
): SqlExecutor & { calls: Call[] } => {
  const calls: Call[] = [];
  let index = 0;
  return {
    calls,
    query: async <R extends Record<string, unknown>>(text: string, values: unknown[] = []) => {
      calls.push({ text, values });
      const reply = replies[index] ?? {};
      index += 1;
      const rows = (reply.rows ?? []) as R[];
      return { rows, rowCount: reply.rowCount ?? rows.length };
    },
  };
};

const stream = { streamType: 'task', streamId: streamId(1), streamSeq: 1 } as const;
const event = taskQueued(stream);

const eventRow = (overrides: Record<string, unknown> = {}) => ({
  position: '7',
  id: event.id,
  stream_type: event.stream_type,
  stream_id: event.stream_id,
  stream_seq: event.stream_seq,
  type: event.type,
  payload: event.payload,
  actor: event.actor,
  cause_event_id: null,
  cause_event_position: null,
  correlation_id: null,
  occurred_at: new Date(event.occurred_at),
  ...overrides,
});

const noBroadcast = { publish: async () => {} };

describe('PostgresEventStore', () => {
  it('reads a stream without a LIMIT clause when no limit was asked for', async () => {
    const sql = executor([{ rows: [eventRow()] }]);
    const events = await new PostgresEventStore(sql).readStream('task', stream.streamId);

    expect(events[0]?.position).toBe(7);
    expect(sql.calls[0]?.text).toMatch(/limit all/);
    expect(sql.calls[0]?.values).toEqual(['task', stream.streamId, 1]);
  });

  it('passes fromSeq and limit through as parameters', async () => {
    const sql = executor([{ rows: [] }]);
    await new PostgresEventStore(sql).readStream('task', stream.streamId, {
      fromSeq: 4,
      limit: 10,
    });
    expect(sql.calls[0]?.text).toMatch(/limit \$4/);
    expect(sql.calls[0]?.values).toEqual(['task', stream.streamId, 4, 10]);
  });

  it('derives the next sequence from event_streams, never locking it', async () => {
    const sql = executor([{ rows: [{ next: '3' }] }]);
    expect(await new PostgresEventStore(sql).nextStreamSequence('task', stream.streamId)).toBe(3);
    expect(sql.calls[0]?.text).toContain('event_streams');
    expect(sql.calls[0]?.text).not.toMatch(/for (update|share|no key update)/i);
  });

  it('returns null for a position that is not in the log', async () => {
    const sql = executor([{ rows: [] }]);
    expect(await new PostgresEventStore(sql).readAt(99)).toBeNull();
  });

  it('takes only the head of each stream, and only when it is due', async () => {
    const sql = executor([{ rows: [eventRow()] }]);
    await new PostgresEventStore(sql).readPendingDispatch({ limit: 5 });
    const text = sql.calls[0]?.text ?? '';
    expect(text).toMatch(/row_number\(\) over \(\s*partition by d\.stream_type, d\.stream_id/);
    expect(text).toMatch(/h\.rn = 1 and h\.available_at <= now\(\)/);
    // The join carries occurred_at, so the partitioned table can be pruned.
    expect(text).toContain('e.occurred_at = h.occurred_at');
    expect(sql.calls[0]?.values).toEqual([5]);
  });

  it('rejects a row whose type is not in the catalogue', async () => {
    const sql = executor([{ rows: [eventRow({ type: 'task.invented' })] }]);
    await expect(new PostgresEventStore(sql).readAt(7)).rejects.toBeInstanceOf(CorruptEventError);
  });

  it('rejects a row whose payload no longer matches its schema', async () => {
    const sql = executor([{ rows: [eventRow({ payload: { nonsense: true } })] }]);
    await expect(new PostgresEventStore(sql).readAt(7)).rejects.toThrow(/position 7/);
  });

  it('maps bigint columns, which pg returns as strings', async () => {
    const sql = executor([{ rows: [eventRow({ cause_event_position: '3' })] }]);
    const stored = await new PostgresEventStore(sql).readAt(7);
    expect(stored?.position).toBe(7);
    expect(stored?.causeEventPosition).toBe(3);
    expect(
      await new PostgresEventStore(
        executor([{ rows: [{ pending: '12' }] }]),
      ).countPendingDispatch(),
    ).toBe(12);
  });

  it('reads handler executions in dispatch order', async () => {
    const sql = executor([
      {
        rows: [
          {
            event_position: '7',
            handler: 'core.a',
            priority: 10,
            status: 'succeeded',
            attempts: 1,
            error: null,
          },
        ],
      },
    ]);
    const rows = await new PostgresEventStore(sql).read(7);
    expect(rows).toEqual([
      {
        eventPosition: 7,
        handler: 'core.a',
        priority: 10,
        status: 'succeeded',
        attempts: 1,
        error: null,
      },
    ]);
    expect(sql.calls[0]?.text).toMatch(/order by priority, handler/);
  });
});

describe('PostgresEventAppender', () => {
  it('writes the envelope, the cause link and one wake-up hint per call', async () => {
    const sql = executor([{ rows: [{ position: '7' }] }, { rows: [{ position: '8' }] }]);
    const published: string[] = [];
    const appender = new PostgresEventAppender(sql, {
      publish: async (message) => {
        published.push(message.topic);
      },
    });

    const appended = await appender.append([event, taskQueued({ ...stream, streamSeq: 2 })], {
      causeEventPosition: 3,
    });

    expect(appended.map((entry) => entry.position)).toEqual([7, 8]);
    expect(sql.calls[0]?.values[0]).toBe(event.id);
    expect(sql.calls[0]?.values[8]).toBe(3);
    expect(published).toEqual(['events.appended']);
  });

  it('does nothing at all for an empty batch', async () => {
    const sql = executor();
    expect(await new PostgresEventAppender(sql, noBroadcast).append([])).toEqual([]);
    expect(sql.calls).toEqual([]);
  });

  it('refuses a back-dated event before the database can mis-file it', async () => {
    const sql = executor();
    const old = { ...event, occurred_at: '2020-01-05T10:00:00.000Z' } as DomainEvent;
    await expect(new PostgresEventAppender(sql, noBroadcast).append([old])).rejects.toBeInstanceOf(
      PartitionWindowError,
    );
    expect(sql.calls).toEqual([]);
  });

  it('turns the sequence guard 23505 into a StreamConflictError', async () => {
    const failing: SqlExecutor = {
      query: async () => {
        throw Object.assign(new Error('stream task/x is at sequence 2, cannot append 1'), {
          code: '23505',
        });
      },
    };
    await expect(
      new PostgresEventAppender(failing, noBroadcast).append([event]),
    ).rejects.toBeInstanceOf(StreamConflictError);
  });

  it('turns a missing partition 23514 into a PartitionWindowError', async () => {
    const failing: SqlExecutor = {
      query: async () => {
        throw Object.assign(new Error('no partition of relation "events" found for row'), {
          code: '23514',
        });
      },
    };
    await expect(
      new PostgresEventAppender(failing, noBroadcast).append([event]),
    ).rejects.toBeInstanceOf(PartitionWindowError);
  });

  it('rethrows an unrelated unique violation untouched', async () => {
    const failing: SqlExecutor = {
      query: async () => {
        throw Object.assign(new Error('duplicate key value violates "events_id_idx"'), {
          code: '23505',
        });
      },
    };
    await expect(new PostgresEventAppender(failing, noBroadcast).append([event])).rejects.toThrow(
      /duplicate key/,
    );
  });

  it('rethrows a non-database error untouched', async () => {
    const failing: SqlExecutor = {
      query: async () => {
        throw new Error('connection terminated');
      },
    };
    await expect(new PostgresEventAppender(failing, noBroadcast).append([event])).rejects.toThrow(
      /connection terminated/,
    );
  });
});

describe('PostgresDispatchQueue', () => {
  it('claims with SKIP LOCKED and reports a locked row as busy', async () => {
    const sql = executor([{ rowCount: 0 }, { rowCount: 1 }]);
    expect(await new PostgresDispatchQueue(sql).claim(7)).toBe('busy');
    expect(sql.calls[0]?.text).toMatch(/for update skip locked/);
  });

  it('reports a missing row as completed', async () => {
    const sql = executor([{ rowCount: 0 }, { rowCount: 0 }]);
    expect(await new PostgresDispatchQueue(sql).claim(7)).toBe('completed');
  });

  it('does not look twice when it got the lock', async () => {
    const sql = executor([{ rowCount: 1 }]);
    expect(await new PostgresDispatchQueue(sql).claim(7)).toBe('claimed');
    expect(sql.calls).toHaveLength(1);
  });

  it('completes by deleting the queue row', async () => {
    const sql = executor([{}]);
    await new PostgresDispatchQueue(sql).complete(7);
    expect(sql.calls[0]?.text).toMatch(/delete from event_dispatch/);
  });

  it('backs a retry off from the row it is updating, not from the caller', async () => {
    const sql = executor([{}]);
    await new PostgresDispatchQueue(sql).retryLater(7, 'boom', { baseMs: 500, maxMs: 60_000 });
    expect(sql.calls[0]?.text).toMatch(/attempts = attempts \+ 1/);
    expect(sql.calls[0]?.text).toMatch(/power\(2, least\(attempts, 10\)\)/);
    expect(sql.calls[0]?.values).toEqual([7, 'boom', 500, 60_000]);
  });

  it('asks whether an earlier event of the stream is still queued', async () => {
    const sql = executor([{ rows: [{ blocked: true }] }]);
    expect(await new PostgresDispatchQueue(sql).hasEarlierPending('task', stream.streamId, 4)).toBe(
      true,
    );
    expect(sql.calls[0]?.text).toMatch(/stream_seq < \$3/);
  });
});

describe('PostgresHandlerExecutions', () => {
  const ref = { handler: 'core.a', priority: 10 };

  it('claims with an upsert that terminal rows fall out of', async () => {
    const sql = executor([{ rowCount: 1 }]);
    expect(await new PostgresHandlerExecutions(sql).claim(7, ref)).toBe(true);
    const text = sql.calls[0]?.text ?? '';
    expect(text).toMatch(/on conflict \(event_position, handler\) do update/);
    expect(text).toMatch(/where handler_executions\.status not in \('succeeded', 'stopped'\)/);
  });

  it('reports a terminal row as already run', async () => {
    const sql = executor([{ rowCount: 0 }]);
    expect(await new PostgresHandlerExecutions(sql).claim(7, ref)).toBe(false);
  });

  it('completes with an insert, so the $dispatch marker needs no claim', async () => {
    const sql = executor([{}]);
    await new PostgresHandlerExecutions(sql).complete(7, { handler: '$dispatch', priority: 1000 });
    expect(sql.calls[0]?.text).toMatch(/insert into handler_executions/);
    expect(sql.calls[0]?.values).toEqual([7, '$dispatch', 1000]);
  });

  it('never lets a failure overwrite a terminal row', async () => {
    const sql = executor([{}]);
    await new PostgresHandlerExecutions(sql).recordFailure(7, ref, 'boom');
    expect(sql.calls[0]?.text).toMatch(
      /where handler_executions\.status not in \('succeeded', 'stopped'\)/,
    );
  });

  it('marks the remaining handlers stopped in one statement, and makes them terminal', async () => {
    const sql = executor([{}]);
    await new PostgresHandlerExecutions(sql).markStopped(
      7,
      [
        { handler: 'a', priority: 1 },
        { handler: 'b', priority: 2 },
      ],
      'policy',
    );
    expect(sql.calls[0]?.text).toMatch(/unnest\(\$3::text\[\], \$4::int\[\]\)/);
    // do update, not do nothing: a row left `failed` by an earlier attempt must become terminal.
    expect(sql.calls[0]?.text).toMatch(/do update\s+set status = 'stopped'/);
    expect(sql.calls[0]?.values).toEqual([7, 'policy', ['a', 'b'], [1, 2]]);
  });

  it('issues nothing when there is nothing left to stop', async () => {
    const sql = executor();
    await new PostgresHandlerExecutions(sql).markStopped(7, [], 'policy');
    expect(sql.calls).toEqual([]);
  });
});
