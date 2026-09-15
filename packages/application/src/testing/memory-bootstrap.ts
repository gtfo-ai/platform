/**
 * The in-memory `HistoryBootstrapStore` double (WP-35).
 *
 * ## Divergence register (standing rules 1 and 12)
 *
 * Every divergence below is **stricter or equal**, never kinder.
 *
 * 1. **No foreign keys.** `history_bootstrap_batches.project_id` and
 *    `history_bootstrap_chunks.task_id` reference real rows, so the adapter refuses a chunk for a
 *    task that does not exist and this does not. Tests only ever write against rows their harness
 *    created.
 * 2. **The partial unique index, without the race.** Migration 0030's
 *    `history_bootstrap_batches_one_live` refuses a second live batch for a project and so does
 *    `createBatch` here, with the same {@link LiveHistoryBootstrapError} the adapter raises — the
 *    store contract suite asserts both, so the command's mapping of it is exercised on the fast
 *    tier rather than only against PostgreSQL. What this double still cannot express is the
 *    **race** the index exists for (two commands that both read no live batch before either
 *    inserts): there is no concurrency here, so the refusal is reachable only by calling
 *    `createBatch` directly. That case is the integration tier's.
 * 3. **No transaction.** Every method ignores the handle, so a rollback leaves the write here. The
 *    integration tier is where rollback is tested, against the real adapter.
 * 4. **`spendOfBatch` and `capForTask` sum what a test seeded**, because this double holds no
 *    `cost_entries`: {@link MemoryHistoryBootstrapStore.seedSpend} is the seam. It is **stricter**
 *    in one way that matters — the seeded number is used exactly, where the adapter sums a
 *    `numeric(12,6)` column and could round — so a test that depends on a rounding is one only the
 *    adapter can answer. The **pending** half of `capForTask` is seeded the same way
 *    ({@link MemoryHistoryBootstrapStore.seedPendingRuns}) and is the one place this double is
 *    *kinder* than the adapter (standing rule 1): it holds no `runs`, so it cannot derive the
 *    batch's unledgered runs and answers `0` unless a test says otherwise — where the adapter
 *    finds them. A test that wants the cap's pending term seeds it; the adapter's own derivation
 *    is held by the integration tier.
 * 5. **`markChunkRecorded`, `abandonChunk` and `completeIfDone` answer `true` only on the
 *    transition**, which is the same predicate the adapter puts in its `where`, so the recorder's
 *    idempotency — and the recovery's ending (WP-48) — is exercised here as well as there.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type {
  HistoryBootstrapBatchRow,
  HistoryBootstrapChunkRow,
  HistoryBootstrapStore,
} from '../bootstrap/ports.js';
import { LiveHistoryBootstrapError } from '../bootstrap/ports.js';
import type { Transaction } from '../ports/transaction.js';

export interface MemoryHistoryBootstrapStore extends HistoryBootstrapStore {
  /** Every batch created, oldest first. */
  readonly batches: readonly HistoryBootstrapBatchRow[];
  /** Every chunk of a batch, in index order. */
  chunksOf(batchId: Id): readonly HistoryBootstrapChunkRow[];
  /** Divergence 4: what `spendOfBatch` and `capForTask` answer for a batch. */
  seedSpend(batchId: Id, usd: number): void;
  /**
   * Divergence 4: how many runs of this batch the ledger has not recorded.
   *
   * `capForTask` values each of them at the `reserveUsd` its caller passes, which is what the
   * adapter does for a **live** run; an ended-but-unledgered run's own reported figure is a `runs`
   * column this double does not hold.
   */
  seedPendingRuns(batchId: Id, runs: number): void;
}

export const createMemoryHistoryBootstrapStore = (
  clock: { now(): string } = { now: () => new Date().toISOString() },
): MemoryHistoryBootstrapStore => {
  const batches: HistoryBootstrapBatchRow[] = [];
  const chunks: HistoryBootstrapChunkRow[] = [];
  const spend = new Map<Id, number>();
  const pendingRuns = new Map<Id, number>();

  const replace = (batch: HistoryBootstrapBatchRow): void => {
    const index = batches.findIndex((row) => row.id === batch.id);
    if (index >= 0) {
      batches[index] = batch;
    }
  };

  const replaceChunk = (chunk: HistoryBootstrapChunkRow): void => {
    const index = chunks.findIndex((row) => row.id === chunk.id);
    if (index >= 0) {
      chunks[index] = chunk;
    }
  };

  return {
    get batches() {
      return [...batches];
    },
    chunksOf: (batchId) =>
      chunks.filter((row) => row.batchId === batchId).sort((a, b) => a.chunkIndex - b.chunkIndex),
    seedSpend: (batchId, usd) => {
      spend.set(batchId, usd);
    },

    seedPendingRuns: (batchId, runs) => {
      pendingRuns.set(batchId, runs);
    },

    createBatch: async (_tx: Transaction, batch) => {
      // Divergence 2: the index's rule, enforced here so a caller that branches on the refusal is
      // driven against this double too. `completed_at is null` is the index's predicate, spelled
      // the same way `liveBatch` spells it.
      if (batches.some((row) => row.projectId === batch.projectId && row.completedAt === null)) {
        throw new LiveHistoryBootstrapError(batch.projectId);
      }
      batches.push({
        ...batch,
        status: 'collecting',
        detail: null,
        createdAt: clock.now() as IsoDateTime,
        completedAt: null,
      });
    },

    liveBatch: async (_tx, projectId) =>
      [...batches]
        .reverse()
        .find((row) => row.projectId === projectId && row.completedAt === null) ?? null,

    batch: async (_tx, batchId) => batches.find((row) => row.id === batchId) ?? null,

    listBatches: async (_tx, projectId, limit) =>
      [...batches]
        .filter((row) => row.projectId === projectId)
        .reverse()
        .slice(0, limit),

    chunks: async (_tx, batchId) =>
      chunks.filter((row) => row.batchId === batchId).sort((a, b) => a.chunkIndex - b.chunkIndex),

    chunkOfTask: async (_tx, taskId) => chunks.find((row) => row.taskId === taskId) ?? null,

    addChunk: async (_tx, chunk) => {
      chunks.push({
        ...chunk,
        recordedAt: null,
        abandonedAt: null,
        detail: null,
        proposals: 0,
        refusedProposals: 0,
      });
    },

    markChunkRecorded: async (_tx, chunkId, outcome) => {
      const chunk = chunks.find((row) => row.id === chunkId);
      if (chunk === undefined || chunk.recordedAt !== null || chunk.abandonedAt !== null) {
        return false;
      }
      replaceChunk({
        ...chunk,
        recordedAt: outcome.at,
        proposals: outcome.proposals,
        refusedProposals: outcome.refusedProposals,
      });
      return true;
    },

    abandonChunk: async (_tx, chunkId, ending) => {
      const chunk = chunks.find((row) => row.id === chunkId);
      if (chunk === undefined || chunk.recordedAt !== null || chunk.abandonedAt !== null) {
        return false;
      }
      replaceChunk({ ...chunk, abandonedAt: ending.at, detail: ending.detail });
      return true;
    },

    markMining: async (_tx, batchId) => {
      const batch = batches.find((row) => row.id === batchId);
      if (batch !== undefined && batch.status === 'collecting') {
        replace({ ...batch, status: 'mining' });
      }
    },

    markEmpty: async (_tx, batchId, detail, at) => {
      const batch = batches.find((row) => row.id === batchId);
      if (batch !== undefined && batch.completedAt === null) {
        replace({ ...batch, status: 'empty', detail, completedAt: at });
      }
    },

    completeIfDone: async (_tx, batchId, at) => {
      const batch = batches.find((row) => row.id === batchId);
      if (batch === undefined || batch.completedAt !== null) {
        return false;
      }
      const own = chunks.filter((row) => row.batchId === batchId);
      // An abandoned chunk counts as reported (WP-48): the recovery gave up on its findings, and a
      // batch nobody can complete is the permanent `already_running` backlog 101 is about.
      if (
        own.length === 0 ||
        own.some((row) => row.recordedAt === null && row.abandonedAt === null)
      ) {
        return false;
      }
      replace({ ...batch, status: 'completed', completedAt: at });
      return true;
    },

    spendOfBatch: async (_tx, batchId) => spend.get(batchId) ?? 0,

    capForTask: async (_tx, taskId, reserveUsd) => {
      const chunk = chunks.find((row) => row.taskId === taskId);
      if (chunk === undefined) {
        return null;
      }
      const batch = batches.find((row) => row.id === chunk.batchId);
      return batch === undefined
        ? null
        : {
            capUsd: batch.capUsd,
            spentUsd: spend.get(batch.id) ?? 0,
            pendingUsd: (pendingRuns.get(batch.id) ?? 0) * reserveUsd,
          };
    },
  };
};
