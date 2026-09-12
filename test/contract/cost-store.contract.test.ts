/**
 * The `CostStore` contract against the in-memory store (technical/10 contract tier).
 *
 * `test/integration/cost/postgres-cost-store.integration.test.ts` runs the same suite against a
 * real PostgreSQL, which is what makes the ledger's unit tier — which runs on this store — a claim
 * about the product rather than about a Map.
 */
import { createMemoryCostStore } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runCostStoreContract } from './support/cost-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const ORG = '00000000-0000-4000-8000-00000000e001' as Id;

runCostStoreContract({
  name: 'in-memory',
  create: async () => {
    const store = createMemoryCostStore();
    const history: { size: 'S' | 'M' | 'L' | 'XL'; costUsd: number }[] = [];
    return {
      store,
      tx: { adapter: 'memory' } as never,
      projectId: PROJECT,
      orgId: ORG,
      seed: {
        run: async (input) => {
          store.seedRun({
            runId: input.runId,
            taskId: input.taskId,
            projectId: PROJECT,
            orgId: ORG,
            template: 'feature',
            stage: input.stage,
            model: input.model,
            startedAt: input.startedAt,
          });
        },
        price: async (input) => {
          store.seedPrice(input);
        },
        budget: async (input) => {
          store.seedBudget({
            id: input.id,
            scope: input.scope,
            scopeId: input.scopeId,
            projectId: input.scope === 'org' ? null : PROJECT,
            window: input.window,
            limitUsd: input.limitUsd,
            ...(input.notifyPct === undefined ? {} : { notifyPct: input.notifyPct }),
          });
        },
        task: async (input) => {
          store.seedTask({ id: input.id, projectId: PROJECT });
          if (input.finished === true && input.size !== undefined && (input.costUsd ?? 0) > 0) {
            history.push({ size: input.size, costUsd: input.costUsd as number });
            store.seedHistory(PROJECT, [...history]);
          }
        },
        refinedSize: async (taskId, size) => {
          store.seedRefinedSize(taskId, size);
        },
        timezone: async (value) => {
          store.seedTimezone(PROJECT, value);
        },
      },
      cleanup: async () => {},
    };
  },
});
