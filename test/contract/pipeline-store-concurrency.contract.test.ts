/**
 * Two writers at once, against the in-memory store (technical/10 contract tier) — WP-15e.
 *
 * `test/integration/pipeline/pipeline-store-concurrency.integration.test.ts` runs the same suite
 * over two real connections to PostgreSQL 18. Both are needed and neither replaces the other:
 * standing rule 1 says the double must be at least as strict as the adapter, and WP-15h found the
 * memory store answering a question the database could not — so the property is stated once and
 * asked of both.
 *
 * `begin`/`commit`/`rollback` are no-ops here, which is the store's own divergence 4: it has no
 * isolation, so what it reproduces is the *ordering* of the interleaving rather than the locking.
 * The suite's docblock says what that is and is not worth.
 */
import { createMemoryPipelineStore } from '@platform/application';
import { runPipelineStoreConcurrencyContract } from './support/pipeline-store-concurrency-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b2';

runPipelineStoreConcurrencyContract({
  name: 'in-memory',
  create: async () => {
    const store = createMemoryPipelineStore();
    return {
      store,
      projectId: PROJECT,
      begin: async () => ({
        tx: { adapter: 'memory' } as never,
        commit: async () => {},
        rollback: async () => {},
      }),
      cleanup: async () => {},
    };
  },
});
