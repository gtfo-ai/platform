/**
 * Worked examples of the dispatcher's contract. The *property* — at-least-once plus idempotent
 * handlers gives exactly-once effects — is proved in `event-bus.property.test.ts`; these pin the
 * individual behaviours that property would not name if it failed.
 */

import { describe, expect, it, vi } from 'vitest';
import type { StoredEvent } from '../ports/event-store.js';
import { DISPATCH_MARKER } from '../ports/handler-executions.js';
import { silentLogger } from '../ports/logger.js';
import { streamId, taskDequeued, taskQueued } from '../testing/fixtures.js';
import { faultsAt, MemoryEventing, SimulatedCrashError } from '../testing/memory-eventing.js';
import { MAX_CONCURRENCY_CONFLICT_ATTEMPTS } from './concurrency.js';
import { EventBus } from './event-bus.js';
import type { EventHandler } from './handler.js';

const STREAM = { streamType: 'task', streamId: streamId(1), streamSeq: 1 } as const;

/** A fake store and a bus with the retry backoff switched off, so a retry is immediate. */
const harness = (): { memory: MemoryEventing; bus: EventBus } => {
  const memory = new MemoryEventing();
  return {
    memory,
    bus: new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 }),
  };
};

/** A handler that records its name into `effects` inside the transaction it was given. */
const recording = (effects: string[], overrides: Partial<EventHandler> = {}): EventHandler => ({
  name: 'core.record',
  priority: 10,
  eventTypes: ['task.queued'],
  handle: async (context) => {
    effects.push(`${overrides.name ?? 'core.record'}@${context.event.position}`);
  },
  ...overrides,
});

const appendOne = async (memory: MemoryEventing, seq = 1, stream = streamId(1)) => {
  const [stored] = await memory.transaction(async (scope) =>
    scope.events.append([taskQueued({ streamType: 'task', streamId: stream, streamSeq: seq })]),
  );
  if (stored === undefined) {
    throw new Error('append returned nothing');
  }
  return stored;
};

describe('EventBus', () => {
  it('runs the handlers of an event in priority order and completes its dispatch', async () => {
    const { memory, bus } = harness();
    const effects: string[] = [];
    bus.register(recording(effects, { name: 'ui.board', priority: 220 }));
    bus.register(recording(effects, { name: 'core.intake', priority: 10 }));
    bus.register(recording(effects, { name: 'jira.workpad', priority: 110 }));

    const event = await appendOne(memory);
    const result = await bus.dispatch(event);

    expect(result.status).toBe('dispatched');
    expect(effects).toEqual([
      `core.intake@${event.position}`,
      `jira.workpad@${event.position}`,
      `ui.board@${event.position}`,
    ]);
    expect(memory.pending).toEqual([]);
    expect(memory.executions.find((row) => row.handler === DISPATCH_MARKER)?.status).toBe(
      'succeeded',
    );
  });

  it('only runs handlers that declared the event type', async () => {
    const { memory, bus } = harness();
    const effects: string[] = [];
    bus.register(recording(effects, { name: 'wants.queued', eventTypes: ['task.queued'] }));
    bus.register(recording(effects, { name: 'wants.dequeued', eventTypes: ['task.dequeued'] }));

    const [stored] = await memory.transaction(async (scope) =>
      scope.events.append([taskDequeued(STREAM)]),
    );
    await bus.dispatch(stored as StoredEvent);

    expect(effects).toEqual([`wants.dequeued@${(stored as StoredEvent).position}`]);
  });

  it('is a no-op on redelivery: the second dispatch skips every handler', async () => {
    const { memory, bus } = harness();
    const effects: string[] = [];
    bus.register(recording(effects));

    const event = await appendOne(memory);
    await bus.dispatch(event);
    const second = await bus.dispatch(event);

    expect(second.status).toBe('completed');
    expect(effects).toHaveLength(1);
  });

  it('keeps the event queued when a handler throws, and re-runs only that handler', async () => {
    const { memory, bus } = harness();
    const effects: string[] = [];
    let failures = 1;
    bus.register(recording(effects, { name: 'core.first', priority: 10 }));
    bus.register({
      name: 'core.flaky',
      priority: 20,
      eventTypes: ['task.queued'],
      handle: async () => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('transient');
        }
        effects.push('core.flaky');
      },
    });

    const event = await appendOne(memory);
    const first = await bus.dispatch(event);
    expect(first.status).toBe('failed');
    expect(memory.pending).toHaveLength(1);
    expect(memory.pending[0]?.attempts).toBe(1);
    expect(memory.executions.find((row) => row.handler === 'core.flaky')?.status).toBe('failed');

    const second = await bus.dispatch(event);
    expect(second.status).toBe('dispatched');
    // core.first ran once and was skipped the second time; core.flaky ran on the retry.
    expect(effects).toEqual([`core.first@${event.position}`, 'core.flaky']);
    expect(memory.pending).toEqual([]);
  });

  it('stops the remaining handlers durably when a policy handler calls stop()', async () => {
    const { memory, bus } = harness();
    const effects: string[] = [];
    bus.register({
      name: 'policy.gate',
      priority: 0,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        effects.push('policy.gate');
        context.stop('shadow task: no outward action');
      },
    });
    bus.register(recording(effects, { name: 'jira.workpad', priority: 110 }));

    const event = await appendOne(memory);
    const result = await bus.dispatch(event);

    expect(result.status).toBe('dispatched');
    expect(result.handlers.map((entry) => entry.result)).toEqual(['stopped', 'stopped']);
    expect(effects).toEqual(['policy.gate']);
    // The skip is on record, so a redelivery cannot let the silenced handler through.
    expect(memory.executions.find((row) => row.handler === 'jira.workpad')?.status).toBe('stopped');

    await bus.dispatch(event);
    expect(effects).toEqual(['policy.gate']);
  });

  it('dispatches events a handler emitted, after the current handlers (chaining)', async () => {
    const { memory, bus } = harness();
    const order: string[] = [];
    bus.register({
      name: 'core.emitter',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        order.push('emitter');
        await context.emit([taskDequeued({ ...STREAM, streamSeq: 2 })]);
      },
    });
    bus.register({
      name: 'core.late',
      priority: 20,
      eventTypes: ['task.queued'],
      handle: async () => {
        order.push('late');
      },
    });
    bus.register({
      name: 'core.chained',
      priority: 10,
      eventTypes: ['task.dequeued'],
      handle: async (context) => {
        order.push(`chained@${context.event.causeEventPosition}`);
      },
    });

    const event = await appendOne(memory);
    const result = await bus.dispatch(event);

    expect(result.chained).toHaveLength(1);
    expect(order).toEqual(['emitter', 'late', `chained@${event.position}`]);
    expect(memory.pending).toEqual([]);
  });

  it('leaves a chain deeper than the limit for the sweep instead of recursing', async () => {
    const memory = new MemoryEventing();
    const bus = new EventBus({ unitOfWork: memory, maxChainDepth: 1 });
    let seq = 1;
    bus.register({
      name: 'core.loop',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        seq += 1;
        await context.emit([taskQueued({ ...STREAM, streamSeq: seq })]);
      },
    });

    const event = await appendOne(memory);
    await bus.dispatch(event);

    // depth 0 and depth 1 ran; the event depth 2 would have handled is still queued.
    expect(memory.pending).toHaveLength(1);
  });

  it('refuses to dispatch an event whose stream has an earlier event still queued', async () => {
    const { memory, bus } = harness();
    const effects: string[] = [];
    bus.register(recording(effects));

    const first = await appendOne(memory, 1);
    const second = await appendOne(memory, 2);

    expect((await bus.dispatch(second)).status).toBe('blocked');
    expect(effects).toEqual([]);
    expect((await bus.dispatch(first)).status).toBe('dispatched');
    expect((await bus.dispatch(second)).status).toBe('dispatched');
  });

  it('refuses new work while stopping, and drains what is in flight', async () => {
    const { memory, bus } = harness();
    let release: () => void = () => {};
    const started = new Promise<void>((resolve) => {
      bus.register({
        name: 'core.slow',
        priority: 10,
        eventTypes: ['task.queued'],
        handle: async () => {
          resolve();
          await new Promise<void>((done) => {
            release = done;
          });
        },
      });
    });

    const event = await appendOne(memory);
    const inFlight = bus.dispatch(event);
    await started;

    const stopping = bus.stop();
    expect(bus.stopping).toBe(true);
    expect((await bus.dispatch(await appendOne(memory, 2))).status).toBe('stopping');

    release();
    await inFlight;
    await expect(stopping).resolves.toEqual({ drained: true, inFlight: 0 });
    // The in-flight event finished rather than being dropped.
    expect(memory.pending.map((row) => row.streamSeq)).toEqual([2]);
  });

  it('reports what is still running when the drain times out', async () => {
    const { memory, bus } = harness();
    bus.register({
      name: 'core.stuck',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => new Promise<void>(() => {}),
    });
    const event = await appendOne(memory);
    void bus.dispatch(event);
    await Promise.resolve();

    const report = await bus.stop({ timeoutMs: 5 });
    expect(report).toEqual({ drained: false, inFlight: 1 });
  });

  it('never runs more dispatches at once than its connection budget allows', async () => {
    const memory = new MemoryEventing();
    const bus = new EventBus({ unitOfWork: memory, maxConcurrentDispatches: 2 });
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    bus.register({
      name: 'core.slow',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      },
    });

    // Four independent streams, so nothing is blocked by the ordering guard.
    const events = await Promise.all(
      [1, 2, 3, 4].map(async (n) => appendOne(memory, 1, streamId(n))),
    );
    const dispatches = events.map(async (event) => bus.dispatch(event));

    await vi.waitFor(() => {
      expect(releases).toHaveLength(2);
    });
    expect(peak).toBe(2);
    // Two connections each: the budget the adapter sizes its pool against.
    expect(bus.requiredConnections).toBe(5);
    expect(bus.maxConcurrentDispatches).toBe(2);

    // Let the rest through, releasing whatever is waiting until every dispatch has settled.
    const settled = Promise.all(dispatches);
    let finished = false;
    void settled.then(() => {
      finished = true;
    });
    while (!finished) {
      while (releases.length > 0) {
        releases.pop()?.();
      }
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await settled;
    expect(peak).toBe(2);
  });

  it('admits no extra dispatch however deep in the microtask queue it arrives', async () => {
    // The probe that pins the slot hand-over, and the reason it lives at the unit tier.
    //
    // Releasing a slot and *then* waking a waiter leaves the counter below the limit for one
    // microtask. A dispatch() call whose continuation was already queued when the release ran
    // resumes inside that gap, sees a free slot and takes it — and the woken waiter takes one too,
    // so a limit of 1 runs two handlers. Hitting it needs the probe to arrive at the release, not
    // before it: each release is followed by a fan of dispatches at every microtask depth up to
    // the depth the release itself unwinds through.
    //
    // DO NOT "simplify" this into an integration test. The equivalent experiment against a real
    // PostgreSQL passes on the broken semaphore as readily as on the fixed one: every caller is
    // already parked in the wait queue by the time a release lands, because a COMMIT round-trip
    // pushes it into a later macrotask turn, so the gap never opens. The in-memory fake, where a
    // commit resolves on a microtask, is the only instrument that can reach it. Losing this test
    // means losing the only coverage of an invariant `requiredConnections` depends on.
    const memory = new MemoryEventing();
    const bus = new EventBus({ unitOfWork: memory, maxConcurrentDispatches: 1 });
    let active = 0;
    let peak = 0;
    const releases: (() => void)[] = [];
    bus.register({
      name: 'core.probe',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
      },
    });

    const DEPTHS = 24;
    const ROUNDS = 4;
    // One stream each, so nothing is held back by the ordering guard.
    const events = await Promise.all(
      Array.from({ length: DEPTHS * ROUNDS + 2 }, async (_unused, index) =>
        appendOne(memory, 1, streamId(index + 1)),
      ),
    );
    let next = 0;
    const dispatches: Promise<unknown>[] = [];
    const start = (depth: number): void => {
      const event = events[next];
      next += 1;
      if (event === undefined) {
        return;
      }
      dispatches.push(
        (async () => {
          for (let hop = 0; hop < depth; hop += 1) {
            await Promise.resolve();
          }
          return bus.dispatch(event);
        })(),
      );
    };

    // One holder and one waiter, so every later arrival meets an occupied bus.
    start(0);
    start(0);
    await vi.waitFor(() => {
      expect(releases).toHaveLength(1);
    });

    for (let round = 0; round < ROUNDS; round += 1) {
      // Release, then fan probes across the microtask depths the release unwinds through.
      releases.shift()?.();
      for (let depth = 0; depth < DEPTHS; depth += 1) {
        start(depth);
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }

    const settled = Promise.all(dispatches);
    let finished = false;
    void settled.then(() => {
      finished = true;
    });
    while (!finished) {
      while (releases.length > 0) {
        releases.shift()?.();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    await settled;

    expect(peak).toBe(1);
    expect(bus.requiredConnections).toBe(3);
  });

  it('refuses a concurrency that is not a positive integer', () => {
    const memory = new MemoryEventing();
    expect(() => new EventBus({ unitOfWork: memory, maxConcurrentDispatches: 0 })).toThrow(
      RangeError,
    );
    expect(() => new EventBus({ unitOfWork: memory, maxConcurrentDispatches: 1.5 })).toThrow(
      RangeError,
    );
  });

  it('releases the slot of a caller that arrived while the bus was stopping', async () => {
    const { memory, bus } = harness();
    bus.register(recording([]));
    await bus.stop();
    const event = await appendOne(memory);
    expect((await bus.dispatch(event)).status).toBe('stopping');
    // The slot was handed back, so a resumed bus still works.
    bus.resume();
    expect((await bus.dispatch(event)).status).toBe('dispatched');
  });

  it('resume() re-arms a stopped bus', async () => {
    const { memory, bus } = harness();
    const effects: string[] = [];
    bus.register(recording(effects));
    await bus.stop();
    bus.resume();
    expect((await bus.dispatch(await appendOne(memory))).status).toBe('dispatched');
  });

  it('rolls the handler effect back with its bookkeeping when the process dies before commit', async () => {
    const effects: string[] = [];
    // Transaction 1 is the append; transaction 2 is the handler's — killed just before it commits.
    const memory = new MemoryEventing({ faults: faultsAt([2]) });
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    bus.register(recording(effects));

    const event = await appendOne(memory);
    const result = await bus.dispatch(event);

    expect(result.status).toBe('failed');
    expect(result.handlers[0]?.error).toMatch(/SimulatedCrashError/);
    // The handler body ran, but nothing it wrote survived, and nothing says it succeeded.
    expect(memory.executions.find((row) => row.handler === 'core.record')?.status).toBe('failed');
    expect(memory.pending).toHaveLength(1);
  });

  it('never runs a handler twice when the process dies just after its commit', async () => {
    const effects: string[] = [];
    const memory = new MemoryEventing({ faults: faultsAt([], [2]) });
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    bus.register(recording(effects));

    const event = await appendOne(memory);
    await bus.dispatch(event);
    expect(effects).toHaveLength(1);

    // The queue row survived, so the event comes back — and the committed execution row stops it.
    expect(memory.pending).toHaveLength(1);
    const retry = await bus.dispatch(event);
    expect(retry.status).toBe('dispatched');
    expect(retry.handlers[0]?.result).toBe('skipped');
    expect(effects).toHaveLength(1);
  });

  it('propagates a crash that happens after the dispatch transaction committed', async () => {
    const memory = new MemoryEventing({ faults: faultsAt([], [3]) });
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    bus.register(recording([]));
    const event = await appendOne(memory);
    await expect(bus.dispatch(event)).rejects.toBeInstanceOf(SimulatedCrashError);
    // Committed, so it is gone from the queue even though the caller saw an error.
    expect(memory.pending).toEqual([]);
  });
});

describe('afterCommit', () => {
  /** A handler that writes an effect and asks for a callback once its transaction has committed. */
  const enqueuing = (log: string[], overrides: Partial<EventHandler> = {}): EventHandler => ({
    name: 'core.enqueue',
    priority: 10,
    eventTypes: ['task.queued'],
    handle: async (context) => {
      log.push('handler');
      context.afterCommit(() => {
        log.push('callback');
      });
    },
    ...overrides,
  });

  it('runs the callback after the handler committed, and in registration order', async () => {
    const { memory, bus } = harness();
    const log: string[] = [];
    bus.register({
      ...enqueuing(log),
      handle: async (context) => {
        log.push('handler');
        context.afterCommit(() => {
          log.push('first');
        });
        context.afterCommit(async () => {
          log.push('second');
        });
      },
    });
    const result = await bus.dispatch(await appendOne(memory));
    expect(result.handlers[0]?.result).toBe('ran');
    expect(log).toEqual(['handler', 'first', 'second']);
  });

  it('does NOT run the callback when the handler transaction rolls back', async () => {
    // This is the whole point of the seam: a job enqueued inline would outlive the rollback that
    // deleted its reason for existing.
    const log: string[] = [];
    const memory = new MemoryEventing({ faults: faultsAt([2]) });
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    bus.register(enqueuing(log));

    const result = await bus.dispatch(await appendOne(memory));

    expect(result.status).toBe('failed');
    // Rule 10: the handler body *did* run — asserting only "no callback" would pass on a bus that
    // never called the handler at all.
    expect(log).toEqual(['handler']);
  });

  it('loses the callback when the process dies between the commit and the callback', async () => {
    // The at-most-once caveat in the docblock, demonstrated rather than asserted in prose: the
    // handler's effect is durable, the callback never ran, and the redelivery skips the handler —
    // so nothing re-arms it. Every job the pipeline enqueues has to tolerate this, which is why
    // they all re-validate on fire.
    const log: string[] = [];
    const memory = new MemoryEventing({ faults: faultsAt([], [2]) });
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    bus.register(enqueuing(log));
    const event = await appendOne(memory);

    await bus.dispatch(event);
    expect(log).toEqual(['handler']);

    const retry = await bus.dispatch(event);
    expect(retry.handlers[0]?.result).toBe('skipped');
    expect(log).toEqual(['handler']);
  });

  it('logs a callback that throws and leaves the handler successful', async () => {
    const memory = new MemoryEventing();
    const errors: unknown[] = [];
    const bus = new EventBus({
      unitOfWork: memory,
      retryDelayMs: 0,
      maxRetryDelayMs: 0,
      logger: {
        ...silentLogger,
        error: (fields) => {
          errors.push(fields.err);
        },
      },
    });
    bus.register({
      name: 'core.enqueue',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async (context) => {
        context.afterCommit(() => {
          throw new Error('pg-boss is down');
        });
      },
    });

    const result = await bus.dispatch(await appendOne(memory));

    expect(result.status).toBe('dispatched');
    expect(result.handlers[0]?.result).toBe('ran');
    expect((errors[0] as Error).message).toBe('pg-boss is down');
  });
});

/**
 * A handler that lost a race is re-run here, not five seconds later behind its whole stream
 * (WP-15e).
 *
 * The bound is {@link MAX_CONCURRENCY_CONFLICT_ATTEMPTS} and it is asserted from both sides
 * (standing rule 42): a handler that conflicts up to the bound and then succeeds leaves its effect,
 * and one that conflicts every time falls through to the ordinary failure path — which records the
 * failure and re-queues the event rather than dropping it.
 */
describe('a handler that loses a race with another writer', () => {
  class Conflict extends Error {
    readonly concurrencyConflict = true as const;
  }

  const conflicting = (attempts: { count: number }, until: number): EventHandler => ({
    name: 'core.conflict',
    priority: 10,
    eventTypes: ['task.queued'],
    handle: async () => {
      attempts.count += 1;
      if (attempts.count <= until) {
        throw new Conflict('task moved');
      }
    },
  });

  it('re-runs it against a fresh transaction, up to the bound', async () => {
    const { memory, bus } = harness();
    const attempts = { count: 0 };
    bus.register(conflicting(attempts, MAX_CONCURRENCY_CONFLICT_ATTEMPTS - 1));
    const stored = await appendOne(memory);

    const result = await bus.dispatch(stored);

    expect(attempts.count).toBe(MAX_CONCURRENCY_CONFLICT_ATTEMPTS);
    expect(result.status).toBe('dispatched');
    expect(result.handlers).toEqual([{ handler: 'core.conflict', result: 'ran' }]);
  });

  it('stops at the bound and leaves the event queued, rather than retrying for ever', async () => {
    const { memory, bus } = harness();
    const attempts = { count: 0 };
    bus.register(conflicting(attempts, Number.POSITIVE_INFINITY));
    const stored = await appendOne(memory);

    const result = await bus.dispatch(stored);

    expect(attempts.count).toBe(MAX_CONCURRENCY_CONFLICT_ATTEMPTS);
    expect(result.status).toBe('failed');
    // Not a drop: the queue row is still there, with the failure on it.
    const queued = memory.pending;
    expect(queued.map((entry) => entry.eventPosition)).toContain(stored.position);
    expect(queued[0]?.error).toContain('task moved');
  });

  it('does not re-run a handler whose failure is not a conflict', async () => {
    const { memory, bus } = harness();
    let attempts = 0;
    bus.register({
      name: 'core.boom',
      priority: 10,
      eventTypes: ['task.queued'],
      handle: async () => {
        attempts += 1;
        throw new Error('boom');
      },
    });
    const stored = await appendOne(memory);

    const result = await bus.dispatch(stored);

    expect(attempts).toBe(1);
    expect(result.status).toBe('failed');
  });
});
