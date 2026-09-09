/**
 * WP-04's acceptance criterion, as properties.
 *
 * > at-least-once + idempotent handlers → exactly-once effects; ordering per stream
 *
 * The generator is deliberately hostile. Every run picks its own streams, handler set, redelivery
 * pattern and crash schedule, then drives the queue with several interleaved workers until nothing
 * moves. The three adversarial ingredients are the ones that break naive dispatchers:
 *
 * - **duplicate deliveries** — the same event handed to `dispatch` again and again, which is what
 *   at-least-once means in practice (a sweep that raced a wake-up hint, a worker that restarted);
 * - **crashes at the two dangerous instants** — just before a transaction commits (the effect must
 *   vanish with it) and just *after* (the caller sees an error although the write landed, which is
 *   where a dispatcher that trusts its own return value double-counts);
 * - **interleaved workers** — several dispatch loops on one queue, swapping at every `await`.
 *
 * What is asserted is the *effect*, not the bookkeeping. Handlers write into a ledger that is
 * itself transactional — staged per transaction, committed or discarded with it — because a
 * handler whose writes ignored the transaction would make the property vacuous.
 */
import type { Id } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { StoredEvent } from '../ports/event-store.js';
import { DISPATCH_MARKER } from '../ports/handler-executions.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { streamId, taskQueued } from '../testing/fixtures.js';
import {
  type CommitFault,
  MemoryEventing,
  SimulatedCrashError,
} from '../testing/memory-eventing.js';
import { EventBus } from './event-bus.js';
import type { EventHandler } from './handler.js';

/** One recorded effect: which handler saw which event. */
interface Effect {
  readonly handler: string;
  readonly stream: string;
  readonly streamSeq: number;
  readonly position: number;
}

interface Scenario {
  /** How many events each generated stream carries. */
  readonly streams: readonly number[];
  readonly handlers: readonly { name: string; priority: number }[];
  /** How many extra times each dispatched event is redelivered. */
  readonly redeliveries: number;
  /** Commit ordinals that die before committing. */
  readonly crashBefore: readonly number[];
  /** Commit ordinals that commit and then die. */
  readonly crashAfter: readonly number[];
  /** Dispatch loops driving the queue at the same time. */
  readonly workers: number;
  /**
   * Extra loops that ignore the sweep and hand the dispatcher whatever event they like, newest
   * first. Without them the sweep's own "one event per stream" filter would keep the order for
   * free and the ordering property would have no teeth: this is what makes the dispatcher's own
   * guard the thing under test.
   */
  readonly chaoticWorkers: number;
  /**
   * Whether the handlers also guard themselves.
   *
   * `false` is the interesting half: the handler records unconditionally, so the only thing
   * standing between at-least-once delivery and a duplicated effect is `handler_executions`
   * committing in the same transaction as the effect. `true` adds the guard a handler with an
   * effect outside the database would need; the property must hold either way.
   */
  readonly selfGuarding: boolean;
  /**
   * When set, the first handler in dispatch order calls `stop()`. Every later handler must then be
   * silenced *durably*: on a redelivery the stopping handler is skipped as already succeeded, so
   * only the `stopped` rows it wrote keep the rest from running.
   */
  readonly stopFirst: boolean;
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  streams: fc.array(fc.integer({ min: 1, max: 4 }), { minLength: 1, maxLength: 4 }),
  handlers: fc.uniqueArray(
    fc.record({
      name: fc.constantFrom('core.a', 'core.b', 'jira.c', 'ui.d'),
      priority: fc.integer({ min: 0, max: 299 }),
    }),
    { selector: (entry) => entry.name, minLength: 1, maxLength: 4 },
  ),
  redeliveries: fc.integer({ min: 0, max: 2 }),
  crashBefore: fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 4 }),
  crashAfter: fc.uniqueArray(fc.integer({ min: 1, max: 40 }), { maxLength: 4 }),
  workers: fc.integer({ min: 1, max: 3 }),
  chaoticWorkers: fc.integer({ min: 0, max: 2 }),
  selfGuarding: fc.boolean(),
  stopFirst: fc.boolean(),
});

/**
 * The handlers' side of the world, with the same transactional semantics the database gives.
 *
 * Staging is keyed by the transaction handle, so two interleaved transactions never see or commit
 * each other's writes — the mistake that would make a concurrency property meaningless.
 */
class Ledger {
  readonly committed: Effect[] = [];
  readonly #applied = new Set<string>();
  readonly #staged = new Map<object, { effects: Effect[]; keys: string[] }>();
  readonly #selfGuarding: boolean;

  constructor(selfGuarding: boolean) {
    this.#selfGuarding = selfGuarding;
  }

  begin(key: object): void {
    this.#staged.set(key, { effects: [], keys: [] });
  }

  /** Records an effect; when the handlers are self-guarding, at most once per (event, handler). */
  record(key: object, effect: Effect): void {
    const staged = this.#staged.get(key);
    if (staged === undefined) {
      throw new Error('handler ran outside a transaction');
    }
    const id = `${effect.position}:${effect.handler}`;
    if (this.#selfGuarding && (this.#applied.has(id) || staged.keys.includes(id))) {
      return;
    }
    staged.keys.push(id);
    staged.effects.push(effect);
  }

  commit(key: object): void {
    const staged = this.#staged.get(key);
    this.#staged.delete(key);
    if (staged === undefined) {
      return;
    }
    this.committed.push(...staged.effects);
    for (const id of staged.keys) {
      this.#applied.add(id);
    }
  }

  rollback(key: object): void {
    this.#staged.delete(key);
  }
}

const ledgerHandler = (
  name: string,
  priority: number,
  ledger: Ledger,
  stops: boolean,
): EventHandler => ({
  name,
  priority,
  eventTypes: ['task.queued'],
  handle: async (context) => {
    ledger.record(context.scope.tx, {
      handler: name,
      stream: context.event.event.stream_id,
      streamSeq: context.event.event.stream_seq,
      position: context.event.position,
    });
    if (stops) {
      context.stop('property scenario');
    }
  },
});

const runScenario = async (
  scenario: Scenario,
): Promise<{ ledger: Effect[]; memory: MemoryEventing }> => {
  const ledger = new Ledger(scenario.selfGuarding);
  const memory = new MemoryEventing({
    faults: {
      onCommit: (index): CommitFault =>
        scenario.crashBefore.includes(index)
          ? 'before-commit'
          : scenario.crashAfter.includes(index)
            ? 'after-commit'
            : 'none',
    },
  });

  // The fake commits and rolls back its own tables; this wrapper makes the ledger follow.
  const unitOfWork: UnitOfWork = {
    transaction: async <T>(fn: (scope: TransactionScope) => Promise<T>): Promise<T> => {
      let key: object | undefined;
      try {
        const result = await memory.transaction(async (scope) => {
          key = scope.tx;
          ledger.begin(scope.tx);
          return fn(scope);
        });
        if (key !== undefined) {
          ledger.commit(key);
        }
        return result;
      } catch (error) {
        if (key !== undefined) {
          // An "after-commit" crash means the write landed; anything else means it did not.
          if (error instanceof SimulatedCrashError && error.when === 'after-commit') {
            ledger.commit(key);
          } else {
            ledger.rollback(key);
          }
        }
        throw error;
      }
    },
  };

  const bus = new EventBus({ unitOfWork, retryDelayMs: 0, maxRetryDelayMs: 0 });
  const ordered = [...scenario.handlers].sort(
    (a, b) => a.priority - b.priority || (a.name < b.name ? -1 : 1),
  );
  for (const [index, handler] of ordered.entries()) {
    bus.register(
      ledgerHandler(handler.name, handler.priority, ledger, scenario.stopFirst && index === 0),
    );
  }

  const tolerateCrash = async (work: () => Promise<unknown>): Promise<boolean> => {
    try {
      await work();
      return true;
    } catch (error) {
      if (error instanceof SimulatedCrashError) {
        return true;
      }
      throw error;
    }
  };

  // Append, one transaction per event, so a crash can also hit an append. The sequence is read
  // back each time, the way an aggregate reloads: an append killed before its commit takes the
  // stream counter down with it, and the next one legitimately reuses the number.
  for (const [index, count] of scenario.streams.entries()) {
    const stream = streamId(index + 1) as Id;
    for (let written = 0; written < count; written += 1) {
      const streamSeq = await memory.store.nextStreamSequence('task', stream);
      await tolerateCrash(async () =>
        unitOfWork.transaction(async (scope) =>
          scope.events.append([taskQueued({ streamType: 'task', streamId: stream, streamSeq })]),
        ),
      );
    }
  }

  const dispatchAll = async (chaotic: boolean): Promise<number> => {
    let progressed = 0;
    const pending = chaotic
      ? [...memory.log].reverse()
      : await memory.store.readPendingDispatch({ limit: 8 });
    for (const event of pending) {
      for (let attempt = 0; attempt <= scenario.redeliveries; attempt += 1) {
        await tolerateCrash(async () => {
          const result = await bus.dispatch(event as StoredEvent);
          if (result.status === 'dispatched' || result.status === 'failed') {
            progressed += 1;
          }
        });
      }
    }
    return progressed;
  };

  for (let round = 0; round < 32; round += 1) {
    const results = await Promise.all([
      ...Array.from({ length: scenario.workers }, async () => dispatchAll(false)),
      ...Array.from({ length: scenario.chaoticWorkers }, async () => dispatchAll(true)),
    ]);
    if (results.every((count) => count === 0)) {
      break;
    }
  }

  return { ledger: ledger.committed, memory };
};

describe('dispatcher properties (TD-005)', () => {
  it('at-least-once delivery plus idempotent handlers gives exactly-once effects', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const { ledger } = await runScenario(scenario);
        const keys = ledger.map((effect) => `${effect.position}:${effect.handler}`);
        expect(new Set(keys).size).toBe(keys.length);
      }),
      { numRuns: 200 },
    );
  });

  it('effects of one stream never go back in stream_seq', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const { ledger } = await runScenario(scenario);
        const highest = new Map<string, number>();
        for (const effect of ledger) {
          const seen = highest.get(effect.stream) ?? 0;
          // Handlers of one event share a sequence, so the invariant is monotonicity.
          expect(effect.streamSeq).toBeGreaterThanOrEqual(seen);
          highest.set(effect.stream, effect.streamSeq);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('an event is either marked dispatched or still queued, never both and never neither', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const { memory } = await runScenario(scenario);
        const queued = new Set(memory.pending.map((row) => row.eventPosition));
        for (const event of memory.log) {
          const marked = memory.executions.some(
            (row) =>
              row.eventPosition === event.position &&
              row.handler === DISPATCH_MARKER &&
              row.status === 'succeeded',
          );
          expect(marked).toBe(!queued.has(event.position));
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every handler of a dispatched event reached a terminal status', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const { memory } = await runScenario(scenario);
        const markers = memory.executions.filter(
          (row) => row.handler === DISPATCH_MARKER && row.status === 'succeeded',
        );
        for (const marker of markers) {
          const handlers = memory.executions.filter(
            (row) => row.eventPosition === marker.eventPosition && row.handler !== DISPATCH_MARKER,
          );
          expect(handlers).toHaveLength(scenario.handlers.length);
          for (const row of handlers) {
            expect(['succeeded', 'stopped']).toContain(row.status);
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('every committed effect belongs to an event that really is in the log', async () => {
    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        const { ledger, memory } = await runScenario(scenario);
        const positions = new Set(memory.log.map((event) => event.position));
        for (const effect of ledger) {
          expect(positions.has(effect.position)).toBe(true);
        }
      }),
      { numRuns: 100 },
    );
  });
});
