/**
 * The dispatcher against a real PostgreSQL 18.
 *
 * The property tests prove the dispatcher's logic against a model; this proves the model was right
 * about the database — that `FOR UPDATE SKIP LOCKED` really gives one worker the event, that
 * `ON CONFLICT DO UPDATE … WHERE` really locks and then rejects a second claimant, and that a
 * handler's effect and its execution record really commit or roll back together.
 *
 * The handler effect used throughout is a row in a real table (`human_actions`), so "exactly-once
 * effect" is a fact about the database rather than about a counter in the test process.
 */

import {
  DEFAULT_MAX_DISPATCH_ATTEMPTS,
  EventBus,
  OutboxWorker,
  streamId,
  taskDequeued,
  taskQueued,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { eventing } from '@platform/infrastructure';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMetrics } from '../../../apps/server/src/metrics.js';
import { createMigratedDatabase, type MigratedDatabase } from '../support/migrated.js';
import { createTestPool } from '../support/postgres.js';

const APP_ROLE = 'platform_app';

describe('priority dispatcher (PostgreSQL)', () => {
  let database: MigratedDatabase;
  let pool: pg.Pool;
  let unitOfWork: eventing.PostgresUnitOfWork;
  let store: eventing.PostgresEventStore;

  beforeAll(async () => {
    database = await createMigratedDatabase('dispatcher');
    pool = createTestPool(database.connectionString, {
      options: `-c role=${APP_ROLE}`,
      // The invariant, named rather than tuned around: a dispatch holds two connections at once,
      // this file runs up to four at a time, and the assertions read with a fifth — so 2*4+1.
      // `connectionTimeoutMillis` means getting it wrong is an error rather than a hang.
      max: 12,
      connectionTimeoutMillis: 5_000,
    });
    unitOfWork = new eventing.PostgresUnitOfWork({ pool });
    store = new eventing.PostgresEventStore(pool);
  }, 180_000);

  afterAll(async () => {
    await pool?.end();
    await database?.drop();
  });

  const bus = (options: { retryDelayMs?: number } = {}) =>
    new EventBus({
      unitOfWork,
      retryDelayMs: options.retryDelayMs ?? 0,
      maxRetryDelayMs: options.retryDelayMs ?? 0,
    });

  /** A handler whose effect is a row, written on the transaction it was handed. */
  const writesRow = (name: string, priority: number, action: string) => ({
    name,
    priority,
    eventTypes: ['task.queued'] as const,
    handle: async (context: {
      scope: { tx: { adapter: string } };
      event: { position: number };
    }) => {
      const { client } = eventing.postgresTransaction(context.scope.tx);
      // `human_actions` is append-only and its task_id is nullable, so this is a real row in a
      // real audited table rather than a counter in the test process.
      await client.query('insert into human_actions (action) values ($1)', [
        `${action}:${context.event.position}`,
      ]);
    },
  });

  const effectsFor = async (action: string): Promise<number> => {
    const { rows } = await pool.query<{ count: string }>(
      'select count(*) as count from human_actions where action = $1',
      [action],
    );
    return Number(rows[0]?.count ?? 0);
  };

  const appendOne = async (stream: number, seq: number) => {
    const [stored] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([
        taskQueued({ streamType: 'task', streamId: streamId(stream) as Id, streamSeq: seq }),
      ]),
    );
    if (stored === undefined) {
      throw new Error('append returned nothing');
    }
    return stored;
  };

  it('runs handlers in priority order and records each execution', async () => {
    const dispatcher = bus();
    dispatcher.register(writesRow('core.first', 10, 'first'));
    dispatcher.register(writesRow('ui.last', 220, 'last'));

    const event = await appendOne(201, 1);
    const result = await dispatcher.dispatch(event);
    expect(result.status).toBe('dispatched');

    const executions = await store.read(event.position);
    expect(executions.map((row) => `${row.handler}:${row.status}`)).toEqual([
      'core.first:succeeded',
      'ui.last:succeeded',
      '$dispatch:succeeded',
    ]);
    expect(await effectsFor(`first:${event.position}`)).toBe(1);
    expect(await store.countPendingDispatch()).toBe(0);
  });

  it('gives one event to one worker: concurrent dispatchers produce one effect', async () => {
    const workers = Array.from({ length: 4 }, () => {
      const dispatcher = bus();
      dispatcher.register(writesRow('core.once', 10, 'once'));
      return dispatcher;
    });

    const event = await appendOne(202, 1);
    const results = await Promise.all(workers.map(async (worker) => worker.dispatch(event)));

    expect(await effectsFor(`once:${event.position}`)).toBe(1);
    expect(results.filter((result) => result.status === 'dispatched')).toHaveLength(1);
    // The others were locked out or found the work already done — never a second run.
    for (const result of results) {
      expect(['dispatched', 'busy', 'completed']).toContain(result.status);
    }
  });

  it('rolls the effect back with the execution record when a later handler fails', async () => {
    const dispatcher = bus();
    dispatcher.register(writesRow('core.effect', 10, 'rollback'));
    dispatcher.register({
      name: 'core.explodes',
      priority: 20,
      eventTypes: ['task.queued'],
      handle: async () => {
        throw new Error('handler blew up');
      },
    });

    const event = await appendOne(203, 1);
    expect((await dispatcher.dispatch(event)).status).toBe('failed');

    // The first handler's effect survives — it committed on its own transaction — and its record
    // says so, which is what makes the retry re-run only the handler that failed.
    expect(await effectsFor(`rollback:${event.position}`)).toBe(1);
    const executions = await store.read(event.position);
    expect(executions.find((row) => row.handler === 'core.effect')?.status).toBe('succeeded');
    expect(executions.find((row) => row.handler === 'core.explodes')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect(await store.countPendingDispatch()).toBe(1);

    // A retry runs the failed handler only; the effect is not duplicated.
    const retryBus = bus();
    retryBus.register(writesRow('core.effect', 10, 'rollback'));
    retryBus.register({
      name: 'core.explodes',
      priority: 20,
      eventTypes: ['task.queued'],
      handle: async () => {},
    });
    expect((await retryBus.dispatch(event)).status).toBe('dispatched');
    expect(await effectsFor(`rollback:${event.position}`)).toBe(1);
    expect(await store.countPendingDispatch()).toBe(0);
  });

  it('undoes a handler that throws after writing: no effect, no execution record', async () => {
    const dispatcher = bus();
    dispatcher.register({
      name: 'core.halfway',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        const { client } = eventing.postgresTransaction(context.scope.tx);
        await client.query('insert into human_actions (action) values ($1)', [
          `halfway:${context.event.position}`,
        ]);
        throw new Error('died between the effect and the bookkeeping');
      },
    });

    const event = await appendOne(204, 1);
    expect((await dispatcher.dispatch(event)).status).toBe('failed');
    expect(await effectsFor(`halfway:${event.position}`)).toBe(0);
    const executions = await store.read(event.position);
    expect(executions.find((row) => row.handler === 'core.halfway')?.status).toBe('failed');
  });

  it('holds ordering per stream even when a later event is offered first', async () => {
    const dispatcher = bus();
    const seen: number[] = [];
    dispatcher.register({
      name: 'core.order',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        seen.push(context.event.event.stream_seq);
      },
    });

    const first = await appendOne(205, 1);
    const second = await appendOne(205, 2);

    expect((await dispatcher.dispatch(second)).status).toBe('blocked');
    expect(seen).toEqual([]);
    expect((await dispatcher.dispatch(first)).status).toBe('dispatched');
    expect((await dispatcher.dispatch(second)).status).toBe('dispatched');
    expect(seen).toEqual([1, 2]);
  });

  it('keeps a stop() decision after the policy handler is skipped as already run', async () => {
    const dispatcher = bus();
    dispatcher.register({
      name: 'policy.shadow',
      priority: 0,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        context.stop('shadow task: no outward action');
      },
    });
    dispatcher.register(writesRow('jira.workpad', 110, 'silenced'));

    const event = await appendOne(206, 1);
    await dispatcher.dispatch(event);
    expect(await effectsFor(`silenced:${event.position}`)).toBe(0);
    expect(
      (await store.read(event.position)).find((row) => row.handler === 'jira.workpad')?.status,
    ).toBe('stopped');

    // Force a redelivery: the queue row is gone, so put it back the way a crash would have.
    await pool.query(
      `insert into event_dispatch (event_position, occurred_at, stream_type, stream_id, stream_seq)
       select position, occurred_at, stream_type, stream_id, stream_seq from events where position = $1`,
      [event.position],
    );
    expect((await dispatcher.dispatch(event)).status).toBe('dispatched');
    expect(await effectsFor(`silenced:${event.position}`)).toBe(0);
  });

  it('dispatches what a handler emitted, linked to its cause', async () => {
    const dispatcher = bus();
    const chained: (number | null)[] = [];
    dispatcher.register({
      name: 'core.emitter',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        if (context.event.event.stream_seq !== 1) {
          return;
        }
        await context.emit([
          taskQueued({ streamType: 'task', streamId: streamId(207) as Id, streamSeq: 2 }),
        ]);
      },
    });
    dispatcher.register({
      name: 'core.chained',
      priority: 20,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        if (context.event.event.stream_seq === 2) {
          chained.push(context.event.causeEventPosition);
        }
      },
    });

    const event = await appendOne(207, 1);
    const result = await dispatcher.dispatch(event);

    expect(result.chained).toHaveLength(1);
    expect(chained).toEqual([event.position]);
    const queued = await pool.query<{ count: string }>(
      'select count(*) as count from event_dispatch where stream_id = $1',
      [streamId(207)],
    );
    expect(Number(queued.rows[0]?.count)).toBe(0);
  });

  /**
   * The bound of WP-49 against the real queue, and the two predicates that make it worth having.
   *
   * The unit tier proves the count; this proves the SQL — that a dead-lettered row really does drop
   * out of the sweep's window and out of `hasEarlierPending`, which is what "the stream moves on"
   * means, and that `events` still has the event (it is append-only, so the dead letter is a queue
   * decision and never a loss).
   */
  it('dead-letters a permanently failing event and lets its stream move on', async () => {
    const dispatcher = bus();
    const attempts = { count: 0 };
    const seen: number[] = [];
    const escalations: { position: number; handler: string }[] = [];
    dispatcher.register({
      name: 'core.poison',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        attempts.count += 1;
        throw new Error('deterministic: this payload will never be handled');
      },
    });
    dispatcher.register({
      name: 'core.after',
      priority: 20,
      eventTypes: ['task.dequeued'],
      handle: async (context) => {
        seen.push(context.event.position);
      },
    });
    dispatcher.onDeadLetter(async (_scope, record) => {
      escalations.push({ position: record.event.position, handler: record.handler });
    });

    const poisoned = await appendOne(209, 1);
    const [next] = await unitOfWork.transaction(async (scope) =>
      scope.events.append([
        taskDequeued({ streamType: 'task', streamId: streamId(209) as Id, streamSeq: 2 }),
      ]),
    );
    if (next === undefined) {
      throw new Error('append returned nothing');
    }

    const worker = new OutboxWorker({ bus: dispatcher, store, batchSize: 8 });
    const deadBefore = await store.countDeadLettered();
    // Dispatched directly rather than swept, because this file's earlier cases deliberately leave
    // their own `task.queued` rows queued (`undoes a handler that throws after writing`) and a
    // sweep would hand those to this test's handler too — measured at 19 attempts instead of 10.
    for (let attempt = 1; attempt <= DEFAULT_MAX_DISPATCH_ATTEMPTS; attempt += 1) {
      await dispatcher.dispatch(poisoned);
    }

    expect(attempts.count).toBe(DEFAULT_MAX_DISPATCH_ATTEMPTS);
    expect(escalations).toEqual([{ position: poisoned.position, handler: 'core.poison' }]);
    // The row is terminal rather than gone, and it says which handler spent the bound.
    const row = await pool.query<{ attempts: number; handler: string | null; dead: string | null }>(
      'select attempts, dead_letter_handler as handler, dead_lettered_at as dead from event_dispatch where event_position = $1',
      [poisoned.position],
    );
    expect(row.rows[0]).toMatchObject({
      attempts: DEFAULT_MAX_DISPATCH_ATTEMPTS,
      handler: 'core.poison',
    });
    expect(row.rows[0]?.dead).not.toBeNull();
    expect(await store.countDeadLettered()).toBe(deadBefore + 1);

    // The whole point, and it is the **sweep** that has to see it: the event behind the dead letter
    // is offered by `readPendingDispatch`, passes `hasEarlierPending`, and is dispatched.
    const report = await worker.drain();
    expect(report.dispatched).toBeGreaterThanOrEqual(1);
    expect(seen).toEqual([next.position]);
    const queued = await pool.query<{ count: string }>(
      'select count(*) as count from event_dispatch where stream_id = $1 and dead_lettered_at is null',
      [streamId(209)],
    );
    expect(Number(queued.rows[0]?.count)).toBe(0);
    // `events` is append-only: the dead letter is a decision about the queue, not about the log.
    expect(await store.readAt(poisoned.position)).not.toBeNull();
  });

  /**
   * Standing rule 29: a baseline, a move, and then a *second* scrape that must not move again —
   * because a gauge that counts every sweep would also "move" and prove nothing.
   */
  it('publishes the dead letter as a gauge that separates it from the backlog', async () => {
    const dispatcher = bus();
    dispatcher.register({
      name: 'core.poison',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        throw new Error('deterministic');
      },
    });
    const metrics = createMetrics({
      defaultMetrics: false,
      pendingDispatch: async () => store.countPendingDispatch(),
      deadLettered: async () => store.countDeadLettered(),
    });
    const reading = async (name: string): Promise<number> => {
      await metrics.collect();
      const line = (await metrics.registry.metrics())
        .split('\n')
        .find((text) => text.startsWith(`${name} `));
      return Number(line?.slice(name.length + 1) ?? Number.NaN);
    };

    const baseline = await reading('event_dispatch_dead_lettered');
    const event = await appendOne(210, 1);
    // Queued and failing: the backlog gauge counts it, and it reads exactly like a busy queue.
    await dispatcher.dispatch(event);
    expect(await reading('event_dispatch_pending')).toBeGreaterThan(0);
    expect(await reading('event_dispatch_dead_lettered')).toBe(baseline);

    for (let attempt = 2; attempt <= DEFAULT_MAX_DISPATCH_ATTEMPTS; attempt += 1) {
      await dispatcher.dispatch(event);
    }

    expect(await reading('event_dispatch_dead_lettered')).toBe(baseline + 1);
    // Dispatched again, and again: the row is terminal, so the number does not climb with sweeps.
    await dispatcher.dispatch(event);
    await dispatcher.dispatch(event);
    expect(await reading('event_dispatch_dead_lettered')).toBe(baseline + 1);
  });

  /**
   * The canary for the bound itself (standing rules 3 and 67): switch it off and the old behaviour
   * is back, which is also what `APP_DISPATCH_MAX_ATTEMPTS=0` gives an operator who wants it. It is
   * here rather than only in the unit tier because `Infinity` has to survive the round trip into
   * PostgreSQL, where `attempts + 1 >= 'Infinity'::double precision` is the comparison.
   */
  it('never dead-letters when the bound is switched off', async () => {
    const dispatcher = new EventBus({
      unitOfWork,
      retryDelayMs: 0,
      maxRetryDelayMs: 0,
      maxDispatchAttempts: Number.POSITIVE_INFINITY,
    });
    dispatcher.register({
      name: 'core.poison',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        throw new Error('deterministic');
      },
    });

    const event = await appendOne(211, 1);
    for (let attempt = 1; attempt <= DEFAULT_MAX_DISPATCH_ATTEMPTS + 2; attempt += 1) {
      expect((await dispatcher.dispatch(event)).status).toBe('failed');
    }

    const row = await pool.query<{ dead: string | null; attempts: number }>(
      'select dead_lettered_at as dead, attempts from event_dispatch where event_position = $1',
      [event.position],
    );
    expect(row.rows[0]?.dead).toBeNull();
    expect(row.rows[0]?.attempts).toBe(DEFAULT_MAX_DISPATCH_ATTEMPTS + 2);
  });

  it('lets the outbox worker find events nobody dispatched, woken by NOTIFY', async () => {
    const dispatcher = bus();
    const seen: number[] = [];
    dispatcher.register({
      name: 'core.sweep',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        seen.push(context.event.position);
      },
    });
    const worker = new OutboxWorker({
      bus: dispatcher,
      store,
      // No broadcast: this is the polling fallback of TD-014 on its own.
      pollIntervalMs: 20,
    });
    await worker.start();
    const event = await appendOne(208, 1);

    await expect.poll(async () => seen.includes(event.position), { timeout: 10_000 }).toBe(true);
    await worker.stop();
    const queued = await pool.query<{ count: string }>(
      'select count(*) as count from event_dispatch where stream_id = $1',
      [streamId(208)],
    );
    expect(Number(queued.rows[0]?.count)).toBe(0);
  });
});
