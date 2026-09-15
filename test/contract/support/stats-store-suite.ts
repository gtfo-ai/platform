/**
 * The `StatsStore` contract, run against the in-memory store and against PostgreSQL (WP-41).
 *
 * The projector's unit tier runs on the in-memory store, so every claim it makes rests on the two
 * being interchangeable — standing rule 23: a new port obligation lands in the shared suite in the
 * same change, or it is an adapter-local promise.
 *
 * The cases are chosen for the places the two are *not* obviously the same: the counter's upsert
 * **adds** where a naive insert would raise a duplicate key, the delivery's upsert **keeps the
 * first** where a naive one would raise or overwrite, and `numeric`/`bigint` come back from
 * PostgreSQL as strings — which is exactly the shape that turns a sum into a concatenation if an
 * adapter forgets to convert.
 *
 * It deliberately does not assert transaction isolation — the in-memory store ignores the handle,
 * which is its one kind divergence — nor the foreign keys, which only a database has
 * (`test/integration/stats/` covers those).
 */
import type { StatsStore, Transaction } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';

/** What a runner has to be able to put in front of the store. */
export interface StatsStoreSeed {
  /**
   * A task of the suite's project — `stats_task_delivery.task_id` is a foreign key — optionally
   * owning the merge request with this `iid`, which is what `taskForMergeRequest` reads.
   */
  task(input: { readonly id: Id; readonly mrIid?: number }): Promise<void>;
  /** The organisation's timezone setting. */
  timezone(value: string | null): Promise<void>;
}

/** What a runner has to be able to read back, in the shape both stores can produce. */
export interface StatsStoreReader {
  deliveries(): Promise<readonly { taskId: Id; mergedAt: IsoDateTime }[]>;
  counters(): Promise<readonly { day: string; metric: string; count: number; total: number }[]>;
}

export interface StatsStoreHarness {
  readonly name: string;
  create(): Promise<{
    readonly store: StatsStore;
    readonly tx: Transaction;
    readonly projectId: Id;
    readonly seed: StatsStoreSeed;
    readonly read: StatsStoreReader;
    cleanup(): Promise<void>;
  }>;
}

let counter = 0x2000;
const nextId = (): Id => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, '0')}` as Id;
};

const at = (iso: string): IsoDateTime => iso as IsoDateTime;

export const runStatsStoreContract = (harness: StatsStoreHarness): void => {
  describe(`StatsStore contract (${harness.name})`, () => {
    it('records a delivery and reads it back at the instant it was given', async () => {
      const context = await harness.create();
      try {
        const taskId = nextId();
        await context.seed.task({ id: taskId });
        await context.store.recordDelivery(context.tx, {
          taskId,
          projectId: context.projectId,
          mergedAt: at('2026-06-01T09:15:00.000Z'),
        });

        expect(await context.read.deliveries()).toEqual([
          { taskId, mergedAt: '2026-06-01T09:15:00.000Z' },
        ]);
      } finally {
        await context.cleanup();
      }
    });

    it('keeps the first merge and does not raise on the second', async () => {
      const context = await harness.create();
      try {
        const taskId = nextId();
        await context.seed.task({ id: taskId });
        const record = (mergedAt: string) =>
          context.store.recordDelivery(context.tx, {
            taskId,
            projectId: context.projectId,
            mergedAt: at(mergedAt),
          });
        await record('2026-06-01T09:15:00.000Z');
        // A second call must be a no-op rather than an error: the projector makes it on a merge
        // request that was reopened and merged again, and a throw would park the task's stream.
        await record('2026-06-03T11:00:00.000Z');

        expect(await context.read.deliveries()).toEqual([
          { taskId, mergedAt: '2026-06-01T09:15:00.000Z' },
        ]);
      } finally {
        await context.cleanup();
      }
    });

    it('adds to a counter rather than replacing or refusing it', async () => {
      const context = await harness.create();
      try {
        const add = (count: number, total: number) =>
          context.store.addCounter(context.tx, {
            projectId: context.projectId,
            day: '2026-06-01',
            metric: 'conflict.warned',
            count,
            total,
          });
        await add(1, 4);
        await add(1, 9);

        // 13, not 9 and not "49": `numeric` arrives from PostgreSQL as a string, and an adapter
        // that forgot to convert would concatenate here and pass every in-memory test.
        expect(await context.read.counters()).toEqual([
          { day: '2026-06-01', metric: 'conflict.warned', count: 2, total: 13 },
        ]);
      } finally {
        await context.cleanup();
      }
    });

    it('keeps days and metrics apart', async () => {
      const context = await harness.create();
      try {
        for (const [day, metric] of [
          ['2026-06-01', 'rebase.clean'],
          ['2026-06-01', 'rebase.resolved'],
          ['2026-06-02', 'rebase.clean'],
        ] as const) {
          await context.store.addCounter(context.tx, {
            projectId: context.projectId,
            day,
            metric,
            count: 1,
            total: 0,
          });
        }

        expect(
          (await context.read.counters()).map((row) => `${row.day} ${row.metric} ${row.count}`),
        ).toEqual([
          '2026-06-01 rebase.clean 1',
          '2026-06-01 rebase.resolved 1',
          '2026-06-02 rebase.clean 1',
        ]);
      } finally {
        await context.cleanup();
      }
    });

    it('finds the task that owns a merge request, and answers null for one nobody owns', async () => {
      const context = await harness.create();
      try {
        const taskId = nextId();
        await context.seed.task({ id: taskId, mrIid: 77 });

        expect(
          await context.store.taskForMergeRequest(context.tx, {
            projectId: context.projectId,
            iid: 77,
          }),
        ).toBe(taskId);
        // A human-authored merge request: not an error, not a delivery (standing rule 42 — the
        // boundary asserted from both sides).
        expect(
          await context.store.taskForMergeRequest(context.tx, {
            projectId: context.projectId,
            iid: 404,
          }),
        ).toBeNull();
      } finally {
        await context.cleanup();
      }
    });

    it('answers the organisation’s timezone, and its absence', async () => {
      const context = await harness.create();
      try {
        await context.seed.timezone('Europe/Prague');
        expect(await context.store.organisationTimezone(context.tx, context.projectId)).toBe(
          'Europe/Prague',
        );
        // A project that does not exist is not an error: `resolveBudgetTimezone` turns `null` into
        // UTC, which is what an unset setting already means (Q12).
        expect(await context.store.organisationTimezone(context.tx, nextId())).toBeNull();
      } finally {
        await context.cleanup();
      }
    });
  });
};
