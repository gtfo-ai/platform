/**
 * The late cost: the money a run that somebody else ended still owes (WP-47, Q70 (b), backlog 50).
 *
 * Driven against the **real** in-memory cost store and the real ledger body, because the claim the
 * work package makes is not "a method was called" — it is that the tokens reach `cost_entries`, the
 * rollup **and** the budgets, which are three different tables and three different ways of losing
 * the same money. WP-19's own invariant cannot catch this (standing rule 79): `sum(entries) =
 * sum(rollup)` is true and blind for a run that contributes nothing to either.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import type { RunRepository } from '../pipeline/store.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import { createMemoryCostStore, type MemoryCostStore } from '../testing/memory-cost.js';
import { createLateCostRecorder, noLateCostRecorder } from './late.js';

const RUN = '00000000-0000-4000-8000-0000000000e1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000d1' as Id;
const PROJECT = '00000000-0000-4000-8000-0000000000a1' as Id;
const ORG = '00000000-0000-4000-8000-0000000000b1' as Id;
const BUDGET = '00000000-0000-4000-8000-0000000000c1' as Id;
const AT = '2026-09-15T10:00:00.000Z' as IsoDateTime;

/** What the process that ran the session measured — a real attempt, not a zero. */
const MEASURED = {
  runId: RUN,
  sessionId: 'session-1',
  numTurns: 7,
  usage: {
    input_tokens: 1_000,
    output_tokens: 500,
    cache_write_5m_tokens: 0,
    cache_write_1h_tokens: 0,
    cache_read_tokens: 0,
  },
  modelUsage: [],
  cost: { usd: 2.5, is_estimate: false, price_list_id: null },
  wallMs: 120_000,
};

const scope = {
  tx: { adapter: 'memory' },
  events: { append: async () => [] },
} as unknown as TransactionScope;

const seededStore = (): MemoryCostStore => {
  const store = createMemoryCostStore();
  store.seedTask({ id: TASK, projectId: PROJECT });
  store.seedPrice({
    modelId: 'claude-opus-5',
    priceListId: '00000000-0000-4000-8000-00000000c001' as Id,
    effectiveFrom: '2026-01-01T00:00:00.000Z' as IsoDateTime,
    input: 15,
    output: 75,
    cacheWrite5m: 18.75,
    cacheWrite1h: 30,
    cacheRead: 1.5,
  });
  store.seedBudget({
    id: BUDGET,
    scope: 'project',
    scopeId: PROJECT,
    projectId: PROJECT,
    window: 'day',
    limitUsd: 100,
    notifyPct: [80],
  });
  return store;
};

const runs = (recorded: boolean, calls: { count: number }): RunRepository =>
  ({
    recordCost: async () => {
      calls.count += 1;
      return recorded;
    },
  }) as unknown as RunRepository;

const recorderOver = (store: MemoryCostStore, recorded: boolean) => {
  const calls = { count: 0 };
  store.seedTimezone(PROJECT, 'UTC');
  const recorder = createLateCostRecorder({
    store,
    runs: runs(recorded, calls),
    context: (correlationId, causeEventId) => ({
      ids: { next: () => '00000000-0000-4000-8000-0000000000f1' as Id },
      actor: { kind: 'system', component: 'cost-ledger' },
      clock: { now: () => AT },
      correlationId,
      causeEventId,
    }),
  });
  return { recorder, calls };
};

describe('the late cost recorder', () => {
  it('charges the entries, the rollup and the budget — all three, because losing any one loses the money', async () => {
    const store = seededStore();
    store.seedRun({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: ORG,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      startedAt: AT,
    });
    const { recorder, calls } = recorderOver(store, true);

    const outcome = await recorder.record(scope, MEASURED, AT);

    expect(calls.count).toBe(1);
    expect(outcome.recorded).toBe(true);
    expect(outcome.charge?.entries).toBe(1);
    // The provider's figure is the truth (BD-011), so the entry sums to what the runner reported
    // rather than to what the price table would have guessed.
    expect(store.entries.map((entry) => entry.usd)).toEqual([2.5]);
    expect(store.rollups.map((delta) => delta.usd)).toEqual([2.5]);
    expect(store.windows.map((window) => window.spentUsd)).toEqual([2.5]);
  });

  it('labels the rows `late`, so a reconciliation can tell a correction from the original charge', async () => {
    const store = seededStore();
    store.seedRun({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: ORG,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      startedAt: AT,
    });
    const { recorder } = recorderOver(store, true);

    await recorder.record(scope, MEASURED, AT);

    expect(store.entries.map((entry) => entry.late)).toEqual([true]);
  });

  it('charges nothing when the row refuses the write, which is what makes a repeat a no-op', async () => {
    const store = seededStore();
    store.seedRun({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: ORG,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      startedAt: AT,
    });
    const { recorder } = recorderOver(store, false);

    const outcome = await recorder.record(scope, MEASURED, AT);

    expect(outcome).toEqual({ recorded: false, charge: null });
    // Not "one fewer entry": **none**, and no rollup and no budget movement either. A recorder that
    // charged on the refused path would double every cancelled run's spend on a job retry.
    expect(store.entries).toHaveLength(0);
    expect(store.rollups).toHaveLength(0);
    expect(store.windows).toHaveLength(0);
  });

  it('is absent-shaped rather than throwing when a composition has no ledger', async () => {
    // A deployment with no cost store composes this, and the assertion is which one ran (standing
    // rule 10): the outcome says nothing was recorded, rather than the caller having to know.
    await expect(noLateCostRecorder.record(scope, MEASURED, AT)).resolves.toEqual({
      recorded: false,
      charge: null,
    });
  });
});
