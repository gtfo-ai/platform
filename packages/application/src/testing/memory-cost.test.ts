/**
 * The in-memory cost store's own divergences, as **assertions** rather than as warnings.
 *
 * Standing rule 12: the place a fake is most permissive is the place a later work package leans
 * hardest, so each entry in its register that is kinder than PostgreSQL gets a test that says so.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { CostStoreError, createMemoryCostStore } from './memory-cost.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const RUN = '00000000-0000-4000-8000-0000000000d1' as Id;
const BUDGET = '00000000-0000-4000-8000-0000000000f1' as Id;
const TX = { adapter: 'memory' } as never;
const WINDOW = '2026-06-01T00:00:00.000Z' as IsoDateTime;

describe('the memory cost store', () => {
  it('divergence 5: hands out clones, so a caller cannot mutate what it read', async () => {
    const store = createMemoryCostStore();
    store.seedRun({
      runId: RUN,
      taskId: TASK,
      projectId: PROJECT,
      orgId: PROJECT,
      template: 'feature',
      stage: 'implementation',
      model: 'claude-opus-5',
      startedAt: null,
    });
    const first = await store.runContext(TX, RUN);
    (first as { model: string }).model = 'tampered';
    expect((await store.runContext(TX, RUN))?.model).toBe('claude-opus-5');
  });

  it('divergence 4: refuses to estimate a task it has never seen', async () => {
    const store = createMemoryCostStore();
    await expect(
      store.saveEstimate(TX, TASK, { size: 'M', estimateUsd: 1 }),
    ).rejects.toBeInstanceOf(CostStoreError);
  });

  it('divergence 6: the budget sequence advances by the events a fold emits', async () => {
    const store = createMemoryCostStore();
    store.seedBudget({
      id: BUDGET,
      scope: 'project',
      scopeId: PROJECT,
      projectId: PROJECT,
      window: 'month',
      limitUsd: 10,
      notifyPct: [50],
    });
    const windowStartOf = () => WINDOW;
    const before = await store.budgets.applicable(
      TX,
      { projectId: PROJECT, taskId: null },
      windowStartOf,
    );
    expect(before[0]?.sequence).toBe(1);

    // Under the limit and under the threshold: nothing was emitted, so nothing advances.
    await store.budgets.saveWindow(TX, {
      budgetId: BUDGET,
      windowStart: WINDOW,
      spentUsd: 1,
      notifiedPct: [],
    });
    const quiet = await store.budgets.applicable(
      TX,
      { projectId: PROJECT, taskId: null },
      windowStartOf,
    );
    expect(quiet[0]?.sequence).toBe(1);

    // Past 50 % and past the limit: two events, so the stream is two further along.
    await store.budgets.saveWindow(TX, {
      budgetId: BUDGET,
      windowStart: WINDOW,
      spentUsd: 11,
      notifiedPct: [50],
    });
    const loud = await store.budgets.applicable(
      TX,
      { projectId: PROJECT, taskId: null },
      windowStartOf,
    );
    expect(loud[0]?.sequence).toBe(3);
  });

  it('divergence 1: keeps writes a rolled-back scope made, which PostgreSQL does not', async () => {
    const store = createMemoryCostStore();
    await store.appendEntries(TX, [
      {
        runId: RUN,
        taskId: TASK,
        projectId: PROJECT,
        orgId: PROJECT,
        template: 'feature',
        stage: 'implementation',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        usd: 1,
        isEstimate: false,
        priceListId: null,
        usdReported: 1,
        usdEstimated: null,
        primary: true,
      },
    ]);
    // There is no rollback to perform: the handle is ignored. Stating it as a test is the point —
    // it is why the same suite runs against PostgreSQL in `test/integration/cost/`.
    expect(store.entries).toHaveLength(1);
  });

  it('divergence 2: accepts a ledger row for a month PostgreSQL would have no partition for', async () => {
    const store = createMemoryCostStore();
    await store.applyRollups(TX, [
      {
        orgId: PROJECT,
        projectId: PROJECT,
        template: 'feature',
        stage: 'implementation',
        model: 'claude-opus-5',
        day: '1999-01-01',
        mode: 'actual',
        runs: 1,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_write_5m_tokens: 0,
          cache_write_1h_tokens: 0,
          cache_read_tokens: 0,
        },
        usd: 1,
        wallMs: 0,
        turns: 0,
      },
    ]);
    expect(store.rollups).toHaveLength(1);
  });
});
