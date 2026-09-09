/**
 * The `Broadcast` adapter on real `LISTEN`/`NOTIFY` (TD-014, TD-005).
 *
 * Two claims are load-bearing and neither can be checked without a server: a notification sent
 * inside a transaction is delivered only if that transaction commits, and identical notifications
 * from one transaction arrive **once** — which is what lets the event store publish a wake-up hint
 * per appended event and still honour TD-005's "once per committing transaction".
 */
import {
  EVENTS_APPENDED_TOPIC,
  EventBus,
  OutboxWorker,
  streamId,
  taskQueued,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { broadcast as broadcastAdapter, eventing } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

describe('broadcast (PostgreSQL LISTEN/NOTIFY)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;
  let broadcast: broadcastAdapter.PostgresBroadcast;

  beforeAll(async () => {
    database = await createMigratedDatabase('broadcast');
    pool = new pg.Pool({
      connectionString: database.connectionString,
      options: '-c role=platform_app',
      max: 4,
    });
    broadcast = new broadcastAdapter.PostgresBroadcast({
      connectionString: database.connectionString,
      publisher: pool,
    });
  }, 180_000);

  afterAll(async () => {
    await broadcast?.close();
    await pool?.end();
    await database?.drop();
  });

  it('delivers a published message to the subscribers of its topic only', async () => {
    const wanted: unknown[] = [];
    const other: unknown[] = [];
    const a = await broadcast.subscribe(['task:abc'], (message) => wanted.push(message.payload));
    const b = await broadcast.subscribe(['run:xyz'], (message) => other.push(message.payload));

    await broadcast.publish({ topic: 'task:abc', payload: { seq: 7 } });

    await expect.poll(() => wanted.length, { timeout: 5_000 }).toBe(1);
    expect(wanted[0]).toEqual({ seq: 7 });
    expect(other).toEqual([]);
    await a.close();
    await b.close();
  });

  it('delivers a transactional publish only after the transaction commits', async () => {
    const seen: unknown[] = [];
    const subscription = await broadcast.subscribe(['org'], (message) => seen.push(message.topic));
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });

    await expect(
      unitOfWork.transaction(async (scope) => {
        await scope.broadcast.publish({ topic: 'org', payload: {} });
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    // Nothing to wait for, so publish a committed one behind it and prove ordering: if the rolled
    // back notification were coming, it would arrive before this one.
    await unitOfWork.transaction(async (scope) => {
      await scope.broadcast.publish({ topic: 'org', payload: { keep: true } });
    });
    await expect.poll(() => seen.length, { timeout: 5_000 }).toBe(1);
    await subscription.close();
  });

  it('collapses identical notifications from one transaction into a single delivery', async () => {
    const hints: unknown[] = [];
    const subscription = await broadcast.subscribe([EVENTS_APPENDED_TOPIC], () => {
      hints.push(1);
    });
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });

    await unitOfWork.transaction(async (scope) => {
      const stream = { streamType: 'task', streamId: streamId(301) as Id } as const;
      await scope.events.append([taskQueued({ ...stream, streamSeq: 1 })]);
      await scope.events.append([taskQueued({ ...stream, streamSeq: 2 })]);
      return scope.events.append([taskQueued({ ...stream, streamSeq: 3 })]);
    });

    await expect.poll(() => hints.length, { timeout: 5_000 }).toBe(1);
    // Give a second delivery every chance to show up before declaring it collapsed.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(hints).toHaveLength(1);
    await subscription.close();
  });

  it('wakes the outbox worker without waiting for its poll interval', async () => {
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const store = new eventing.PostgresEventStore(pool);
    const bus = new EventBus({ unitOfWork });
    const seen: number[] = [];
    bus.register({
      name: 'core.woken',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        seen.push(context.event.position);
      },
    });

    const worker = new OutboxWorker({
      bus,
      store,
      broadcast,
      // Far longer than the test: only the NOTIFY can be what wakes it.
      pollIntervalMs: 120_000,
    });
    await worker.start();

    const [appended] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([
        taskQueued({ streamType: 'task', streamId: streamId(302) as Id, streamSeq: 1 }),
      ]),
    );

    // Earlier tests in this file left events of their own in the log, so the assertion is about
    // this one arriving, not about the queue being empty.
    await expect
      .poll(() => seen.includes(appended?.position ?? -1), { timeout: 10_000 })
      .toBe(true);
    await worker.stop();
  });
});
