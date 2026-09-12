/**
 * The estimate handler (product/09 "estimate before spend", Q65).
 *
 * The *model* is asserted in `@platform/domain`'s `cost/estimate.test.ts`; this is about the
 * handler: which artifact wakes it, what it refuses, and that it writes once.
 */
import type { DomainEvent, Id } from '@platform/contracts';
import { domainEventSchemasByType } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { EventBus } from '../events/event-bus.js';
import { createMemoryCostStore, type MemoryCostStore } from '../testing/memory-cost.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { costEstimateHandler } from './estimate.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const RUN = '00000000-0000-4000-8000-0000000000d1' as Id;

let seq = 0;

const artifactCreated = (artifactType: string): DomainEvent => {
  seq += 1;
  return domainEventSchemasByType['artifact.created'].parse({
    id: `00000000-0000-4000-9000-${seq.toString(16).padStart(12, '0')}`,
    stream_type: 'task',
    stream_id: TASK,
    stream_seq: seq,
    correlation_id: TASK,
    cause_event_id: null,
    actor: { kind: 'system', component: 'pipeline' },
    occurred_at: '2026-06-01T09:00:00.000Z',
    type: 'artifact.created',
    payload: {
      project_id: PROJECT,
      task_id: TASK,
      artifact: {
        id: '00000000-0000-4000-8000-0000000000a1',
        artifact_type: artifactType,
        version: 1,
        url: null,
      },
      produced_by_run_id: RUN,
    },
  }) as DomainEvent;
};

const harness = () => {
  seq = 0;
  const memory = new MemoryEventing();
  const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
  const store = createMemoryCostStore();
  store.seedTask({ id: TASK, projectId: PROJECT });
  bus.register(costEstimateHandler({ store }));
  const publish = async (events: readonly DomainEvent[]) => {
    await memory.transaction(async (scope) => scope.events.append(events));
    for (const pending of [...memory.pending]) {
      const stored = memory.log.find((row) => row.position === pending.eventPosition);
      if (stored !== undefined) {
        const result = await bus.dispatch(stored);
        if (result.status === 'failed') {
          throw new Error(`dispatch failed: ${JSON.stringify(result.handlers)}`);
        }
      }
    }
  };
  return { store, publish } satisfies { store: MemoryCostStore; publish: typeof publish };
};

describe('the estimate handler', () => {
  it('estimates a task from the project’s finished tasks when refinement lands', async () => {
    const world = harness();
    world.store.seedRefinedSize(TASK, 'XL');
    world.store.seedHistory(PROJECT, [
      { size: 'M', costUsd: 20 },
      { size: 'M', costUsd: 20 },
    ]);
    await world.publish([artifactCreated('RefinedSpec')]);
    expect(world.store.estimates).toEqual([{ taskId: TASK, size: 'XL', estimateUsd: 80 }]);
  });

  it('records the size with no estimate when nothing has finished yet (rule 16)', async () => {
    const world = harness();
    world.store.seedRefinedSize(TASK, 'S');
    await world.publish([artifactCreated('RefinedSpec')]);
    expect(world.store.estimates).toEqual([{ taskId: TASK, size: 'S', estimateUsd: null }]);
  });

  it('ignores every other artifact type', async () => {
    const world = harness();
    world.store.seedRefinedSize(TASK, 'M');
    await world.publish([artifactCreated('ImplementationPlan')]);
    await world.publish([artifactCreated('ReviewVerdict')]);
    expect(world.store.estimates).toEqual([]);
  });

  it('writes nothing when the refined spec carries no size the platform can read', async () => {
    const world = harness();
    world.store.seedRefinedSize(TASK, null);
    await world.publish([artifactCreated('RefinedSpec')]);
    expect(world.store.estimates).toEqual([]);
  });

  it('fills an estimate a later round can make, and rewrites the size with it', async () => {
    // The task that got a size and no number: its project had no finished task at refinement, so
    // the second round is the first chance to estimate it (and the size comes from the newer spec).
    const world = harness();
    world.store.seedRefinedSize(TASK, 'M');
    await world.publish([artifactCreated('RefinedSpec')]);
    expect(world.store.estimates).toEqual([{ taskId: TASK, size: 'M', estimateUsd: null }]);

    world.store.seedHistory(PROJECT, [{ size: 'M', costUsd: 12 }]);
    world.store.seedRefinedSize(TASK, 'L');
    await world.publish([artifactCreated('RefinedSpec')]);
    expect(world.store.estimates.at(-1)).toEqual({ taskId: TASK, size: 'L', estimateUsd: 24 });
  });

  it('estimates once: a second refinement round does not move the expectation', async () => {
    const world = harness();
    world.store.seedRefinedSize(TASK, 'M');
    world.store.seedHistory(PROJECT, [{ size: 'M', costUsd: 10 }]);
    await world.publish([artifactCreated('RefinedSpec')]);
    world.store.seedHistory(PROJECT, [{ size: 'M', costUsd: 99 }]);
    await world.publish([artifactCreated('RefinedSpec')]);
    expect(world.store.estimates).toEqual([{ taskId: TASK, size: 'M', estimateUsd: 10 }]);
  });

  it('writes nothing for a task the platform does not have', async () => {
    seq = 0;
    const store = createMemoryCostStore();
    store.seedRefinedSize(TASK, 'M');
    const memory = new MemoryEventing();
    const bus = new EventBus({ unitOfWork: memory, retryDelayMs: 0, maxRetryDelayMs: 0 });
    bus.register(costEstimateHandler({ store }));
    await memory.transaction(async (scope) =>
      scope.events.append([artifactCreated('RefinedSpec')]),
    );
    const stored = memory.log[0];
    expect(stored).toBeDefined();
    const result = await bus.dispatch(stored as NonNullable<typeof stored>);
    expect(result.status).toBe('dispatched');
    expect(store.estimates).toEqual([]);
  });
});
