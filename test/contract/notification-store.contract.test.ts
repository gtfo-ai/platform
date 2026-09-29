/**
 * The `NotificationStore` contract against the in-memory store (technical/10 contract tier).
 *
 * `test/integration/notify/postgres-notification-store.integration.test.ts` runs the same suite
 * against a real PostgreSQL, which is what makes the notification band's unit tier — which runs on
 * this store — a claim about the product rather than about a Map.
 */
import { createMemoryNotificationStore, memoryInboundThreadDirectory } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runNotificationStoreContract } from './support/notification-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const USER = { id: '00000000-0000-4000-8000-0000000000d1' as Id, name: 'Fake Maintainer' };

runNotificationStoreContract({
  name: 'in-memory',
  create: async () => {
    const store = createMemoryNotificationStore({ [USER.id]: USER.name });
    const questionId = '00000000-0000-4000-8000-0000000000e2' as Id;
    const secondQuestionId = '00000000-0000-4000-8000-0000000000e3' as Id;
    const open = new Set<Id>([questionId, secondQuestionId]);
    return {
      store,
      user: USER,
      tx: { adapter: 'memory' } as never,
      projectId: PROJECT,
      taskId: TASK,
      approvalId: '00000000-0000-4000-8000-0000000000e1' as Id,
      questionId,
      integrationId: '00000000-0000-4000-8000-0000000000a1' as Id,
      secondQuestionId,
      threads: memoryInboundThreadDirectory(store, (id) => open.has(id)),
      closeQuestion: async (id) => {
        open.delete(id);
      },
      cleanup: async () => {},
    };
  },
});
