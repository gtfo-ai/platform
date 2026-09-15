/**
 * The `StatsStore` contract against the in-memory store (technical/10 contract tier).
 *
 * `test/integration/stats/postgres-stats-store.integration.test.ts` runs the same suite against a
 * real PostgreSQL, which is what makes the projector's unit tier — which runs on this store — a
 * claim about the product rather than about a Map.
 */
import { createMemoryStatsStore } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runStatsStoreContract } from './support/stats-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;

runStatsStoreContract({
  name: 'in-memory',
  create: async () => {
    const store = createMemoryStatsStore();
    // `organizations.timezone` is `not null default 'UTC'`, so an unset organisation answers 'UTC'
    // on a database; the fake is seeded to the same starting point rather than to `null`.
    store.seedTimezone(PROJECT, 'UTC');
    return {
      store,
      tx: { adapter: 'memory' } as never,
      projectId: PROJECT,
      seed: {
        // The fake has no `tasks` table: a delivery's `task_id` is a value it stores, not a row it
        // checks — divergence 2 of its register, asserted there rather than papered over. The
        // merge-request association is a Map here and `tasks.mr_ref` on a database.
        task: async (input) => {
          if (input.mrIid !== undefined) {
            store.seedMergeRequest({ projectId: PROJECT, iid: input.mrIid }, input.id);
          }
        },
        timezone: async (value) => {
          store.seedTimezone(PROJECT, value);
        },
      },
      read: {
        deliveries: async () =>
          store.deliveries.map((row) => ({ taskId: row.taskId, mergedAt: row.mergedAt })),
        counters: async () =>
          store.counters.map((row) => ({
            day: row.day,
            metric: row.metric,
            count: row.count,
            total: row.total,
          })),
      },
      cleanup: async () => {},
    };
  },
});
