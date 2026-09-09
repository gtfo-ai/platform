import { describe, expect, it, vi } from 'vitest';
import { EVENTS_APPENDED_TOPIC } from '../ports/broadcast.js';
import { streamId, taskQueued } from '../testing/fixtures.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { EventBus } from './event-bus.js';
import type { EventHandler } from './handler.js';
import { OUTBOX_SWEEP_JOB, OutboxWorker } from './outbox.js';

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
    expect(await worker.drain()).toEqual({ scanned: 0, dispatched: 0, failed: 0, deferred: 0 });
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
    const warnings: string[] = [];
    const worker = new OutboxWorker({
      bus,
      store,
      pollIntervalMs: 5,
      logger: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (_fields, message) => warnings.push(message),
      },
    });
    await worker.start();
    await append(memory, 1, 1);

    await vi.waitFor(() => {
      expect(seen).toEqual([1]);
    });
    expect(warnings).toContain('outbox sweep failed');
    await worker.stop();
  });

  it('hands the timer to an external scheduler when one is given (WP-05 seam)', async () => {
    const { memory, bus, seen } = harness();
    let scheduled: { name: string; intervalMs: number; run: () => Promise<void> } | undefined;
    let stopped = false;
    const worker = new OutboxWorker({
      bus,
      store: memory.store,
      // Short on purpose: if the worker kept a timer of its own, this would fire many times inside
      // the wait below and the assertion that nothing was swept would fail.
      pollIntervalMs: 5,
      scheduler: {
        schedule: async (name, intervalMs, run) => {
          scheduled = { name, intervalMs, run };
          return {
            stop: async () => {
              stopped = true;
            },
          };
        },
      },
    });
    await worker.start();

    expect(scheduled).toMatchObject({ name: OUTBOX_SWEEP_JOB, intervalMs: 5 });
    await append(memory, 1, 1);

    // No broadcast and a scheduler that has not run: the only thing that could dispatch this event
    // is a timer the worker was supposed to have handed over.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(seen).toEqual([]);
    expect(await memory.store.countPendingDispatch()).toBe(1);

    await scheduled?.run();
    expect(seen).toEqual([1]);

    await worker.stop();
    expect(stopped).toBe(true);
  });

  it('reports a scheduler that will not start, instead of half-starting', async () => {
    const { memory, bus } = harness();
    let closed = false;
    const worker = new OutboxWorker({
      bus,
      store: memory.store,
      broadcast: {
        publish: async () => {},
        subscribe: async () => ({
          close: async () => {
            closed = true;
          },
        }),
        close: async () => {},
      },
      scheduler: {
        schedule: async () => {
          throw new Error('pg-boss is not started');
        },
      },
    });

    await expect(worker.start()).rejects.toThrow('pg-boss is not started');
    expect(worker.running).toBe(false);
    // And the subscription it had already opened was closed again.
    expect(closed).toBe(true);
  });

  it('surfaces the original failure even when the unwind throws synchronously', async () => {
    const { memory, bus } = harness();
    const worker = new OutboxWorker({
      bus,
      store: memory.store,
      broadcast: {
        publish: async () => {},
        subscribe: async () => ({
          // Synchronous, so an attached `.catch()` would never see it — it would escape and
          // replace the scheduler's error, hiding the reason the worker did not start.
          close: () => {
            throw new Error('socket already gone');
          },
        }),
        close: async () => {},
      },
      scheduler: {
        schedule: async () => {
          throw new Error('pg-boss is not started');
        },
      },
    });

    await expect(worker.start()).rejects.toThrow('pg-boss is not started');
    expect(worker.running).toBe(false);
  });

  it('still wakes on a NOTIFY hint while an external scheduler owns the timer', async () => {
    const { memory, bus, seen } = harness();
    const worker = new OutboxWorker({
      bus,
      store: memory.store,
      broadcast: memory.broadcast,
      pollIntervalMs: 120_000,
      scheduler: {
        schedule: async () => ({ stop: async () => {} }),
      },
    });
    await worker.start();
    await append(memory, 1, 1);

    await vi.waitFor(() => {
      expect(seen).toEqual([1]);
    });
    await worker.stop();
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
