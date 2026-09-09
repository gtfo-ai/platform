/**
 * The acceptance criterion, end to end on PostgreSQL: several outbox workers racing over one log
 * must produce each effect once and, per stream, in order.
 *
 * The property tests establish this over thousands of generated schedules against the model; this
 * establishes it once against the real locks, with the effects being rows the database counted.
 */
import { EventBus, OutboxWorker, streamId, taskQueued } from '@platform/application';
import type { Id } from '@platform/contracts';
import { eventing } from '@platform/infrastructure';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';

const STREAMS = 4;
const EVENTS_PER_STREAM = 5;

describe('outbox worker (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;

  beforeAll(async () => {
    database = await createMigratedDatabase('outbox');
    pool = new pg.Pool({
      connectionString: database.connectionString,
      options: '-c role=platform_app',
      // Three workers dispatching at once need 2*3 connections plus their sweeps' reads.
      max: 12,
      connectionTimeoutMillis: 5_000,
    });
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  it('three workers over one log: every effect once, every stream in order', async () => {
    const unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    const store = new eventing.PostgresEventStore(pool);

    for (let stream = 1; stream <= STREAMS; stream += 1) {
      for (let seq = 1; seq <= EVENTS_PER_STREAM; seq += 1) {
        await unitOfWork.transaction(async (scope) =>
          scope.events.append([
            taskQueued({ streamType: 'task', streamId: streamId(stream) as Id, streamSeq: seq }),
          ]),
        );
      }
    }

    const workers = Array.from({ length: 3 }, () => {
      const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
      bus.register({
        name: 'core.ledger',
        priority: 10,
        eventTypes: ['task.queued'],
        handle: async (context) => {
          const { client } = eventing.postgresTransaction(context.scope.tx);
          // The effect is a row, written on the handler's transaction, so a rolled-back handler
          // leaves nothing behind and a double-run would be visible as a second row.
          await client.query('insert into human_actions (action) values ($1)', [
            `${context.event.event.stream_id}:${context.event.event.stream_seq}`,
          ]);
        },
      });
      return new OutboxWorker({ bus, store, batchSize: 4, pollIntervalMs: 5 });
    });

    await Promise.all(workers.map(async (worker) => worker.start()));
    await expect.poll(async () => store.countPendingDispatch(), { timeout: 60_000 }).toBe(0);
    await Promise.all(workers.map(async (worker) => worker.stop()));

    const { rows } = await pool.query<{ action: string; created_at: Date; id: string }>(
      'select action, created_at, id from human_actions order by created_at, id',
    );
    expect(rows).toHaveLength(STREAMS * EVENTS_PER_STREAM);

    // Exactly once.
    expect(new Set(rows.map((row) => row.action)).size).toBe(rows.length);

    // In order, per stream.
    const highest = new Map<string, number>();
    for (const row of rows) {
      const [stream, seq] = row.action.split(':');
      const previous = highest.get(String(stream)) ?? 0;
      expect(Number(seq)).toBe(previous + 1);
      highest.set(String(stream), Number(seq));
    }

    // And every event carries the marker that says its dispatch finished.
    const markers = await pool.query<{ count: string }>(
      "select count(*) as count from handler_executions where handler = '$dispatch' and status = 'succeeded'",
    );
    expect(Number(markers.rows[0]?.count)).toBe(STREAMS * EVENTS_PER_STREAM);
  }, 120_000);

  it('refuses a pool too small for the configured concurrency, at start-up', () => {
    // The failure this prevents is not slowness: a dispatch waits for a connection its own
    // transaction is holding, so an undersized pool deadlocks rather than degrades.
    expect(() =>
      eventing.createEventing({
        pool,
        connectionString: database.connectionString,
        config: { maxConcurrency: 8 },
      }),
    ).toThrow(eventing.InsufficientPoolError);

    expect(() =>
      eventing.createEventing({
        pool,
        connectionString: database.connectionString,
        config: { maxConcurrency: 8 },
      }),
    ).toThrow(/APP_DB_POOL_MAX is 12.*needs at least 17/s);
  });

  it('a pool too small to hold a dispatch fails promptly instead of hanging', async () => {
    // The guard above cannot catch a pool the caller built by hand, so the driver has to fail on
    // its own: one connection, a short wait, and a dispatch that needs two.
    const starved = new pg.Pool({
      connectionString: database.connectionString,
      options: '-c role=platform_app',
      max: 1,
      connectionTimeoutMillis: 500,
    });
    try {
      const unitOfWork = new eventing.PostgresUnitOfWork({ pool: starved });
      const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
      bus.register({
        name: 'core.needs.a.connection',
        priority: 10,
        eventTypes: ['task.queued'],
        handle: async () => {},
      });

      const [event] = await new eventing.PostgresUnitOfWork({ pool }).transaction(async (scope) =>
        scope.events.append([
          taskQueued({ streamType: 'task', streamId: streamId(91) as Id, streamSeq: 1 }),
        ]),
      );
      if (event === undefined) {
        throw new Error('append returned nothing');
      }

      const started = Date.now();
      const result = await bus.dispatch(event);
      const elapsed = Date.now() - started;

      // It fails, quickly, and — the part that matters — the event is still queued, so the sweep
      // retries it once the operator has fixed the pool. Nothing is lost by failing here.
      expect(result.status).toBe('failed');
      expect(result.handlers[0]).toMatchObject({ result: 'failed' });
      expect(result.handlers[0]?.error).toMatch(/timeout/i);
      expect(elapsed).toBeLessThan(10_000);

      const queued = await pool.query<{ count: string }>(
        'select count(*) as count from event_dispatch where event_position = $1',
        [event.position],
      );
      expect(Number(queued.rows[0]?.count)).toBe(1);
    } finally {
      await starved.end();
    }
  }, 60_000);

  it('createEventing wires a working stack and stops it cleanly', async () => {
    const stack = eventing.createEventing({
      pool,
      connectionString: database.connectionString,
      config: { pollIntervalMs: 20, batchSize: 4 },
    });
    const seen: number[] = [];
    stack.bus.register({
      name: 'core.wired',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        seen.push(context.event.position);
      },
    });
    await stack.worker.start();

    const [appended] = await stack.unitOfWork.transaction(async (scope) =>
      scope.events.append([
        taskQueued({ streamType: 'task', streamId: streamId(90) as Id, streamSeq: 1 }),
      ]),
    );

    await expect
      .poll(() => seen.includes(appended?.position ?? -1), { timeout: 20_000 })
      .toBe(true);
    await stack.stop();
    expect(stack.worker.running).toBe(false);
    expect(stack.broadcast.listening).toBe(false);
  }, 60_000);
});
