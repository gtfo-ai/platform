/**
 * The `KnowledgeStore` contract against the in-memory store (technical/10 contract tier).
 *
 * `test/integration/knowledge/postgres-knowledge-store.integration.test.ts` runs the same suite
 * against a real PostgreSQL 18, which is what makes WP-16's unit tier — the indexer's tests and the
 * context pack's acceptance figure, both of which run on this store — a claim about the product
 * rather than about a Map.
 */
import { memoryKnowledgeStore, memoryTransaction } from '@platform/application';
import { runKnowledgeStoreContract } from './support/knowledge-store-suite.js';

runKnowledgeStoreContract({
  name: 'in-memory',
  create: async () => ({
    store: memoryKnowledgeStore(),
    tx: memoryTransaction,
    projectId: '00000000-0000-4000-8000-0000000000e1',
    cleanup: async () => {},
  }),
});
