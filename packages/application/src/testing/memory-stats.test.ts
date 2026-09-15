/**
 * The in-memory statistics store's own divergences, as **assertions** rather than as warnings.
 *
 * Standing rule 12: the place a fake is most permissive is the place a later work package leans
 * hardest, so each entry in its register gets a test that says so out loud.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createMemoryStatsStore } from './memory-stats.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const TX = { adapter: 'memory' } as never;
const AT = '2026-06-01T09:00:00.000Z' as IsoDateTime;

describe('the memory statistics store', () => {
  it('divergence 1: a transaction handle is accepted and ignored, so writes survive a rollback', async () => {
    // Stated as a test rather than as a warning, because it is the reason the same contract suite
    // runs against PostgreSQL: nothing in this file can fail the way a real transaction can.
    const store = createMemoryStatsStore();
    await store.recordDelivery(TX, { taskId: TASK, projectId: PROJECT, mergedAt: AT });
    expect(store.deliveries).toHaveLength(1);
  });

  it('divergence 2: it accepts ids no row has, which PostgreSQL refuses', async () => {
    const store = createMemoryStatsStore();
    await store.addCounter(TX, {
      projectId: '00000000-0000-4000-8000-00000000dead' as Id,
      day: '2026-06-01',
      metric: 'rebase.clean',
      count: 1,
      total: 0,
    });
    expect(store.counters).toHaveLength(1);
  });

  it('divergence 4: what a caller read back cannot be mutated into the store', async () => {
    const store = createMemoryStatsStore();
    await store.addCounter(TX, {
      projectId: PROJECT,
      day: '2026-06-01',
      metric: 'rebase.clean',
      count: 1,
      total: 0,
    });
    const [row] = store.counters;
    if (row !== undefined) {
      (row as { count: number }).count = 99;
    }
    expect(store.counters.map((entry) => entry.count)).toEqual([1]);
  });

  it('divergence 5: an unseeded project has no timezone, where a database answers UTC', async () => {
    const store = createMemoryStatsStore();
    expect(await store.organisationTimezone(TX, PROJECT)).toBeNull();
    store.seedTimezone(PROJECT, 'Europe/Prague');
    expect(await store.organisationTimezone(TX, PROJECT)).toBe('Europe/Prague');
  });
});
