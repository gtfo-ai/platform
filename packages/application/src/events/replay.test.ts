/**
 * The backfill: a handler registered *after* the events it needs were already dispatched.
 *
 * This is WP-19's third acceptance criterion at the unit tier — *"a run that finished before the
 * ledger's handler was registered appears in the rollups after a backfill"* — driven the way the
 * criterion words it: append `run.finished` with **no** ledger handler registered, let the
 * dispatcher complete it (which deletes the queue row and writes the `$dispatch` marker, exactly as
 * production does), then register the ledger and replay the range.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { costHandlers } from '../cost/runtime.js';
import { createMemoryCostStore } from '../testing/memory-cost.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { testClock, testIds } from '../testing/pipeline-harness.js';
import { EventBus } from './event-bus.js';
import type { EventHandler } from './handler.js';
import { replayEvents, replayTypesOf } from './replay.js';

const ORG = '00000000-0000-4000-8000-00000000e001' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const RUN = '00000000-0000-4000-8000-0000000000d1' as Id;

const runFinished = (seq: number, usd: number): DomainEvent =>
  domainEventSchemasByType['run.finished'].parse({
    id: `00000000-0000-4000-9000-${seq.toString(16).padStart(12, '0')}`,
    stream_type: 'run',
    stream_id: RUN,
    stream_seq: seq,
    correlation_id: TASK,
    cause_event_id: null,
    actor: { kind: 'system', component: 'runner' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'run.finished',
    payload: {
      project_id: PROJECT,
      task_id: TASK,
      run_id: RUN,
      status: 'completed',
      terminal_reason: 'success',
      usage: {
        input_tokens: 10,
        output_tokens: 5,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
      },
      model_usage: [],
      cost: { usd, is_estimate: false, price_list_id: null },
      num_turns: 1,
      wall_ms: 1000,
    },
  }) as DomainEvent;

const ledgerWorld = () => {
  const memory = new MemoryEventing();
  const store = createMemoryCostStore();
  const ids = testIds();
  const clock = testClock();
  store.seedRun({
    runId: RUN,
    taskId: TASK,
    projectId: PROJECT,
    orgId: ORG,
    template: 'feature',
    stage: 'implementation',
    model: 'claude-opus-5',
    startedAt: '2026-06-01T08:50:00.000Z',
  });
  const handlers = costHandlers({
    store,
    context: (correlationId, causeEventId) => ({
      ids,
      actor: { kind: 'system', component: 'cost-ledger' },
      clock: { now: () => clock.now() },
      correlationId,
      causeEventId,
    }),
  });
  return { memory, store, handlers };
};

/** Dispatches everything queued, with whatever is registered on `bus` — production's shape. */
const drain = async (memory: MemoryEventing, bus: EventBus): Promise<void> => {
  for (let guard = 0; guard < 50; guard += 1) {
    const next = memory.pending[0];
    if (next === undefined) {
      return;
    }
    const stored = memory.log.find((row) => row.position === next.eventPosition);
    if (stored === undefined) {
      return;
    }
    await bus.dispatch(stored);
  }
  throw new Error('drain did not finish');
};

describe('replayEvents — the backfill the outbox sweep made necessary', () => {
  it('charges a run that finished before the ledger existed', async () => {
    const world = ledgerWorld();
    // ── the world before this work package: nothing consumes `run.finished` ──
    const sweeper = new EventBus({ unitOfWork: world.memory });
    await world.memory.transaction(async (scope) =>
      scope.events.append([runFinished(1, 2.5), runFinished(2, 1.5)]),
    );
    await drain(world.memory, sweeper);
    expect(await world.memory.store.countPendingDispatch()).toBe(0);
    expect(world.store.entries).toEqual([]);

    // ── the handler is registered afterwards, and the log is replayed ──
    const report = await replayEvents(
      { store: world.memory.store, unitOfWork: world.memory },
      { handlers: world.handlers },
    );

    expect(report.scanned).toBe(2);
    expect(report.applied).toBe(2);
    expect(report.failures).toEqual([]);
    expect(world.store.entries.map((entry) => entry.usd)).toEqual([2.5, 1.5]);
    expect(world.store.rollups.reduce((sum, row) => sum + row.usd, 0)).toBeCloseTo(4, 6);
  });

  it('is idempotent: a second pass charges nothing again', async () => {
    const world = ledgerWorld();
    await world.memory.transaction(async (scope) => scope.events.append([runFinished(1, 2.5)]));
    const options = { store: world.memory.store, unitOfWork: world.memory };
    await replayEvents(options, { handlers: world.handlers });
    const second = await replayEvents(options, { handlers: world.handlers });

    expect(second.applied).toBe(0);
    expect(second.skipped).toBe(1);
    expect(world.store.entries).toHaveLength(1);
  });

  it('skips an event the dispatcher already ran the same handler for', async () => {
    const world = ledgerWorld();
    const bus = new EventBus({ unitOfWork: world.memory });
    for (const handler of world.handlers) {
      bus.register(handler);
    }
    await world.memory.transaction(async (scope) => scope.events.append([runFinished(1, 2.5)]));
    await drain(world.memory, bus);
    expect(world.store.entries).toHaveLength(1);

    const report = await replayEvents(
      { store: world.memory.store, unitOfWork: world.memory },
      { handlers: world.handlers },
    );
    expect(report).toMatchObject({ scanned: 1, applied: 0, skipped: 1 });
    expect(world.store.entries).toHaveLength(1);
  });

  it('honours the position range, so an operator can resume', async () => {
    const world = ledgerWorld();
    await world.memory.transaction(async (scope) =>
      scope.events.append([runFinished(1, 1), runFinished(2, 2), runFinished(3, 4)]),
    );
    const options = { store: world.memory.store, unitOfWork: world.memory };
    const first = await replayEvents(options, { handlers: world.handlers, toPosition: 2 });
    expect(first.applied).toBe(2);
    expect(world.store.entries.map((entry) => entry.usd)).toEqual([1, 2]);

    const rest = await replayEvents(options, {
      handlers: world.handlers,
      fromPosition: first.lastPosition,
    });
    expect(rest.applied).toBe(1);
    expect(world.store.entries.map((entry) => entry.usd)).toEqual([1, 2, 4]);
  });

  it('pages, so a range larger than one batch is not silently truncated', async () => {
    const world = ledgerWorld();
    await world.memory.transaction(async (scope) =>
      scope.events.append([1, 2, 3, 4, 5].map((seq) => runFinished(seq, 1))),
    );
    const report = await replayEvents(
      { store: world.memory.store, unitOfWork: world.memory },
      { handlers: world.handlers, batchSize: 2 },
    );
    expect(report).toMatchObject({ scanned: 5, applied: 5 });
    expect(world.store.entries).toHaveLength(5);
  });

  it('stops at the first failure and reports where to resume from', async () => {
    const world = ledgerWorld();
    await world.memory.transaction(async (scope) =>
      scope.events.append([runFinished(1, 1), runFinished(2, 2), runFinished(3, 4)]),
    );
    let seen = 0;
    const exploding: EventHandler = {
      name: 'test.explodes',
      priority: 10,
      eventTypes: ['run.finished'],
      handle: async () => {
        seen += 1;
        if (seen === 2) {
          throw new Error('the projection is broken');
        }
      },
    };
    const report = await replayEvents(
      { store: world.memory.store, unitOfWork: world.memory },
      { handlers: [exploding] },
    );
    expect(report.applied).toBe(1);
    expect(report.lastPosition).toBe(1);
    expect(report.failures).toEqual([
      { position: 2, handler: 'test.explodes', error: 'Error: the projection is broken' },
    ]);
  });

  it('reads only the types its handlers want', async () => {
    expect(
      replayTypesOf([{ name: 'a', priority: 1, eventTypes: 'all', handle: async () => {} }]),
    ).toBeUndefined();
    const types = replayTypesOf([
      { name: 'a', priority: 1, eventTypes: ['run.finished'], handle: async () => {} },
      {
        name: 'b',
        priority: 2,
        eventTypes: ['run.finished', 'run.failed'],
        handle: async () => {},
      },
    ]);
    expect([...(types ?? [])].sort()).toEqual(['run.failed', 'run.finished']);
  });

  it('leaves the events a replayed handler emits for the outbox', async () => {
    const world = ledgerWorld();
    world.store.seedBudget({
      id: '00000000-0000-4000-8000-0000000000f1' as Id,
      scope: 'project',
      scopeId: PROJECT,
      projectId: PROJECT,
      window: 'month',
      limitUsd: 1,
      notifyPct: [50],
    });
    await world.memory.transaction(async (scope) => scope.events.append([runFinished(1, 2.5)]));
    await replayEvents(
      { store: world.memory.store, unitOfWork: world.memory },
      { handlers: world.handlers },
    );
    // The budget was blown through, so the fold emitted; the events are appended and **queued**,
    // which is what makes the outbox the one thing that dispatches them.
    const emitted = world.memory.log.map((row) => row.event.type);
    expect(emitted).toContain('budget.threshold.reached');
    expect(emitted).toContain('budget.exhausted');
    expect(await world.memory.store.countPendingDispatch()).toBeGreaterThan(0);
  });
});
