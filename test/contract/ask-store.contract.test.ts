/**
 * The `AskStore` contract against the in-memory store (technical/10 contract tier).
 *
 * `test/integration/ask/postgres-ask-store.integration.test.ts` runs the same suite against a real
 * PostgreSQL, which is what makes the ask's unit tier — which runs on this store — a claim about
 * the product rather than about a Map.
 *
 * The fake seeds its two projections rather than joining them (divergence 2 of its own register),
 * so the run and the audit row are supplied here.
 */
import { createMemoryAskStore } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { runAskStoreContract } from './support/ask-store-suite.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const TASK = '00000000-0000-4000-8000-0000000000c1' as Id;
const USER = '00000000-0000-4000-8000-0000000000d1' as Id;
const RUN = '00000000-0000-4000-8000-0000000000e1' as Id;
const AUDIT = '00000000-0000-4000-8000-0000000000f1' as Id;

runAskStoreContract({
  name: 'in-memory',
  create: async () => {
    const store = createMemoryAskStore();
    store.seedRun({
      taskId: TASK,
      runId: RUN,
      stage: 'refinement',
      role: 'product_manager',
      mode: 'normal',
      attempt: 1,
      model: 'claude-sonnet-5',
      status: 'completed',
      terminalReason: 'success',
      costUsd: 0.12,
      createdAt: '2026-06-01T08:30:00.000Z' as IsoDateTime,
    });
    store.seedAudit({
      taskId: TASK,
      id: AUDIT,
      action: 'task.pause',
      userId: USER,
      params: { reason: 'waiting on the API team' },
      createdAt: '2026-06-01T08:45:00.000Z' as IsoDateTime,
    });
    return {
      store,
      tx: { adapter: 'memory' } as never,
      projectId: PROJECT,
      taskId: TASK,
      userId: USER,
      runId: RUN,
      auditId: AUDIT,
      cleanup: async () => {},
    };
  },
});
