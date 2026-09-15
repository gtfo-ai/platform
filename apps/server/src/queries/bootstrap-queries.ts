/**
 * The reads behind the history bootstrap — product/06 step 3b, product/19 §18 (WP-35).
 *
 * Projections onto the published DTOs, like `shadow-queries.ts` beside them, and under the same
 * rule: **refuse rather than default, and never invent a field.**
 *
 * ## Two numbers that come from two different places, deliberately
 *
 * `cap_usd` and `estimated_usd` are read off the **batch row**, where the command copied them at
 * creation, rather than re-derived from the project's settings: the figure a reader is shown beside
 * a batch's actual spend has to be the one that applied to that batch, and a settings edit must not
 * rewrite history (`shadow_batches.budget_usd`'s argument, one work package on).
 *
 * `spent_usd` is summed from **`cost_entries`** and not from `tasks.cost_actual`, which is the
 * opposite call from the shadow screen's and is stated rather than inherited: it is the ledger's
 * own figure, which is what the cap is charged against
 * (`HistoryBootstrapStore.capForTask.spentUsd`), so a screen reading a different source would tell
 * an operator the batch had spent something other than what it was charged.
 *
 * **What this screen does not show is what the cap also counts**: the batch's runs the ledger has
 * not recorded yet (`capForTask.pendingUsd`, and
 * `packages/application/src/cost/pending.ts` for why a cap that ignored them admits one run too
 * many). So an operator can see a batch pause with `spent_usd` still under the cap — which is
 * correct, and the pause reason names the committed figure apart from the spent one. Publishing the
 * pending term here would mean publishing a **reservation** as spend on a screen whose column says
 * *"spent"*; it is a reader that does not exist yet rather than a number folded into one that
 * means something else.
 *
 * ## `proposals` counts rows, and the count is the chunk's own
 *
 * `history_bootstrap_chunks.proposals` / `refused_proposals` are written once by the recorder, so
 * this projection sums stored numbers instead of counting `kb_proposals` rows. That is not a
 * shortcut: a `kb_proposals` count would drift the moment a maintainer decides one, and the
 * question this screen answers is *what did the mining produce*, not *what is still queued*.
 */
import type {
  HistoryBootstrapBatch,
  HistoryBootstrapEstimate,
  HistoryBootstrapStatus,
  HistoryBootstrapsResponse,
  Id,
} from '@platform/contracts';
import { MAX_BOOTSTRAP_MERGE_REQUESTS } from '@platform/contracts';
import { db as dbAdapters } from '@platform/infrastructure';
import { desc, eq, inArray, sql } from 'drizzle-orm';

export type Database = dbAdapters.Database;

const { historyBootstrapBatches, historyBootstrapChunks, costEntries } = dbAdapters.schema;

/** One batch row as the query selects it, and the chunk counts that go with it. */
export interface BootstrapBatchRowShape {
  readonly id: string;
  readonly projectId: string;
  readonly status: string;
  readonly detail: string | null;
  readonly mergeRequests: number;
  readonly capUsd: string;
  readonly estimatedUsd: string;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export interface BootstrapChunkRowShape {
  readonly batchId: string;
  readonly recordedAt: Date | null;
  readonly proposals: number;
  readonly refusedProposals: number;
}

const STATUSES: readonly HistoryBootstrapStatus[] = ['collecting', 'mining', 'completed', 'empty'];

/**
 * The stored status, or `collecting` for a value this build does not know.
 *
 * The column is constrained by migration 0030's check, so an unknown value cannot be there today.
 * The fallback is the **most conservative** of the four rather than the most convenient: a batch
 * whose status this build cannot read is one that has not finished as far as the screen is
 * concerned, which is the direction that never claims work is done (standing rule 20).
 */
const status = (raw: string): HistoryBootstrapStatus =>
  STATUSES.find((value) => value === raw) ?? 'collecting';

/**
 * One batch, as a pure function of its own row and its chunks'.
 *
 * Separated from the query for `shadow-queries.ts`'s reason: everything worth asserting is the
 * arithmetic, and a projection driven only through a container is a projection asserted once,
 * slowly.
 */
export const bootstrapBatchFrom = (
  batch: BootstrapBatchRowShape,
  chunks: readonly BootstrapChunkRowShape[],
  spentUsd: number,
): HistoryBootstrapBatch => ({
  id: batch.id as Id,
  project_id: batch.projectId as Id,
  status: status(batch.status),
  created_at: batch.createdAt.toISOString() as HistoryBootstrapBatch['created_at'],
  completed_at:
    batch.completedAt === null
      ? null
      : (batch.completedAt.toISOString() as HistoryBootstrapBatch['created_at']),
  merge_requests: batch.mergeRequests,
  detail: batch.detail,
  cap_usd: Number(batch.capUsd),
  estimated_usd: Number(batch.estimatedUsd),
  spent_usd: spentUsd,
  chunks: chunks.length,
  chunks_recorded: chunks.filter((chunk) => chunk.recordedAt !== null).length,
  proposals: chunks.reduce((total, chunk) => total + chunk.proposals, 0),
  refused_proposals: chunks.reduce((total, chunk) => total + chunk.refusedProposals, 0),
});

/**
 * `GET /api/projects/:project_id/history-bootstraps` — the batches, the gate and the estimate.
 *
 * The **estimate is the caller's**, computed by the application from the project's settings and the
 * N in the query, and handed in here: a projection that re-derived it would be the second spelling
 * of one rule, and the first disagreement would be about money (standing rule 9).
 */
export const listHistoryBootstraps = async (
  database: Database,
  projectId: string,
  gate: {
    readonly canStart: boolean;
    readonly blockedReason: string | null;
    readonly estimate: HistoryBootstrapEstimate;
  },
): Promise<HistoryBootstrapsResponse> => {
  const batches = await database
    .select({
      id: historyBootstrapBatches.id,
      projectId: historyBootstrapBatches.projectId,
      status: historyBootstrapBatches.status,
      detail: historyBootstrapBatches.detail,
      mergeRequests: historyBootstrapBatches.mergeRequests,
      capUsd: historyBootstrapBatches.capUsd,
      estimatedUsd: historyBootstrapBatches.estimatedUsd,
      createdAt: historyBootstrapBatches.createdAt,
      completedAt: historyBootstrapBatches.completedAt,
    })
    .from(historyBootstrapBatches)
    .where(eq(historyBootstrapBatches.projectId, projectId))
    .orderBy(desc(historyBootstrapBatches.createdAt), desc(historyBootstrapBatches.id))
    .limit(20);

  const ids = batches.map((batch) => batch.id);
  const chunks =
    ids.length === 0
      ? []
      : await database
          .select({
            batchId: historyBootstrapChunks.batchId,
            recordedAt: historyBootstrapChunks.recordedAt,
            proposals: historyBootstrapChunks.proposals,
            refusedProposals: historyBootstrapChunks.refusedProposals,
          })
          .from(historyBootstrapChunks)
          .where(inArray(historyBootstrapChunks.batchId, ids));

  const spend =
    ids.length === 0
      ? []
      : await database
          .select({
            batchId: historyBootstrapChunks.batchId,
            usd: sql<string>`coalesce(sum(${costEntries.usd}), 0)::text`,
          })
          .from(historyBootstrapChunks)
          .leftJoin(costEntries, eq(costEntries.taskId, historyBootstrapChunks.taskId))
          .where(inArray(historyBootstrapChunks.batchId, ids))
          .groupBy(historyBootstrapChunks.batchId);

  const spentByBatch = new Map(spend.map((row) => [row.batchId, Number(row.usd)]));
  return {
    items: batches.map((batch) =>
      bootstrapBatchFrom(
        batch,
        chunks.filter((chunk) => chunk.batchId === batch.id),
        spentByBatch.get(batch.id) ?? 0,
      ),
    ),
    can_start: gate.canStart,
    blocked_reason: gate.blockedReason,
    estimate: gate.estimate,
    max_merge_requests: MAX_BOOTSTRAP_MERGE_REQUESTS,
  };
};

/** Whether the project has a git binding — the one fact the gate cannot read off the settings. */
export const hasGitBinding = async (database: Database, projectId: string): Promise<boolean> => {
  const { bindings, integrations } = dbAdapters.schema;
  const rows = await database
    .select({ id: bindings.integrationId })
    .from(bindings)
    .innerJoin(integrations, eq(integrations.id, bindings.integrationId))
    .where(sql`${bindings.projectId} = ${projectId} and ${integrations.type} = 'git'`)
    .limit(1);
  return rows.length > 0;
};
