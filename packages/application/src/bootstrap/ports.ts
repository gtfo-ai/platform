/**
 * What the history bootstrap stores, behind a port — WP-35.
 *
 * Separate from `PipelineStore` for `ShadowStore`'s reason: a batch is a thing an operator started
 * on one day (`history_bootstrap_batches`, migration 0030) and a chunk is one mining run of it
 * (`history_bootstrap_chunks`). Neither is part of a task's own state, so neither belongs on the
 * aggregate's store — and a composition root that serves the API without running the workers
 * composes the reads and not the writes.
 *
 * Everything here takes the caller's transaction. Two writes have to be atomic with something else
 * — a chunk with the task it created, and a chunk's counts with the proposals the recorder wrote —
 * and a store that opened its own transaction could not give them that.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { CapSpend } from '../cost/pending.js';
import type { Transaction } from '../ports/transaction.js';

export type HistoryBootstrapStatus = 'collecting' | 'mining' | 'completed' | 'empty';

/**
 * A `createBatch` that lost the race for the project's one live batch.
 *
 * `startHistoryBootstrap` reads `liveBatch` first and refuses with `already_running`, and that read
 * closes every case but one: two commands that both read *before* either inserts. Migration 0030's
 * partial unique index `history_bootstrap_batches_one_live` is what decides that one, and without
 * this error the loser would surface as an unmapped `23505` — a 500 for a caller whose honest answer
 * is the same `already_running` the read gives (standing rule 20: refuse by name, never by accident).
 *
 * It is declared beside the port rather than in the adapter for `TaskConcurrentModificationError`'s
 * reason: the *caller* branches on it, so it is part of the port's contract and every implementation
 * owes it — the in-memory double raises it too, and the store contract suite asserts both do.
 */
export class LiveHistoryBootstrapError extends Error {
  override readonly name = 'LiveHistoryBootstrapError';
  readonly projectId: Id;

  // Fields and assignments, never a TypeScript parameter property: this repository runs its
  // sources through Node's strip-only type stripping, which refuses one (`pipeline/store.ts`
  // carries the measurement).
  constructor(projectId: Id, options?: ErrorOptions) {
    super(
      `project ${projectId} already has a history bootstrap that has not finished ` +
        '(history_bootstrap_batches_one_live)',
      options,
    );
    this.projectId = projectId;
  }
}

export interface HistoryBootstrapBatchRow {
  readonly id: Id;
  readonly projectId: Id;
  readonly requestedBy: Id | null;
  readonly mergeRequests: number;
  readonly batchSize: number;
  readonly days: number;
  readonly capUsd: number;
  readonly estimatedUsd: number;
  readonly status: HistoryBootstrapStatus;
  /** Platform text: why the batch is `empty`, or what the collection left out. */
  readonly detail: string | null;
  readonly createdAt: IsoDateTime;
  readonly completedAt: IsoDateTime | null;
}

export interface HistoryBootstrapChunkRow {
  readonly id: Id;
  readonly batchId: Id;
  readonly chunkIndex: number;
  readonly taskId: Id;
  readonly mergeRequests: number;
  readonly tickets: number;
  readonly commits: number;
  readonly redactionCount: number;
  readonly truncated: boolean;
  /**
   * When the mining run's findings were recorded, or `null` while it has not reported.
   *
   * It is what makes `proposals: 0` unambiguous — a run that read the batch and found nothing
   * repeatable is a finding; a run that has not reported is silence (standing rule 18).
   */
  readonly recordedAt: IsoDateTime | null;
  /**
   * When the platform stopped waiting for this run's findings, and why (migration 0036, WP-48).
   *
   * The ending of the recovery's one attempt at a lost `record` wake-up (PROGRESS backlog 106,
   * bounded per 105). A column of its own rather than a `recordedAt` stamp, because a stamped row
   * means *"this run reported"* — `history_bootstrap_chunks_counts_need_a_report` exists to make
   * `proposals: 0` unambiguous, and stamping a run that never reported would publish silence as a
   * finding. {@link HistoryBootstrapStore.completeIfDone} counts an abandoned chunk as reported, so
   * the batch can finish and the project's one-live-batch index stops refusing every later attempt.
   */
  readonly abandonedAt: IsoDateTime | null;
  /** Platform text: why it was abandoned. `null` exactly when {@link abandonedAt} is. */
  readonly detail: string | null;
  readonly proposals: number;
  readonly refusedProposals: number;
}

export interface HistoryBootstrapStore {
  /** Creates the batch row. The chunks are written by {@link addChunk}, in a later transaction. */
  createBatch(
    tx: Transaction,
    batch: {
      readonly id: Id;
      readonly projectId: Id;
      readonly requestedBy: Id | null;
      readonly mergeRequests: number;
      readonly batchSize: number;
      readonly days: number;
      readonly capUsd: number;
      readonly estimatedUsd: number;
    },
  ): Promise<void>;

  /** The project's live batch — the one that has not finished — or `null`. */
  liveBatch(tx: Transaction, projectId: Id): Promise<HistoryBootstrapBatchRow | null>;

  batch(tx: Transaction, batchId: Id): Promise<HistoryBootstrapBatchRow | null>;

  listBatches(
    tx: Transaction,
    projectId: Id,
    limit: number,
  ): Promise<readonly HistoryBootstrapBatchRow[]>;

  chunks(tx: Transaction, batchId: Id): Promise<readonly HistoryBootstrapChunkRow[]>;

  /** The chunk a task belongs to, or `null` for a task that is not a mining run. */
  chunkOfTask(tx: Transaction, taskId: Id): Promise<HistoryBootstrapChunkRow | null>;

  addChunk(
    tx: Transaction,
    chunk: {
      readonly id: Id;
      readonly batchId: Id;
      readonly chunkIndex: number;
      readonly taskId: Id;
      readonly mergeRequests: number;
      readonly tickets: number;
      readonly commits: number;
      readonly redactionCount: number;
      readonly truncated: boolean;
    },
  ): Promise<void>;

  /**
   * Records what one mining run proposed, and answers whether this call is the one that did it.
   *
   * `false` is what makes the recorder idempotent: the job is at-least-once, and a second delivery
   * must not write a second set of `kb_proposals` rows. `recorded_at is null` is in the predicate,
   * so the answer is about the write rather than about the read that preceded it.
   */
  markChunkRecorded(
    tx: Transaction,
    chunkId: Id,
    outcome: {
      readonly at: IsoDateTime;
      readonly proposals: number;
      readonly refusedProposals: number;
    },
  ): Promise<boolean>;

  /**
   * Stops waiting for one run's findings, and answers whether this call is the one that did it.
   *
   * The ending the lost-wake-up recovery gives a chunk whose re-enqueued `record` did not take
   * (WP-48, PROGRESS backlog 106 and 105). `recorded_at is null and abandoned_at is null` is in the
   * predicate, so a `record` job that arrives late still wins the row and a second sweep writes
   * nothing. The caller follows it with {@link completeIfDone}, which now counts an abandoned chunk
   * as reported — that is what releases `history_bootstrap_batches_one_live`.
   */
  abandonChunk(
    tx: Transaction,
    chunkId: Id,
    ending: { readonly at: IsoDateTime; readonly detail: string },
  ): Promise<boolean>;

  /**
   * Moves the batch to `mining` once its chunks exist, or to `completed`/`empty`.
   *
   * `completeIfDone` answers `true` only on the write that changed the row (`completed_at is null`
   * is in the predicate), so the recorder performs nothing twice. Since WP-48 a chunk the recovery
   * **abandoned** counts as reported for this question: the alternative is a batch nobody can
   * complete, which is the permanent `already_running` backlog 101 is about.
   */
  markMining(tx: Transaction, batchId: Id): Promise<void>;
  markEmpty(tx: Transaction, batchId: Id, detail: string, at: IsoDateTime): Promise<void>;
  completeIfDone(tx: Transaction, batchId: Id, at: IsoDateTime): Promise<boolean>;

  /**
   * What this batch's tasks have spent, from `cost_entries`.
   *
   * The ledger rather than `tasks.cost_actual`, for the reason WP-19 gives everywhere else: the
   * entries are the record and the task column is a running total the executor maintains. It is
   * what the batch screen shows, and it is deliberately **only** the record: the cap is checked
   * against this *plus* {@link HistoryBootstrapStore.capForTask}'s pending term, because the ledger
   * is written by a handler after the run's own transaction and therefore lags it by design
   * (`packages/application/src/cost/pending.ts`).
   */
  spendOfBatch(tx: Transaction, batchId: Id): Promise<number>;

  /**
   * The cap and the spend for the batch a task belongs to, or `null` when it is not in one.
   *
   * One query, asked by the stage executor at admission and **only** for a task on the bootstrap
   * template, so an ordinary delivery pays nothing for it.
   *
   * `spentUsd` is the ledger's; `pendingUsd` is the batch's runs the ledger has not recorded,
   * valued at `reserveUsd` while they are live and at what they reported once they have ended.
   * The rule and the measurement that earned it are in `packages/application/src/cost/pending.ts`;
   * without the second number two chunks admitted inside the ledger's window both run.
   */
  capForTask(
    tx: Transaction,
    taskId: Id,
    reserveUsd: number,
  ): Promise<({ readonly capUsd: number } & CapSpend) | null>;
}
