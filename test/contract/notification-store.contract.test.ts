/**
 * The `NotificationStore` contract against the in-memory store (technical/10 contract tier).
 *
 * `test/integration/notify/postgres-notification-store.integration.test.ts` runs the same suite
 * against a real PostgreSQL, which is what makes the notification band's unit tier — which runs on
 * this store — a claim about the product rather than about a Map.
 */
import { createMemoryNotificationStore } from '@platform/application';
import type { Id } from '@platform/contracts';
import { runNotificationStoreContract } from './support/notification-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const USER = { id: '00000000-0000-4000-8000-0000000000d1' as Id, name: 'Fake Maintainer' };

runNotificationStoreContract({
  name: 'in-memory',
  create: async () => ({
    store: createMemoryNotificationStore({ [USER.id]: USER.name }),
    user: USER,
    tx: { adapter: 'memory' } as never,
    projectId: PROJECT,
    taskId: TASK,
    approvalId: '00000000-0000-4000-8000-0000000000e1' as Id,
    questionId: '00000000-0000-4000-8000-0000000000e2' as Id,
    cleanup: async () => {},
  }),
});
