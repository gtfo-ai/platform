import { describe, expect, it, vi } from 'vitest';
import { type Broadcast, EVENTS_APPENDED_TOPIC } from '../ports/broadcast.js';
import type { EventStore } from '../ports/event-store.js';
import type { LogFields } from '../ports/logger.js';
import { streamId, taskQueued } from '../testing/fixtures.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { EventBus } from './event-bus.js';
import type { EventHandler } from './handler.js';
import { OUTBOX_SWEEP_LABEL, OutboxWorker } from './outbox.js';

const recorder = (seen: number[]): EventHandler => ({
  name: 'core.record',
  priority: 10,
  eventTypes: ['task.queued'],
  handle: async (context) => {
    seen.push(context.event.position);
  },
});

const append = async (memory: MemoryEventing, stream: number, seq: number): Promise<void> => {
  await memory.transaction(async (scope) =>
    scope.events.append([
      taskQueued({ streamType: 'task', streamId: streamId(stream), streamSeq: seq }),
    ]),
  );
};

/**
 * Wraps a store so a test can count sweeps that have **finished**. Counting on entry would not do:
 * a test that appends after "one sweep started" could still have its event picked up by that very
 * sweep, which is the difference between proving the timer re-arms and proving nothing.
 */
const counting = (store: EventStore) => {
  const counter = { sweeps: 0 };
  const counted: EventStore = {
    ...store,
    readPendingDispatch: async (request) => {
      const rows = await store.readPendingDispatch(request);
      counter.sweeps += 1;
      return rows;
    },
  };
  return { store: counted, counter };
};

const harness = () => {
  const memory = new MemoryEventing();
  const seen: number[] = [];
  const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
  bus.register(recorder(seen));
  return { memory, bus, seen };
};

describe('OutboxWorker', () => {
  it('drains everything that is queued, in position order', async () => {
    const { memory, bus, seen } = harness();
    await append(memory, 1, 1);
    await append(memory, 2, 1);
    await append(memory, 1, 2);

    const worker = new OutboxWorker({ bus, store: memory.store, batchSize: 2 });
    const report = await worker.drain();

    expect(report.dispatched).toBe(3);
    expect(seen).toEqual([1, 2, 3]);
    expect(memory.pending).toEqual([]);
  });

  it('returns an empty report when nothing is queued', async () => {
    const { memory, bus } = harness();
    const worker = new OutboxWorker({ bus, store: memory.store });
    expect(await worker.drain()).toEqual({
      scanned: 0,
      dispatched: 0,
      failed: 0,
      deferred: 0,
      deadLettered: 0,
      chainFailed: 0,
    });
  });

  it('counts a failing event as failed and leaves it queued', async () => {
    const memory = new MemoryEventing();
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    bus.register({
      name: 'core.broken',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        throw new Error('nope');
      },
    });
    await append(memory, 1, 1);

    const worker = new OutboxWorker({ bus, store: memory.store });
    const report = await worker.drain();

    expect(report).toMatchObject({ scanned: 1, dispatched: 0, failed: 1 });
    expect(memory.pending).toHaveLength(1);
  });

  it('sweeps on the wake-up hint the append published, without waiting for the poll', async () => {
    const { memory, bus, seen } = harness();
    const worker = new OutboxWorker({
      bus,
      store: memory.store,
      broadcast: memory.broadcast,
      // Long enough that a poll cannot be what woke it.
      pollIntervalMs: 60_000,
    });
    await worker.start();
    await append(memory, 1, 1);

    await vi.waitFor(() => {
      expect(seen).toEqual([1]);
    });
    await worker.stop();
  });

  it('remembers a hint that arrived while it was busy', async () => {
    const { memory, bus, seen } = harness();
    const worker = new OutboxWorker({
      bus,
      store: memory.store,
      broadcast: memory.broadcast,
      pollIntervalMs: 60_000,
    });
    await worker.start();
    await append(memory, 1, 1);
    await append(memory, 1, 2);

    await vi.waitFor(() => {
      expect(seen).toEqual([1, 2]);
    });
    await worker.stop();
  });

  it('polls when there is no broadcast at all', async () => {
    const { memory, bus, seen } = harness();
    const worker = new OutboxWorker({ bus, store: memory.store, pollIntervalMs: 5 });
    await worker.start();
    await append(memory, 1, 1);

    await vi.waitFor(() => {
      expect(seen).toEqual([1]);
    });
    await worker.stop();
  });

  it('start() is idempotent and stop() drains the bus', async () => {
    const { memory, bus } = harness();
    const worker = new OutboxWorker({ bus, store: memory.store, pollIntervalMs: 5 });
    await worker.start();
    await worker.start();
    expect(worker.running).toBe(true);

    const report = await worker.stop();
    expect(report).toEqual({ drained: true, inFlight: 0 });
    expect(worker.running).toBe(false);
  });

  it('keeps looping when a sweep throws', async () => {
    const { memory, bus, seen } = harness();
    let failed = false;
    const store = {
      ...memory.store,
      readPendingDispatch: async (request: { limit: number }) => {
        if (!failed) {
          failed = true;
          throw new Error('connection reset');
        }
        return memory.store.readPendingDispatch(request);
      },
    };
    const errors: Array<{ fields: LogFields; message: string }> = [];
    const debugs: Array<{ fields: LogFields; message: string }> = [];
    const worker = new OutboxWorker({
      bus,
      store,
      pollIntervalMs: 5,
      logger: {
        debug: (fields, message) => debugs.push({ fields, message }),
        info: () => {},
        warn: () => {},
        error: (fields, message) => errors.push({ fields, message }),
      },
    });
    await worker.start();
    await append(memory, 1, 1);

    await vi.waitFor(() => {
      expect(seen).toEqual([1]);
    });
    expect(errors.map((entry) => entry.message)).toContain('outbox sweep failed');
    // The sweep names itself the same way in **every** line it writes — the failure and the
    // successful pass alike — and that name is not a queue: nothing enqueues `events.outbox.sweep`.
    expect(OUTBOX_SWEEP_LABEL).toBe('events.outbox.sweep');
    expect(errors[0]?.fields).toMatchObject({ sweep: OUTBOX_SWEEP_LABEL });
    expect(debugs.map((entry) => entry.message)).toContain('outbox sweep');
    expect(debugs[0]?.fields).toMatchObject({ sweep: OUTBOX_SWEEP_LABEL, dispatched: 1 });
    await worker.stop();
  });

  it('re-arms its own timer after every idle pass', async () => {
    const { memory, bus } = harness();
    const { store, counter } = counting(memory.store);
    const worker = new OutboxWorker({ bus, store, pollIntervalMs: 5 });
    await worker.start();

    // Nothing is queued and nothing wakes the worker, so the only thing that can produce a second
    // and third sweep is the timer being armed again after each idle pass. A worker that armed no
    // timer — or armed one once — stops at one sweep and this wait times out.
    await vi.waitFor(() => {
      expect(counter.sweeps).toBeGreaterThanOrEqual(3);
    });
    await worker.stop();
  });

  it('polls even while subscribed, because the subscription is the thing it backs up', async () => {
    const { memory, bus, seen } = harness();
    const { store, counter } = counting(memory.store);
    // A subscription that is live and silent: the shape of a process whose own LISTEN connection
    // dropped a NOTIFY. Removing the collaborator like this is what caught the previous defect —
    // a timer armed only in the absence of another wake-up source leaves this event queued for
    // ever, because no other process's timer can sweep this process's missed hint.
    const deaf: Broadcast = {
      publish: async () => {},
      subscribe: async () => ({ close: async () => {} }),
      close: async () => {},
    };
    const worker = new OutboxWorker({ bus, store, broadcast: deaf, pollIntervalMs: 5 });
    await worker.start();
    // One sweep has finished, so the worker is past its start-up drain and parked: from here only
    // a re-armed timer can find what is appended next.
    await vi.waitFor(() => {
      expect(counter.sweeps).toBeGreaterThanOrEqual(1);
    });

    await append(memory, 1, 1);
    await vi.waitFor(() => {
      expect(seen).toEqual([1]);
    });
    await worker.stop();
  });

  it('undoes the start when the wake-up subscription fails, instead of half-starting', async () => {
    const { memory, bus } = harness();
    const worker = new OutboxWorker({
      bus,
      store: memory.store,
      broadcast: {
        publish: async () => {},
        subscribe: async () => {
          throw new Error('LISTEN connection refused');
        },
        close: async () => {},
      },
    });

    await expect(worker.start()).rejects.toThrow('LISTEN connection refused');
    // Not "running with no loop behind it": the caller can retry once the transport is back.
    expect(worker.running).toBe(false);
  });

  it('publishes its wake-up hint on the topic the port reserves', async () => {
    const memory = new MemoryEventing();
    const hints: string[] = [];
    await memory.broadcast.subscribe([EVENTS_APPENDED_TOPIC], (message) => {
      hints.push(message.topic);
    });
    await append(memory, 1, 1);
    expect(hints).toEqual([EVENTS_APPENDED_TOPIC]);
  });
});

/**
 * What a sweep can see about failures below it (WP-49, PROGRESS backlog 5).
 *
 * `sweepOnce` reads one row per stream and dispatches each; a handler that emits an event has that
 * event dispatched *inside* the parent's call, and until WP-49 the only thing that came back was
 * the parent's status — so a chained handler that threw was counted as a clean `dispatched`. The
 * fix is a field rather than a fold into `failed`: the four original counts still partition
 * `scanned`, and the one existing reader (the `outbox sweep` log line) is unchanged and picks the
 * new counts up because it spreads the report.
 */
describe('a sweep whose work fails below the events it read', () => {
  const emitting = (): EventHandler => ({
    name: 'core.emitter',
    priority: 10,
    eventTypes: ['task.queued'],
    handle: async (context) => {
      if (context.event.event.stream_seq !== 1) {
        return;
      }
      await context.emit([taskQueued({ streamType: 'task', streamId: streamId(1), streamSeq: 2 })]);
    },
  });

  const failingOnChained = (): EventHandler => ({
    name: 'core.chained',
    priority: 20,
    eventTypes: ['task.queued'],
    handle: async (context) => {
      if (context.event.event.stream_seq === 2) {
        throw new Error('the chained handler threw');
      }
    },
  });

  it('counts a chained dispatch’s failure instead of reporting a clean pass', async () => {
    const memory = new MemoryEventing();
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    bus.register(emitting());
    bus.register(failingOnChained());
    await append(memory, 1, 1);

    // One batch, because `drain()` would sweep again and read the chained event as a row of its
    // own — which is the same failure counted a second way, from the queue rather than the chain.
    const report = await new OutboxWorker({ bus, store: memory.store }).sweepOnce();

    // The parent really did dispatch; that is not the lie. The lie was that this was all.
    expect(report).toMatchObject({ scanned: 1, dispatched: 1, failed: 0, chainFailed: 1 });
    expect(memory.pending.map((entry) => entry.eventPosition)).toEqual([2]);
  });

  it('writes its own line for a pass whose only outcome was a dead letter', async () => {
    // Round 1's nit, and the branch it added: `dispatched > 0 || failed > 0` was false for exactly
    // this pass, so the one line carrying the sweep's counts was never written for the outcome the
    // work package exists to make visible.
    const memory = new MemoryEventing();
    const bus = new EventBus({
      unitOfWork: memory,
      retryDelayMs: 0,
      maxRetryDelayMs: 0,
      // One attempt, so the first failure is the dead letter and the pass dispatches nothing.
      maxDispatchAttempts: 1,
    });
    bus.register({
      name: 'core.poison',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        throw new Error('deterministic');
      },
    });
    const debugs: Array<{ fields: LogFields; message: string }> = [];
    const worker = new OutboxWorker({
      bus,
      store: memory.store,
      pollIntervalMs: 5,
      logger: {
        debug: (fields, message) => debugs.push({ fields, message }),
        info: () => {},
        warn: () => {},
        error: () => {},
      },
    });
    await worker.start();
    await append(memory, 1, 1);

    await vi.waitFor(() => {
      expect(debugs.map((entry) => entry.message)).toContain('outbox sweep');
    });
    expect(debugs.at(-1)?.fields).toMatchObject({
      sweep: OUTBOX_SWEEP_LABEL,
      dispatched: 0,
      failed: 0,
      deadLettered: 1,
    });
    await worker.stop();
  });

  it('counts an event that spent its attempt bound apart from one that will be retried', async () => {
    const memory = new MemoryEventing();
    const bus = new EventBus({
      unitOfWork: memory,
      retryDelayMs: 0,
      maxRetryDelayMs: 0,
      maxDispatchAttempts: 2,
    });
    bus.register({
      name: 'core.poison',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        throw new Error('deterministic');
      },
    });
    await append(memory, 1, 1);
    // The second event of the same stream: what the dead letter exists to release.
    await append(memory, 1, 2);
    const worker = new OutboxWorker({ bus, store: memory.store });

    const first = await worker.drain();
    expect(first).toMatchObject({ scanned: 1, failed: 1, deadLettered: 0 });

    const second = await worker.drain();
    // One pass: the dead letter is progress, so the same drain goes on to the freed stream — and
    // the second event is poisoned by the same handler, so it is failed rather than dispatched.
    expect(second).toMatchObject({ scanned: 2, deadLettered: 1, failed: 1 });
    expect(await memory.store.countDeadLettered()).toBe(1);
  });
});
