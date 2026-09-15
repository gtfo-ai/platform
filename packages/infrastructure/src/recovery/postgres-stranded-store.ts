/**
 * The queries and the two marks behind PROGRESS backlog **101**'s table — the rows whose wake-up
 * was lost (WP-36), and backlog **105**'s bound on re-enqueuing them.
 *
 * Both reads are *reads of another feature's table* and both are deliberately narrow: the worst a
 * wrong answer here can do is enqueue a job that finds nothing to do
 * (`packages/application/src/recovery/stranded.ts` states what bounds each re-enqueue).
 *
 *  - **`strandedBootstraps`** — a batch at `collecting` with **no chunk rows**. The chunk is what
 *    `collectHistory` writes for every task it creates, in the same transaction, so *"no chunks"* is
 *    the honest spelling of *"the collection never ran"*; `completed_at is null` is implied by the
 *    status and stated anyway, because `history_bootstrap_batches_one_live` is the index that turns
 *    this loss into a permanent `already_running` for the project.
 *  - **`strandedAsks`** — a `pending` ask **with no run attached**, older than the grace. It reads
 *    the index created for exactly this query (`task_asks_pending_idx on task_asks (created_at)
 *    where status = 'pending'`, migration 0024), which is why the `where` spells the predicate the
 *    partial index carries. `run_id is null` is the fix of backlog **105**: `attachRun` fills that
 *    column in the transaction that creates the run, so without it every ask whose run was still
 *    working after one grace period was "stranded", and one left `pending` by a run another writer
 *    ended started a **second paid run** on the next pass.
 *
 * Both reads return `recovery_attempted_at` and admit a row only in the two states the pass can act
 * on: **never attempted** (it gets its one attempt) or **attempted longer ago than the ending
 * window** (it gets its feature's ending). A row attempted recently is invisible here, which is
 * what makes the bound a property of the query rather than of the caller's memory.
 *
 * ## The two endings are the features' own writers, called through their own stores
 *
 * `markEmpty` and `recordRefusal` already exist, are already covered by their features' suites and
 * already say what their tables' `check` constraints require. Re-spelling either as SQL here would
 * be a second copy of a write — so this adapter composes the two stores instead, and holds nothing
 * of them beyond the one method each. The **marks** are this module's own column (migration 0032)
 * and are written here.
 *
 * Neither query joins `pgboss` to ask whether a job *is* in flight, and that is a decision rather
 * than an omission: pg-boss's tables are the adapter's own and a recovery that depended on their
 * shape would break on a queue migration. The age bound is what separates *never enqueued* from *in
 * flight*, and the idempotency of each re-enqueue is what makes a wrong guess harmless.
 */
import type {
  StrandedAsk,
  StrandedBootstrapBatch,
  StrandedQuery,
  StrandedWorkStore,
  Transaction,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { createPostgresAskStore } from '../ask/postgres-ask-store.js';
import { PostgresHistoryBootstrapStore } from '../bootstrap/postgres-history-bootstrap-store.js';
import { postgresTransaction } from '../events/postgres-unit-of-work.js';
import type { SqlExecutor } from '../events/sql.js';

const sqlOf = (tx: Transaction): SqlExecutor => postgresTransaction(tx).client;

interface BatchRow extends Record<string, unknown> {
  readonly id: string;
  readonly project_id: string;
  readonly recovery_attempted_at: Date | string | null;
}

interface AskRow extends Record<string, unknown> {
  readonly id: string;
  readonly task_id: string;
  readonly project_id: string;
  readonly recovery_attempted_at: Date | string | null;
}

/** `timestamptz` comes back as a `Date` from pg; the port speaks ISO-8601. */
const attemptedAt = (value: Date | string | null): IsoDateTime | null =>
  value === null ? null : (new Date(value).toISOString() as IsoDateTime);

export const createPostgresStrandedWorkStore = (): StrandedWorkStore => {
  const bootstraps = new PostgresHistoryBootstrapStore();
  const asks = createPostgresAskStore();

  return {
    strandedBootstraps: async (
      tx: Transaction,
      query: StrandedQuery,
    ): Promise<readonly StrandedBootstrapBatch[]> => {
      const { rows } = await sqlOf(tx).query<BatchRow>(
        `select b.id, b.project_id, b.recovery_attempted_at
           from history_bootstrap_batches b
          where b.status = 'collecting'
            and b.completed_at is null
            and b.created_at < $1::timestamptz
            and (
              b.recovery_attempted_at is null
              or b.recovery_attempted_at < $2::timestamptz
            )
            and not exists (
              select 1 from history_bootstrap_chunks c where c.batch_id = b.id
            )
          order by b.created_at
          limit $3`,
        [query.olderThan, query.endingBefore, query.limit],
      );
      return rows.map((row) => ({
        batchId: row.id as Id,
        projectId: row.project_id as Id,
        recoveryAttemptedAt: attemptedAt(row.recovery_attempted_at),
      }));
    },

    markBootstrapAttempt: async (tx, input) => {
      await sqlOf(tx).query(
        'update history_bootstrap_batches set recovery_attempted_at = $2 where id = $1',
        [input.batchId, input.at],
      );
    },

    endBootstrap: async (tx, input) => {
      await bootstraps.markEmpty(tx, input.batchId, input.reason, input.at);
    },

    strandedAsks: async (
      tx: Transaction,
      query: StrandedQuery,
    ): Promise<readonly StrandedAsk[]> => {
      const { rows } = await sqlOf(tx).query<AskRow>(
        `select a.id, a.task_id, a.project_id, a.recovery_attempted_at
           from task_asks a
          where a.status = 'pending'
            and a.run_id is null
            and a.created_at < $1::timestamptz
            and (
              a.recovery_attempted_at is null
              or a.recovery_attempted_at < $2::timestamptz
            )
          order by a.created_at
          limit $3`,
        [query.olderThan, query.endingBefore, query.limit],
      );
      return rows.map((row) => ({
        askId: row.id as Id,
        taskId: row.task_id as Id,
        projectId: row.project_id as Id,
        recoveryAttemptedAt: attemptedAt(row.recovery_attempted_at),
      }));
    },

    markAskAttempt: async (tx, input) => {
      await sqlOf(tx).query('update task_asks set recovery_attempted_at = $2 where id = $1', [
        input.askId,
        input.at,
      ]);
    },

    endAsk: async (tx, input) => {
      await asks.recordRefusal(tx, { askId: input.askId, status: 'failed', reason: input.reason });
    },
  };
};
