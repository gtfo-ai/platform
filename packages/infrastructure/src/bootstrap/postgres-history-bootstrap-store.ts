/**
 * `HistoryBootstrapStore` on PostgreSQL — `history_bootstrap_batches` and
 * `history_bootstrap_chunks` (migration 0030), WP-35.
 *
 * Four things deserve reading before they are changed.
 *
 * **`liveBatch` reads the index that decides.** `completed_at is null` is the same predicate as the
 * partial unique index `history_bootstrap_batches_one_live`, so the command's read and the
 * database's constraint answer one question rather than two that can disagree (standing rule 9). A
 * race is decided by the index; this read is what turns the loser into a named refusal — and
 * `createBatch` translates the index's own `23505` into `LiveHistoryBootstrapError` so that the
 * loser of a *genuine* race (both commands read before either inserted) gets the same refusal
 * rather than a 500 (WP-35 review round 2).
 *
 * **`markChunkRecorded` answers whether it wrote**, and `recorded_at is null` is inside the `where`.
 * The recorder's whole transaction is keyed on that answer: the job is at-least-once, and a second
 * delivery must write no second set of `kb_proposals` and append no second event. The predicate is
 * the idempotency — not a read the caller did first, which two concurrent deliveries would both
 * pass.
 *
 * **`completeIfDone` is one statement with the same shape**, and it says what "done" means in SQL:
 * the batch has at least one chunk and no chunk of it is unrecorded. Two concurrent recorders
 * finishing a batch produce exactly one write and exactly one `true`.
 *
 * **`spendOfBatch` and `capForTask` sum `cost_entries`**, never `tasks.cost_actual`, for WP-19's
 * reason: the entries are the record and the column is a running total the executor maintains.
 * `coalesce(sum(...), 0)` — a batch that has spent nothing has spent nothing, which is the one
 * place a zero is the right answer rather than an invented one (standing rule 16's other side).
 * **`capForTask` adds a second number the ledger cannot give it**: the batch's runs that have no
 * ledger row yet, because the ledger is a handler that commits after the run's own transaction and
 * a cap read from it alone admits one run too many (`pending-run-spend.ts`, and the rule in
 * `packages/application/src/cost/pending.ts`).
 */

import type {
  CapSpend,
  HistoryBootstrapBatchRow,
  HistoryBootstrapChunkRow,
  HistoryBootstrapStatus,
  HistoryBootstrapStore,
  Transaction,
} from '@platform/application';
import { LiveHistoryBootstrapError } from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import {
  ACTIVE_RUN_STATUSES_PARAM,
  pendingRunUsdSql,
  UNLEDGERED_RUN_SQL,
} from '../cost/pending-run-spend.js';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

/** Migration 0030's partial unique index: one batch per project with `completed_at is null`. */
const LIVE_BATCH_INDEX = 'history_bootstrap_batches_one_live';

/**
 * `23505` on that index → the port's own error; everything else is rethrown.
 *
 * The event store's `translateAppendError` one ring over, for the same reason: a caller that has to
 * read a driver's `code` to tell a refusal from a fault is a caller that has the database's shape in
 * it. The **constraint name** is matched as well as the code, so an unrelated unique violation — a
 * duplicated batch id, say — stays the fault it is rather than being reported as a live batch.
 * `pg` puts the name on the error's `constraint` field; the message is checked too because a pooled
 * driver that lost the field would otherwise silently turn every conflict into a 500.
 */
const translateCreateBatchError = (error: unknown, projectId: Id): never => {
  const details =
    typeof error === 'object' && error !== null
      ? (error as { code?: string; constraint?: string; message?: string })
      : {};
  if (
    details.code === '23505' &&
    (details.constraint === LIVE_BATCH_INDEX || (details.message ?? '').includes(LIVE_BATCH_INDEX))
  ) {
    throw new LiveHistoryBootstrapError(projectId, { cause: error });
  }
  throw error;
};

const BATCH_COLUMNS = `id, project_id, requested_by, merge_requests, batch_size, days,
    cap_usd, estimated_usd, status, detail, created_at, completed_at`;

const CHUNK_COLUMNS = `id, batch_id, chunk_index, task_id, merge_requests, tickets, commits,
    redaction_count, truncated, recorded_at, proposals, refused_proposals`;

interface BatchRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly requested_by: string | null;
  readonly merge_requests: number;
  readonly batch_size: number;
  readonly days: number;
  readonly cap_usd: string;
  readonly estimated_usd: string;
  readonly status: string;
  readonly detail: string | null;
  readonly created_at: Date;
  readonly completed_at: Date | null;
}

interface ChunkRow extends Record<string, unknown> {
  readonly id: string;
  readonly batch_id: string;
  readonly chunk_index: number;
  readonly task_id: string;
  readonly merge_requests: number;
  readonly tickets: number;
  readonly commits: number;
  readonly redaction_count: number;
  readonly truncated: boolean;
  readonly recorded_at: Date | null;
  readonly proposals: number;
  readonly refused_proposals: number;
}

const instant = (value: Date): IsoDateTime => value.toISOString() as IsoDateTime;

/**
 * A status the migration's check constraint admits.
 *
 * The cast is narrow rather than a `parse` for the reason the shadow store's `humanMrSource` is:
 * the column is constrained by the database, so a value outside the set cannot be there — and if a
 * later migration widened it, a `collecting` fallback would be a lie. It is asserted by the store
 * contract suite round-tripping every one of the four.
 */
const status = (raw: string): HistoryBootstrapStatus => raw as HistoryBootstrapStatus;

const toBatch = (row: BatchRow): HistoryBootstrapBatchRow => ({
  id: row.id as Id,
  projectId: row.project_id as Id,
  requestedBy: row.requested_by === null ? null : (row.requested_by as Id),
  mergeRequests: row.merge_requests,
  batchSize: row.batch_size,
  days: row.days,
  // `numeric` arrives as a string (`pg` does not coerce it, so a value wider than a double is not
  // silently rounded on the way out). Both are `not null`, so both are numbers.
  capUsd: Number(row.cap_usd),
  estimatedUsd: Number(row.estimated_usd),
  status: status(row.status),
  detail: row.detail,
  createdAt: instant(row.created_at),
  completedAt: row.completed_at === null ? null : instant(row.completed_at),
});

const toChunk = (row: ChunkRow): HistoryBootstrapChunkRow => ({
  id: row.id as Id,
  batchId: row.batch_id as Id,
  chunkIndex: row.chunk_index,
  taskId: row.task_id as Id,
  mergeRequests: row.merge_requests,
  tickets: row.tickets,
  commits: row.commits,
  redactionCount: row.redaction_count,
  truncated: row.truncated,
  recordedAt: row.recorded_at === null ? null : instant(row.recorded_at),
  proposals: row.proposals,
  refusedProposals: row.refused_proposals,
});

export class PostgresHistoryBootstrapStore implements HistoryBootstrapStore {
  async createBatch(
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
  ): Promise<void> {
    try {
      await sqlOf(tx).query(
        `insert into history_bootstrap_batches
         (id, project_id, requested_by, merge_requests, batch_size, days, cap_usd, estimated_usd)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          batch.id,
          batch.projectId,
          batch.requestedBy,
          batch.mergeRequests,
          batch.batchSize,
          batch.days,
          batch.capUsd,
          batch.estimatedUsd,
        ],
      );
    } catch (error) {
      // `throw` at the call site, like the event store's `translateAppendError`: the helper's
      // return type is `never` and this keeps that visible where control leaves the method.
      throw translateCreateBatchError(error, batch.projectId);
    }
  }

  async liveBatch(tx: Transaction, projectId: Id): Promise<HistoryBootstrapBatchRow | null> {
    const { rows } = await sqlOf(tx).query<BatchRow>(
      `select ${BATCH_COLUMNS} from history_bootstrap_batches
        where project_id = $1 and completed_at is null
        order by created_at desc limit 1`,
      [projectId],
    );
    const row = rows[0];
    return row === undefined ? null : toBatch(row);
  }

  async batch(tx: Transaction, batchId: Id): Promise<HistoryBootstrapBatchRow | null> {
    const { rows } = await sqlOf(tx).query<BatchRow>(
      `select ${BATCH_COLUMNS} from history_bootstrap_batches where id = $1`,
      [batchId],
    );
    const row = rows[0];
    return row === undefined ? null : toBatch(row);
  }

  async listBatches(
    tx: Transaction,
    projectId: Id,
    limit: number,
  ): Promise<readonly HistoryBootstrapBatchRow[]> {
    const { rows } = await sqlOf(tx).query<BatchRow>(
      `select ${BATCH_COLUMNS} from history_bootstrap_batches
        where project_id = $1 order by created_at desc, id desc limit $2`,
      [projectId, limit],
    );
    return rows.map(toBatch);
  }

  async chunks(tx: Transaction, batchId: Id): Promise<readonly HistoryBootstrapChunkRow[]> {
    const { rows } = await sqlOf(tx).query<ChunkRow>(
      `select ${CHUNK_COLUMNS} from history_bootstrap_chunks
        where batch_id = $1 order by chunk_index`,
      [batchId],
    );
    return rows.map(toChunk);
  }

  async chunkOfTask(tx: Transaction, taskId: Id): Promise<HistoryBootstrapChunkRow | null> {
    const { rows } = await sqlOf(tx).query<ChunkRow>(
      `select ${CHUNK_COLUMNS} from history_bootstrap_chunks where task_id = $1 limit 1`,
      [taskId],
    );
    const row = rows[0];
    return row === undefined ? null : toChunk(row);
  }

  async addChunk(
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
  ): Promise<void> {
    await sqlOf(tx).query(
      `insert into history_bootstrap_chunks
         (id, batch_id, chunk_index, task_id, merge_requests, tickets, commits,
          redaction_count, truncated)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        chunk.id,
        chunk.batchId,
        chunk.chunkIndex,
        chunk.taskId,
        chunk.mergeRequests,
        chunk.tickets,
        chunk.commits,
        chunk.redactionCount,
        chunk.truncated,
      ],
    );
  }

  async markChunkRecorded(
    tx: Transaction,
    chunkId: Id,
    outcome: {
      readonly at: IsoDateTime;
      readonly proposals: number;
      readonly refusedProposals: number;
    },
  ): Promise<boolean> {
    const { rowCount } = await sqlOf(tx).query(
      `update history_bootstrap_chunks
          set recorded_at = $2, proposals = $3, refused_proposals = $4
        where id = $1 and recorded_at is null`,
      [chunkId, outcome.at, outcome.proposals, outcome.refusedProposals],
    );
    return (rowCount ?? 0) > 0;
  }

  async markMining(tx: Transaction, batchId: Id): Promise<void> {
    await sqlOf(tx).query(
      `update history_bootstrap_batches set status = 'mining'
        where id = $1 and status = 'collecting'`,
      [batchId],
    );
  }

  async markEmpty(tx: Transaction, batchId: Id, detail: string, at: IsoDateTime): Promise<void> {
    await sqlOf(tx).query(
      `update history_bootstrap_batches set status = 'empty', detail = $2, completed_at = $3
        where id = $1 and completed_at is null`,
      [batchId, detail, at],
    );
  }

  async completeIfDone(tx: Transaction, batchId: Id, at: IsoDateTime): Promise<boolean> {
    const { rowCount } = await sqlOf(tx).query(
      `update history_bootstrap_batches
          set status = 'completed', completed_at = $2
        where id = $1
          and completed_at is null
          and exists (select 1 from history_bootstrap_chunks where batch_id = $1)
          and not exists (
            select 1 from history_bootstrap_chunks
             where batch_id = $1 and recorded_at is null
          )`,
      [batchId, at],
    );
    return (rowCount ?? 0) > 0;
  }

  async spendOfBatch(tx: Transaction, batchId: Id): Promise<number> {
    const { rows } = await sqlOf(tx).query<{ usd: string }>(
      `select coalesce(sum(c.usd), 0)::text as usd
         from cost_entries c
         join history_bootstrap_chunks k on k.task_id = c.task_id
        where k.batch_id = $1`,
      [batchId],
    );
    return Number(rows[0]?.usd ?? 0);
  }

  async capForTask(
    tx: Transaction,
    taskId: Id,
    reserveUsd: number,
  ): Promise<({ readonly capUsd: number } & CapSpend) | null> {
    const { rows } = await sqlOf(tx).query<{
      cap_usd: string;
      spent_usd: string;
      pending_usd: string;
    }>(
      /**
       * One query, three numbers: the cap the batch recorded, what the ledger has charged its
       * chunks, and what its runs have committed that the ledger has not recorded yet.
       *
       * No window on the pending term — the batch **is** the window (see
       * `pending-run-spend.ts`), and a mining run of a batch that finished months ago without ever
       * reaching the ledger is a run that really did cost what it reported.
       */
      `select b.cap_usd,
              coalesce((
                select sum(c.usd) from cost_entries c
                  join history_bootstrap_chunks k2 on k2.task_id = c.task_id
                 where k2.batch_id = b.id
              ), 0)::text as spent_usd,
              coalesce((
                select sum(${pendingRunUsdSql('$2', '$3')})
                  from runs r
                  join history_bootstrap_chunks k3 on k3.task_id = r.task_id
                 where k3.batch_id = b.id and ${UNLEDGERED_RUN_SQL}
              ), 0)::text as pending_usd
         from history_bootstrap_chunks k
         join history_bootstrap_batches b on b.id = k.batch_id
        where k.task_id = $1
        limit 1`,
      [taskId, [...ACTIVE_RUN_STATUSES_PARAM], reserveUsd],
    );
    const row = rows[0];
    return row === undefined
      ? null
      : {
          capUsd: Number(row.cap_usd),
          spentUsd: Number(row.spent_usd),
          pendingUsd: Number(row.pending_usd),
        };
  }
}
