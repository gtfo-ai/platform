/**
 * The `ShadowStore` contract against the in-memory double (technical/10 contract tier, WP-34).
 *
 * `test/integration/shadow/postgres-shadow-store.integration.test.ts` runs the same suite against a
 * real PostgreSQL 18, which is what makes the unit tier of the batch command and the report duty —
 * all of which drive this double — a claim about the product rather than about three arrays.
 */
import { createMemoryShadowStore, memoryTransaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runShadowStoreContract } from './support/shadow-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000d1' as Id;
const TASKS = ['00000000-0000-4000-8000-0000000000d2', '00000000-0000-4000-8000-0000000000d3'] as [
  Id,
  Id,
];

let batches = 0;

runShadowStoreContract({
  name: 'in-memory',
  create: async () => ({
    store: createMemoryShadowStore(),
    tx: memoryTransaction,
    projectId: PROJECT,
    taskIds: TASKS,
    nextBatchId: () => {
      batches += 1;
      return `00000000-0000-4000-8000-${batches.toString(16).padStart(12, '0')}` as Id;
    },
    // A fresh double per case, so there is nothing to roll back.
    cleanup: async () => {},
  }),
});
