/**
 * The `HistoryBootstrapStore` contract against the in-memory double (technical/10 contract tier,
 * WP-35).
 *
 * `test/integration/bootstrap/postgres-history-bootstrap-store.integration.test.ts` runs the same
 * suite against a real PostgreSQL 18, which is what makes the unit tier of the start command, the
 * collection and the recorder — all of which drive this double — a claim about the product rather
 * than about two arrays.
 */
import { createMemoryHistoryBootstrapStore, memoryTransaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runHistoryBootstrapStoreContract } from './support/history-bootstrap-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e1' as Id;
const TASKS = ['00000000-0000-4000-8000-0000000000e2', '00000000-0000-4000-8000-0000000000e3'] as [
  Id,
  Id,
];

let ids = 0;

runHistoryBootstrapStoreContract({
  name: 'in-memory',
  create: async () => ({
    store: createMemoryHistoryBootstrapStore(),
    tx: memoryTransaction,
    projectId: PROJECT,
    taskIds: TASKS,
    nextId: () => {
      ids += 1;
      return `00000000-0000-4000-8000-${ids.toString(16).padStart(12, '0')}` as Id;
    },
    // A fresh double per case, so there is nothing to roll back.
    cleanup: async () => {},
  }),
});
