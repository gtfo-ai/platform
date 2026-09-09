/**
 * The event store against a real PostgreSQL 18 (TD-005).
 *
 * Everything the property tests assume about the database is proved here rather than modelled:
 * the sequence guard, the trigger that queues a dispatch in the appending transaction, the
 * partition window, and the fact that the *least-privileged application role* can do all of it —
 * WP-03 found two privilege escalations, so "it works as the owner" is not evidence.
 */
import {
  type EventStore,
  PartitionWindowError,
  StreamConflictError,
  streamId,
  taskQueued,
} from '@platform/application';
import type { DomainEvent } from '@platform/contracts';
import { eventing } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

const APP_ROLE = 'platform_app';

describe('event store (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;
  let unitOfWork: eventing.PostgresUnitOfWork;
  let store: EventStore & { read: (position: number) => Promise<unknown> };

  beforeAll(async () => {
    database = await createMigratedDatabase('eventstore');
    // Every connection starts as the least-privilege role, exactly like the runtime pool.
    pool = new pg.Pool({
      connectionString: database.connectionString,
      options: `-c role=${APP_ROLE}`,
      // Appends only, no dispatch, so one connection each; three race in one test.
      max: 6,
      connectionTimeoutMillis: 5_000,
    });
    unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    store = new eventing.PostgresEventStore(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const stream = (n: number) => ({ streamType: 'task', streamId: streamId(n) }) as const;

  it('appends as the application role and reads the envelope back unchanged', async () => {
    const event = taskQueued({ ...stream(101), streamSeq: 1 });
    const [appended] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([event], { causeEventPosition: null }),
    );

    expect(appended?.position).toBeGreaterThan(0);
    const read = await store.readStream('task', event.stream_id);
    expect(read).toHaveLength(1);
    expect(read[0]?.event).toEqual(event);
    expect(read[0]?.position).toBe(appended?.position);
  });

  it('assigns sequences per stream and reports the next one', async () => {
    const a = stream(102);
    await unitOfWork.transaction(async (scope) =>
      scope.events.append([taskQueued({ ...a, streamSeq: 1 })]),
    );
    expect(await store.nextStreamSequence('task', a.streamId)).toBe(2);
    await unitOfWork.transaction(async (scope) =>
      scope.events.append([taskQueued({ ...a, streamSeq: 2 })]),
    );
    expect(await store.nextStreamSequence('task', a.streamId)).toBe(3);
    // An untouched stream starts at 1.
    expect(await store.nextStreamSequence('task', streamId(999))).toBe(1);
  });

  it('turns the sequence guard into a StreamConflictError and rolls the counter back', async () => {
    const s = stream(103);
    await unitOfWork.transaction(async (scope) =>
      scope.events.append([taskQueued({ ...s, streamSeq: 1 })]),
    );

    await expect(
      unitOfWork.transaction(async (scope) =>
        scope.events.append([taskQueued({ ...s, streamSeq: 1 })]),
      ),
    ).rejects.toBeInstanceOf(StreamConflictError);
    await expect(
      unitOfWork.transaction(async (scope) =>
        scope.events.append([taskQueued({ ...s, streamSeq: 7 })]),
      ),
    ).rejects.toBeInstanceOf(StreamConflictError);

    // The failed attempts took the counter down with them, so the stream is still appendable.
    expect(await store.nextStreamSequence('task', s.streamId)).toBe(2);
    await unitOfWork.transaction(async (scope) =>
      scope.events.append([taskQueued({ ...s, streamSeq: 2 })]),
    );
  });

  it('serialises concurrent appends to one stream without the caller locking anything', async () => {
    const s = stream(104);
    const attempt = async () =>
      unitOfWork
        .transaction(async (scope) => scope.events.append([taskQueued({ ...s, streamSeq: 1 })]))
        .then(() => 'won' as const)
        .catch((error: unknown) => (error instanceof StreamConflictError ? 'lost' : 'other'));

    const results = await Promise.all([attempt(), attempt(), attempt()]);
    expect(results.filter((outcome) => outcome === 'won')).toHaveLength(1);
    expect(results.filter((outcome) => outcome === 'other')).toHaveLength(0);
    expect(await store.readStream('task', s.streamId)).toHaveLength(1);
  });

  it('rolls an append back with its transaction, queue row included', async () => {
    const s = stream(105);
    await expect(
      unitOfWork.transaction(async (scope) => {
        await scope.events.append([taskQueued({ ...s, streamSeq: 1 })]);
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect(await store.readStream('task', s.streamId)).toEqual([]);
    expect(await store.nextStreamSequence('task', s.streamId)).toBe(1);
  });

  it('queues every appended event for dispatch, in the appending transaction', async () => {
    const s = stream(106);
    const before = await store.countPendingDispatch();
    await unitOfWork.transaction(async (scope) =>
      scope.events.append([taskQueued({ ...s, streamSeq: 1 }), taskQueued({ ...s, streamSeq: 2 })]),
    );
    expect(await store.countPendingDispatch()).toBe(before + 2);

    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ stream_seq: number; attempts: number }>(
        'select stream_seq, attempts from event_dispatch where stream_id = $1 order by stream_seq',
        [s.streamId],
      );
      expect(rows).toEqual([
        { stream_seq: 1, attempts: 0 },
        { stream_seq: 2, attempts: 0 },
      ]);
    } finally {
      client.release();
    }
  });

  it('returns only the head of a stream from the pending sweep', async () => {
    const s = stream(107);
    await unitOfWork.transaction(async (scope) =>
      scope.events.append([taskQueued({ ...s, streamSeq: 1 }), taskQueued({ ...s, streamSeq: 2 })]),
    );
    const pending = await store.readPendingDispatch({ limit: 50 });
    const mine = pending.filter((event) => event.event.stream_id === s.streamId);
    expect(mine.map((event) => event.event.stream_seq)).toEqual([1]);
  });

  it('refuses a back-dated event rather than letting the partition guard mis-file it', async () => {
    const s = stream(108);
    const backDated = {
      ...taskQueued({ ...s, streamSeq: 1 }),
      occurred_at: '2020-01-05T10:00:00.000Z',
    } as DomainEvent;
    await expect(
      unitOfWork.transaction(async (scope) => scope.events.append([backDated])),
    ).rejects.toBeInstanceOf(PartitionWindowError);
  });

  it('keeps the application role away from event_streams and from rewriting the log', async () => {
    const client = await pool.connect();
    try {
      const { rows } = await client.query<{ current_user: string }>('select current_user');
      expect(rows[0]?.current_user).toBe(APP_ROLE);

      // 42501: row locks on event_streams need UPDATE, which the role does not have.
      await expect(client.query('select 1 from event_streams for update')).rejects.toMatchObject({
        code: '42501',
      });
      await expect(client.query('update events set type = $1', ['x'])).rejects.toMatchObject({
        code: '42501',
      });
      await expect(client.query('delete from events')).rejects.toMatchObject({ code: '42501' });
    } finally {
      client.release();
    }
  });
});
