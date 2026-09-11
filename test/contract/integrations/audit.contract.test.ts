/**
 * The in-memory half of the `IntegrationAuditLog` / `IdempotencyStore` contract (WP-15b).
 *
 * The same two suites run against the PostgreSQL adapters in
 * `test/integration/integrations/audit-log.integration.test.ts`. Running them here as well is the
 * point of a shared suite: until WP-15b these ports had exactly one implementation and their
 * obligations lived in docblocks, so nothing would have noticed the second one disagreeing
 * (standing rule 23).
 */
import { createMemoryAuditLog, createMemoryIdempotencyStore } from '@platform/application';
import type { Id } from '@platform/contracts';
import {
  type AuditLogContractContext,
  type IdempotencyContractContext,
  runAuditLogContract,
  runIdempotencyStoreContract,
} from '../support/integrations/audit-contract-suites.js';

const INTEGRATION = '00000000-0000-4000-8000-00000000a001' as Id;
const OTHER_INTEGRATION = '00000000-0000-4000-8000-00000000a002' as Id;
const PROJECT = '00000000-0000-4000-8000-00000000b001' as Id;
const TASK = '00000000-0000-4000-8000-00000000c001' as Id;

runAuditLogContract('in-memory fake', async (): Promise<AuditLogContractContext> => {
  const log = createMemoryAuditLog();
  return {
    log,
    rows: async () =>
      log.entries.map((entry) => ({
        integrationId: entry.integrationId,
        projectId: entry.projectId,
        taskId: entry.taskId,
        action: entry.action,
        status: entry.status,
        payload: entry.payload,
        redactionCount: entry.redactionCount,
        attempts: entry.attempts,
        durationMs: entry.durationMs,
      })),
    eventTypes: async () => log.events.map((event) => event.type),
    integrationId: INTEGRATION,
    projectId: PROJECT,
    taskId: TASK,
    cleanup: async () => {
      log.reset();
    },
  };
});

runIdempotencyStoreContract('in-memory fake', async (): Promise<IdempotencyContractContext> => {
  const store = createMemoryIdempotencyStore();
  return {
    store,
    integrationId: INTEGRATION,
    otherIntegrationId: OTHER_INTEGRATION,
    cleanup: async () => {
      store.reset();
    },
  };
});
