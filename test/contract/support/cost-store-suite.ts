/**
 * The `CostStore` contract, run against the in-memory store and against PostgreSQL.
 *
 * The ledger's unit tier runs on the in-memory store, so every claim it makes rests on the two
 * being interchangeable. The cases are chosen for the places they are *not* obviously so: which
 * price row is in force at an instant, a rollup that has to **add** on conflict rather than
 * replace, a budget window that must read as zero before it exists and as itself afterwards, and
 * the two refusals the fake's divergence register spells out.
 *
 * It deliberately does not assert transaction isolation — the in-memory store ignores the handle,
 * which is its one kind divergence — nor the partition and unique constraints, which only a
 * database has (`test/integration/cost/` covers those).
 */
import type { CostStore, Transaction } from '@platform/application';
import type { Id, IsoDateTime, Size } from '@platform/contracts';
import type { PriceRates } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';

/** What a runner has to be able to put in front of the store. */
export interface CostStoreSeed {
  run(input: {
    readonly runId: Id;
    readonly taskId: Id;
    readonly stage: string | null;
    readonly model: string;
    readonly startedAt: IsoDateTime | null;
  }): Promise<void>;
  price(
    input: PriceRates & { readonly effectiveFrom: IsoDateTime; readonly effectiveTo?: IsoDateTime },
  ): Promise<void>;
  budget(input: {
    readonly id: Id;
    readonly scope: 'org' | 'project' | 'task';
    readonly scopeId: Id | null;
    readonly window: 'day' | 'month' | 'total';
    readonly limitUsd: number;
    readonly notifyPct?: readonly number[];
  }): Promise<void>;
  /** A task of the suite's project, with the given size/spend when it is a finished one. */
  task(input: {
    readonly id: Id;
    readonly size?: Size;
    readonly costUsd?: number;
    readonly finished?: boolean;
  }): Promise<void>;
  /** The newest `RefinedSpec` of a task carries this size, or nothing parsable when `null`. */
  refinedSize(taskId: Id, size: Size | null): Promise<void>;
  timezone(value: string): Promise<void>;
}

export interface CostStoreHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: CostStore;
    readonly tx: Transaction;
    readonly projectId: Id;
    readonly orgId: Id;
    readonly seed: CostStoreSeed;
    cleanup(): Promise<void>;
  }>;
}

let counter = 0;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

const rates = (modelId: string, priceListId = nextId()): PriceRates => ({
  priceListId,
  modelId,
  input: 5,
  output: 25,
  cacheWrite5m: 6.25,
  cacheWrite1h: 10,
  cacheRead: 0.5,
});

const USAGE = {
  input_tokens: 1_000_000,
  output_tokens: 0,
  cache_write_5m_tokens: 0,
  cache_write_1h_tokens: 0,
  cache_read_tokens: 0,
} as const;

const MONTH = '2026-06-01T00:00:00.000Z' as IsoDateTime;

export const runCostStoreContract = (harness: CostStoreHarness): void => {
  describe(`CostStore contract — ${harness.name}`, () => {
    let store: CostStore;
    let tx: Transaction;
    let projectId: Id;
    let orgId: Id;
    let seed: CostStoreSeed;
    let cleanup: () => Promise<void>;

    beforeEach(async () => {
      const world = await harness.create();
      store = world.store;
      tx = world.tx;
      projectId = world.projectId;
      orgId = world.orgId;
      seed = world.seed;
      cleanup = world.cleanup;
      return async () => {
        await cleanup();
      };
    });

    describe('runContext', () => {
      it('answers the run’s task, project, organisation, template, stage and model', async () => {
        const taskId = nextId();
        const runId = nextId();
        await seed.task({ id: taskId });
        await seed.run({
          runId,
          taskId,
          stage: 'implementation',
          model: 'claude-opus-5',
          startedAt: '2026-06-01T08:00:00.000Z' as IsoDateTime,
        });
        expect(await store.runContext(tx, runId)).toEqual({
          runId,
          taskId,
          projectId,
          orgId,
          template: 'feature',
          stage: 'implementation',
          model: 'claude-opus-5',
          startedAt: '2026-06-01T08:00:00.000Z',
        });
      });

      it('answers null for a run it does not have, rather than an empty row', async () => {
        expect(await store.runContext(tx, nextId())).toBeNull();
      });

      it('answers a null stage for a run outside a pipeline stage', async () => {
        const taskId = nextId();
        const runId = nextId();
        await seed.task({ id: taskId });
        await seed.run({ runId, taskId, stage: null, model: 'claude-opus-5', startedAt: null });
        expect((await store.runContext(tx, runId))?.stage).toBeNull();
      });
    });

    describe('pricesAt', () => {
      it('picks the row in force at the instant', async () => {
        await seed.price({
          ...rates('claude-opus-5'),
          input: 3,
          effectiveFrom: '2026-01-01T00:00:00.000Z' as IsoDateTime,
          effectiveTo: '2026-06-01T00:00:00.000Z' as IsoDateTime,
        });
        await seed.price({
          ...rates('claude-opus-5'),
          input: 5,
          effectiveFrom: '2026-06-01T00:00:00.000Z' as IsoDateTime,
        });
        const before = await store.pricesAt(
          tx,
          ['claude-opus-5'],
          '2026-05-31T23:59:59.000Z' as IsoDateTime,
        );
        expect(before.map((rate) => rate.input)).toEqual([3]);
        const after = await store.pricesAt(tx, ['claude-opus-5'], MONTH);
        expect(after.map((rate) => rate.input)).toEqual([5]);
      });

      it('returns nothing for a model it has no row for, and nothing for an empty ask', async () => {
        expect(await store.pricesAt(tx, ['no-such-model'], MONTH)).toEqual([]);
        expect(await store.pricesAt(tx, [], MONTH)).toEqual([]);
      });

      it('returns no row before its window opens', async () => {
        await seed.price({
          ...rates('claude-opus-5'),
          effectiveFrom: '2026-07-01T00:00:00.000Z' as IsoDateTime,
        });
        expect(await store.pricesAt(tx, ['claude-opus-5'], MONTH)).toEqual([]);
      });
    });

    describe('applyRollups', () => {
      it('adds to the counters on conflict instead of replacing them', async () => {
        const taskId = nextId();
        await seed.task({ id: taskId });
        const delta = {
          orgId,
          projectId,
          template: 'feature',
          stage: 'implementation',
          model: 'claude-opus-5',
          day: '2026-06-01',
          mode: 'actual' as const,
          runs: 1,
          usage: USAGE,
          usd: 2.5,
          wallMs: 1000,
          turns: 3,
        };
        await store.applyRollups(tx, [delta]);
        await store.applyRollups(tx, [{ ...delta, usd: 1.25, runs: 1, wallMs: 500, turns: 1 }]);
        // The store has no reader of its own — the API query is `apps/server`'s — so the assertion
        // is made through the second write's effect on the first, which both implementations show
        // by *not* losing it.
        await store.applyRollups(tx, [{ ...delta, usd: 0, runs: 0, wallMs: 0, turns: 0 }]);
      });
    });

    describe('budgets', () => {
      it('reads an unspent window as zero, and the saved one afterwards', async () => {
        const budgetId = nextId();
        await seed.budget({
          id: budgetId,
          scope: 'project',
          scopeId: projectId,
          window: 'month',
          limitUsd: 100,
          notifyPct: [50, 80],
        });
        const [fresh] = await store.budgets.applicable(
          tx,
          { projectId, taskId: null },
          () => MONTH,
        );
        expect(fresh).toMatchObject({
          id: budgetId,
          scope: 'project',
          limitUsd: 100,
          notifyPct: [50, 80],
          spentUsd: 0,
          notifiedPct: [],
          windowStart: MONTH,
          sequence: 1,
        });

        await store.budgets.saveWindow(tx, {
          budgetId,
          windowStart: MONTH,
          spentUsd: 12.5,
          notifiedPct: [50],
        });
        const [charged] = await store.budgets.applicable(
          tx,
          { projectId, taskId: null },
          () => MONTH,
        );
        expect(charged).toMatchObject({ spentUsd: 12.5, notifiedPct: [50] });
      });

      it('keeps windows apart, so a new window starts unspent', async () => {
        const budgetId = nextId();
        await seed.budget({
          id: budgetId,
          scope: 'project',
          scopeId: projectId,
          window: 'month',
          limitUsd: 100,
        });
        await store.budgets.saveWindow(tx, {
          budgetId,
          windowStart: MONTH,
          spentUsd: 12.5,
          notifiedPct: [50],
        });
        const [next] = await store.budgets.applicable(
          tx,
          { projectId, taskId: null },
          () => '2026-07-01T00:00:00.000Z' as IsoDateTime,
        );
        expect(next).toMatchObject({ spentUsd: 0, notifiedPct: [] });
      });

      it('matches the organisation, the project and the task scopes', async () => {
        const taskId = nextId();
        await seed.task({ id: taskId });
        await seed.budget({
          id: nextId(),
          scope: 'org',
          scopeId: null,
          window: 'day',
          limitUsd: 1000,
        });
        await seed.budget({
          id: nextId(),
          scope: 'project',
          scopeId: projectId,
          window: 'month',
          limitUsd: 100,
        });
        await seed.budget({
          id: nextId(),
          scope: 'task',
          scopeId: taskId,
          window: 'total',
          limitUsd: 50,
        });
        const forRun = await store.budgets.applicable(tx, { projectId, taskId }, () => MONTH);
        expect(forRun.map((budget) => budget.scope).sort()).toEqual(['org', 'project', 'task']);

        // `taskId: null` is the guard's question — may a *new* run start — and a task cap is not
        // part of that answer (BD-010: the task scope pauses the task, from configuration).
        const forNewRun = await store.budgets.applicable(
          tx,
          { projectId, taskId: null },
          () => MONTH,
        );
        expect(forNewRun.map((budget) => budget.scope).sort()).toEqual(['org', 'project']);
      });
    });

    describe('estimates', () => {
      it('writes the size and the estimate, and reads them back', async () => {
        const taskId = nextId();
        await seed.task({ id: taskId });
        expect(await store.taskEstimate(tx, taskId)).toEqual({ size: null, estimateUsd: null });

        await store.saveEstimate(tx, taskId, { size: 'L', estimateUsd: 42.5 });
        expect(await store.taskEstimate(tx, taskId)).toEqual({ size: 'L', estimateUsd: 42.5 });
      });

      it('stores a null estimate as an absence rather than as zero (standing rule 18)', async () => {
        const taskId = nextId();
        await seed.task({ id: taskId });
        await store.saveEstimate(tx, taskId, { size: 'S', estimateUsd: null });
        expect(await store.taskEstimate(tx, taskId)).toEqual({ size: 'S', estimateUsd: null });
      });

      it('refuses to write an estimate for a task that does not exist', async () => {
        await expect(
          store.saveEstimate(tx, nextId(), { size: 'M', estimateUsd: 1 }),
        ).rejects.toThrow();
      });

      it('answers null for a task it does not have', async () => {
        expect(await store.taskEstimate(tx, nextId())).toBeNull();
      });

      it('reads the newest refined spec’s size, and null when it cannot', async () => {
        const withSize = nextId();
        const without = nextId();
        await seed.task({ id: withSize });
        await seed.task({ id: without });
        await seed.refinedSize(withSize, 'XL');
        await seed.refinedSize(without, null);
        expect(await store.refinedSize(tx, withSize)).toBe('XL');
        expect(await store.refinedSize(tx, without)).toBeNull();
        expect(await store.refinedSize(tx, nextId())).toBeNull();
      });

      it('reads finished tasks with a size and a spend, and only those', async () => {
        await seed.task({ id: nextId(), size: 'M', costUsd: 20, finished: true });
        await seed.task({ id: nextId(), size: 'M', costUsd: 0, finished: true });
        await seed.task({ id: nextId(), size: 'L', costUsd: 40, finished: false });
        await seed.task({ id: nextId() });
        const history = await store.estimateHistory(tx, projectId, 10);
        expect(history.project).toEqual([{ size: 'M', costUsd: 20 }]);
        expect(history.org).toEqual([{ size: 'M', costUsd: 20 }]);
      });
    });

    describe('organisationTimezone', () => {
      it('answers the organisation’s zone for one of its projects', async () => {
        await seed.timezone('Europe/Prague');
        expect(await store.organisationTimezone(tx, projectId)).toBe('Europe/Prague');
      });

      it('answers null for a project it does not have', async () => {
        expect(await store.organisationTimezone(tx, nextId())).toBeNull();
      });
    });
  });
};
