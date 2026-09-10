/**
 * The `PipelineStore` contract against the in-memory store (technical/10 contract tier).
 *
 * `test/integration/pipeline/postgres-pipeline-store.integration.test.ts` runs the same suite
 * against a real PostgreSQL, which is what makes the saga's unit tier — which runs on this store —
 * a claim about the product rather than about a Map.
 */
import { createMemoryPipelineStore } from '@platform/application';
import { runPipelineStoreContract } from './support/pipeline-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1';

runPipelineStoreContract({
  name: 'in-memory',
  create: async () => ({
    store: createMemoryPipelineStore(),
    tx: { adapter: 'memory' } as never,
    projectId: PROJECT,
    userId: '00000000-0000-4000-8000-0000000000c1',
    cleanup: async () => {},
  }),
});
