/**
 * The in-memory `ShadowStore` double (WP-34).
 *
 * ## Divergence register (standing rules 1 and 12)
 *
 * Every divergence below is **stricter or equal**, never kinder, and the shared contract suite
 * (`test/contract/support/shadow-store-suite.ts`) runs against both this and PostgreSQL, so the
 * list is checkable rather than asserted.
 *
 * 1. **No foreign keys.** `shadow_batches.project_id`, `shadow_batch_tickets.task_id` and
 *    `shadow_reports.task_id` all reference real rows, so the adapter refuses a batch for a project
 *    that does not exist and this does not. The suite therefore only ever writes against rows its
 *    harness created.
 * 2. **No check constraint.** `shadow_batch_tickets_task_or_refusal` refuses a row that is both a
 *    task and a refusal, or neither; this double stores what it is handed. Nothing produces such a
 *    row — `startShadowBatch` writes one or the other on every path — so the constraint has no
 *    caller to catch, and the suite asserts the two shapes rather than the constraint.
 * 3. **No transaction.** Every method ignores the handle, so a rollback leaves the write here. The
 *    integration tier is where rollback is tested, against the real adapter.
 * 4. **`shadowSpendSince` sums what a test seeded**, because this double holds no `cost_entries`:
 *    {@link MemoryShadowStore.seedShadowSpend} is the seam. It is **stricter** in one way that
 *    matters — the seeded number is used exactly, where the adapter sums a `numeric(12,6)` column
 *    and could round — so a test that depends on a rounding is a test that only the adapter can
 *    answer.
 * 5. **`completeIfDone` compares the same sets the adapter's SQL does** — every ticket row with a
 *    `task_id`, against the reports written — and answers `true` only on the transition, so the
 *    idempotency the `shadow.report.created` consumer rests on is exercised here too.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';
import type {
  ShadowBatchRow,
  ShadowBatchTicketRow,
  ShadowReportRow,
  ShadowStore,
} from '../shadow/ports.js';

export interface MemoryShadowStore extends ShadowStore {
  /** Every batch created, oldest first. */
  readonly batches: readonly ShadowBatchRow[];
  /** Every ticket row, by batch id. */
  ticketsOf(batchId: Id): readonly ShadowBatchTicketRow[];
  /** Every report written, oldest first. */
  readonly reportRows: readonly ShadowReportRow[];
  /** Divergence 4: what `shadowSpendSince` answers for a project. */
  seedShadowSpend(projectId: Id, usd: number): void;
}

export const createMemoryShadowStore = (
  clock: { now(): string } = { now: () => new Date().toISOString() },
): MemoryShadowStore => {
  const batches: ShadowBatchRow[] = [];
  const tickets = new Map<Id, ShadowBatchTicketRow[]>();
  const reports: ShadowReportRow[] = [];
  const spend = new Map<Id, number>();

  const batchById = (batchId: Id): ShadowBatchRow | undefined =>
    batches.find((row) => row.id === batchId);

  const replace = (batch: ShadowBatchRow): void => {
    const at = batches.findIndex((row) => row.id === batch.id);
    if (at >= 0) {
      batches[at] = batch;
    }
  };

  return {
    get batches(): readonly ShadowBatchRow[] {
      return batches;
    },
    ticketsOf: (batchId) => tickets.get(batchId) ?? [],
    get reportRows(): readonly ShadowReportRow[] {
      return reports;
    },
    seedShadowSpend: (projectId, usd) => {
      spend.set(projectId, usd);
    },

    createBatch: async (_tx: Transaction, batch) => {
      batches.push({
        id: batch.id,
        projectId: batch.projectId,
        requestedBy: batch.requestedBy,
        budgetUsd: batch.budgetUsd,
        createdAt: clock.now() as IsoDateTime,
        completedAt: null,
      });
      tickets.set(batch.id, []);
    },

    addTicket: async (_tx: Transaction, batchId, ticket) => {
      const list = tickets.get(batchId) ?? [];
      list.push(ticket);
      tickets.set(batchId, list);
    },

    batch: async (_tx: Transaction, batchId) => batchById(batchId) ?? null,

    listBatches: async (_tx: Transaction, projectId, limit) =>
      batches
        .filter((row) => row.projectId === projectId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .slice(0, limit),

    tickets: async (_tx: Transaction, batchId) => tickets.get(batchId) ?? [],

    batchOfTask: async (_tx: Transaction, taskId) => {
      for (const [batchId, list] of tickets) {
        if (list.some((ticket) => ticket.taskId === taskId)) {
          return batchById(batchId) ?? null;
        }
      }
      return null;
    },

    insertReport: async (_tx: Transaction, report) => {
      if (reports.some((row) => row.taskId === report.taskId)) {
        return false;
      }
      reports.push({ ...report, createdAt: clock.now() as IsoDateTime });
      return true;
    },

    reports: async (_tx: Transaction, batchId) => {
      const taskIds = new Set(
        (tickets.get(batchId) ?? [])
          .map((ticket) => ticket.taskId)
          .filter((taskId): taskId is Id => taskId !== null),
      );
      return reports.filter((row) => taskIds.has(row.taskId));
    },

    completeIfDone: async (_tx: Transaction, batchId, at) => {
      const batch = batchById(batchId);
      if (batch === undefined || batch.completedAt !== null) {
        return false;
      }
      const taskIds = (tickets.get(batchId) ?? [])
        .map((ticket) => ticket.taskId)
        .filter((taskId): taskId is Id => taskId !== null);
      if (taskIds.length === 0) {
        return false;
      }
      const reported = new Set(reports.map((row) => row.taskId));
      if (!taskIds.every((taskId) => reported.has(taskId))) {
        return false;
      }
      replace({ ...batch, completedAt: at });
      return true;
    },

    shadowSpendSince: async (_tx: Transaction, projectId) => spend.get(projectId) ?? 0,

    checkoutBaseFor: async (_tx: Transaction, taskId) => {
      for (const list of tickets.values()) {
        const found = list.find((ticket) => ticket.taskId === taskId);
        if (found !== undefined) {
          return found.baseSha;
        }
      }
      return null;
    },
  };
};
