/**
 * The `ReadinessStore` contract against the in-memory double (technical/10 contract tier, WP-21).
 *
 * `test/integration/knowledge/postgres-readiness-store.integration.test.ts` runs the same suite
 * against a real PostgreSQL 18, which is what makes the unit tier of the discovery record job — all
 * of which drives this double — a claim about the product rather than about two arrays.
 */
import { memoryReadinessStore, memoryTransaction } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runReadinessStoreContract } from './support/readiness-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000e1' as Id;
const OTHER_PROJECT = '00000000-0000-4000-8000-0000000000e2' as Id;

runReadinessStoreContract({
  name: 'in-memory',
  create: async () => {
    const store = memoryReadinessStore();
    return {
      store,
      tx: memoryTransaction,
      projectId: PROJECT,
      otherProjectId: OTHER_PROJECT,
      // The double records the narrow `projects.readiness_level` write in a map; the adapter's
      // harness reads the column. Both answer 0 for a project nothing has evaluated, which is the
      // column's own default (migration 0003).
      readLevel: async (projectId) => store.levels.get(projectId) ?? 0,
      cleanup: async () => {},
    };
  },
});
