/**
 * The `HumanTimeStore` contract against the in-memory store (technical/10 contract tier).
 *
 * `test/integration/cost/postgres-human-time-store.integration.test.ts` runs the same suite against
 * a real PostgreSQL, which is what makes the projector's unit tier — which runs on this store — a
 * claim about the product rather than about a Map.
 */
import { createMemoryHumanTimeStore } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runHumanTimeStoreContract } from './support/human-time-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;

runHumanTimeStoreContract({
  name: 'in-memory',
  create: async () => {
    const store = createMemoryHumanTimeStore();
    // `organizations.timezone` is `not null default 'UTC'`, so an unset organisation answers 'UTC'
    // on a database; the fake is seeded to the same starting point rather than to `null`.
    store.seedTimezone(PROJECT, 'UTC');
    return {
      store,
      tx: { adapter: 'memory' } as never,
      projectId: PROJECT,
      seed: {
        task: async (input) => {
          if (input.mrIid !== undefined) {
            store.seedMergeRequest({ projectId: PROJECT, iid: input.mrIid }, input.id);
          }
        },
        identity: async (input) => {
          store.seedIdentity(
            { provider: input.provider, externalId: input.externalId },
            input.userId,
          );
        },
        question: async (input) => {
          store.seedQuestion(input.id, input.askedAt);
        },
        timezone: async (value) => {
          store.seedTimezone(PROJECT, value);
        },
        // The fake has no `users` table: an entry's `user_id` is a value it stores, not a row it
        // checks — which is divergence 2 of its register, asserted there rather than papered over.
        user: async () => {},
      },
      cleanup: async () => {},
    };
  },
});
