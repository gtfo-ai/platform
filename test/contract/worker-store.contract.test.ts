/**
 * The `WorkerStore` contract against the in-memory double (WP-280). PostgreSQL runs the same suite
 * in `test/integration/server/worker-store.integration.test.ts`.
 */
import { createMemoryWorkerStore } from '../../apps/server/src/queries/worker-store-memory.js';
import { describeWorkerStoreContract } from './support/worker-store-suite.js';

let users = 0;
let runs = 0;

describeWorkerStoreContract({
  name: 'in-memory double',
  create: async () => {
    const store = createMemoryWorkerStore();
    return {
      store,
      addUser: async (email) => {
        users += 1;
        const id = `00000000-0000-4000-8000-${users.toString(16).padStart(12, '0')}`;
        store.addUser({ id, email, name: null });
        return id;
      },
      setUserMayAct: async (userId, mayAct) => store.setUserMayAct(userId, mayAct),
      banUser: async (userId, expiresAt) => store.banUser(userId, expiresAt),
      seedRun: async (workerId, status) => {
        runs += 1;
        const id = `run-${runs}`;
        store.seedRun({
          id,
          workerId,
          taskId: `task-of-${id}`,
          projectId: 'project-of-every-run',
          status,
          leaseExpiresAt: null,
        });
        return id;
      },
      leaseExpired: async (runId) => store.runs.get(runId)?.leaseExpiresAt != null,
      audit: async () => store.audit.map((entry) => ({ ...entry })),
    };
  },
});
