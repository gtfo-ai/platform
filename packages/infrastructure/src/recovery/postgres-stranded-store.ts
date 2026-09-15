/**
 * The queries and the marks behind PROGRESS backlog **101**'s table — the rows whose wake-up was
 * lost (WP-36; the last two sites and the ask's terminal run at WP-48), and backlog **105**'s bound
 * on re-enqueuing them.
 *
 * Every read is a *read of another feature's table* and all of them are deliberately narrow: the
 * worst a wrong answer here can do is enqueue a job that finds nothing to do
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
 *  - **`strandedHistoryRecords`** (WP-48, backlog **106**) — a chunk with no findings recorded whose
 *    task carries a `HistoryFindings` artifact. The artifact is the evidence that the run *did*
 *    report, which is what separates this from a run that is simply still going; the age bound is on
 *    the artifact, because that is when the wake-up was lost.
 *  - **`strandedCurations`** (WP-48, backlog **36**) — an artifact of a curated type with no
 *    `knowledge_curations` row. That table is migration 0036's mark, and it is what makes the query
 *    expressible at all: a curation that proposed nothing writes no `kb_proposals` row, so without
 *    the mark this site cannot be told from a quiet one (standing rule 18).
 *  - **`asksWithEndedRun`** (WP-48, backlog **121**) — a `pending` ask whose attached run has
 *    `ended_at`. Not a lost wake-up: the run is over and the question is ended rather than retried,
 *    so there is no mark and no attempt.
 *
 * The four re-enqueuing reads return `recovery_attempted_at` and admit a row only in the two states
 * the pass can act on: **never attempted** (it gets its one attempt) or **attempted longer ago than
 * the ending window** (it gets its feature's ending). A row attempted recently is invisible here,
 * which is what makes the bound a property of the query rather than of the caller's memory.
 *
 * ## The endings are the features' own writers, called through their own stores
 *
 * `markEmpty`, `recordRefusal`, `abandonChunk` and `completeIfDone` already exist, are already
 * covered by their features' suites and already say what their tables' `check` constraints require.
 * Re-spelling any of them as SQL here would be a second copy of a write — so this adapter composes
 * the stores instead, and holds nothing of them beyond the methods it needs. The **marks** are this
 * module's own columns (migrations 0032 and 0036) and are written here; so is the curation's, whose
 * table has no feature store of its own beyond the claim `KnowledgeProposalStore.markCurated` makes.
 *
 * No query joins `pgboss` to ask whether a job *is* in flight, and that is a decision rather than an
 * omission: pg-boss's tables are the adapter's own and a recovery that depended on their shape would
 * break on a queue migration. The age bound is what separates *never enqueued* from *in flight*, and
 * the idempotency of each re-enqueue is what makes a wrong guess harmless.
 */
import type {
  StrandedAsk,
  StrandedAskWithEndedRun,
  StrandedBootstrapBatch,
  StrandedCuration,
  StrandedHistoryRecord,
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

interface RecordRow extends Record<string, unknown> {
  readonly chunk_id: string;
  readonly batch_id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly artifact_id: string;
  readonly recovery_attempted_at: Date | string | null;
}

interface CurationRow extends Record<string, unknown> {
  readonly artifact_id: string;
  readonly artifact_type: string;
  readonly task_id: string;
  readonly project_id: string;
  readonly recovery_attempted_at: Date | string | null;
}

interface EndedRunAskRow extends Record<string, unknown> {
  readonly id: string;
  readonly task_id: string;
  readonly project_id: string;
  readonly run_id: string;
  readonly run_status: string;
  readonly terminal_reason: string | null;
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

    strandedHistoryRecords: async (
      tx: Transaction,
      query: StrandedQuery,
    ): Promise<readonly StrandedHistoryRecord[]> => {
      const { rows } = await sqlOf(tx).query<RecordRow>(
        /**
         * A mining run that **reported** and whose findings were never written (backlog 106).
         *
         * The artifact is the join that makes this honest: a chunk with `recorded_at is null` is
         * ordinarily a run that has not finished yet, and the `HistoryFindings` row is the platform's
         * own evidence that it *did*. `abandoned_at is null` keeps a chunk this pass has already
         * given up on out, and the age bound is on the **artifact** rather than the chunk — the
         * wake-up was lost when the artifact was stored, and a chunk is created minutes earlier.
         *
         * `order by a.created_at` and `distinct on` are not both needed: `artifacts` is unique on
         * `(task_id, type, version)`, so a re-run could in principle store a second version, and the
         * **latest** is the one the lost wake-up carried.
         */
        `select distinct on (c.id)
                c.id as chunk_id, c.batch_id, c.task_id, c.recovery_attempted_at,
                b.project_id, a.id as artifact_id, a.created_at
           from history_bootstrap_chunks c
           join history_bootstrap_batches b on b.id = c.batch_id
           join artifacts a on a.task_id = c.task_id and a.type = 'HistoryFindings'
          where c.recorded_at is null
            and c.abandoned_at is null
            and a.created_at < $1::timestamptz
            and (
              c.recovery_attempted_at is null
              or c.recovery_attempted_at < $2::timestamptz
            )
          order by c.id, a.version desc
          limit $3`,
        [query.olderThan, query.endingBefore, query.limit],
      );
      return rows.map((row) => ({
        chunkId: row.chunk_id as Id,
        batchId: row.batch_id as Id,
        projectId: row.project_id as Id,
        taskId: row.task_id as Id,
        artifactId: row.artifact_id as Id,
        recoveryAttemptedAt: attemptedAt(row.recovery_attempted_at),
      }));
    },

    markHistoryRecordAttempt: async (tx, input) => {
      await sqlOf(tx).query(
        'update history_bootstrap_chunks set recovery_attempted_at = $2 where id = $1',
        [input.chunkId, input.at],
      );
    },

    endHistoryRecord: async (tx, input) => {
      // The chunk's own ending, then the batch's: `completeIfDone` counts an abandoned chunk as
      // reported (migration 0036), so this is what releases `history_bootstrap_batches_one_live`
      // and lets the project be bootstrapped again. Both through the feature's own store.
      await bootstraps.abandonChunk(tx, input.chunkId, { at: input.at, detail: input.reason });
      await bootstraps.completeIfDone(tx, input.batchId, input.at);
    },

    strandedCurations: async (
      tx: Transaction,
      query: StrandedQuery,
    ): Promise<readonly StrandedCuration[]> => {
      const { rows } = await sqlOf(tx).query<CurationRow>(
        /**
         * An artifact of a curated type with **no curation to show for it** (backlog 36).
         *
         * The left join is the mark migration 0036 added: a `knowledge_curations` row with
         * `curated_at` set is a curation that ran — including one that proposed nothing, which is
         * the case that made this site unbuildable before (standing rule 18). A row with only
         * `recovery_attempted_at` is this pass's own previous attempt, and one with `abandoned_at`
         * is a site it has already given up on.
         *
         * `artifacts_curated_types_idx` (migration 0036) is the partial index this `where` is
         * written for; without it the query would scan every artifact of every project.
         */
        `select a.id as artifact_id, a.type::text as artifact_type, a.task_id,
                t.project_id, c.recovery_attempted_at
           from artifacts a
           join tasks t on t.id = a.task_id
           left join knowledge_curations c on c.artifact_id = a.id
          where a.type in ('LibrarianProposals', 'ResearchReport')
            and a.created_at < $1::timestamptz
            and c.curated_at is null
            and c.abandoned_at is null
            and (
              c.recovery_attempted_at is null
              or c.recovery_attempted_at < $2::timestamptz
            )
          order by a.created_at
          limit $3`,
        [query.olderThan, query.endingBefore, query.limit],
      );
      return rows.map((row) => ({
        artifactId: row.artifact_id as Id,
        projectId: row.project_id as Id,
        taskId: row.task_id as Id,
        // The column is `artifact_type`, whose values the enum fixes; the two this query admits are
        // exactly the two the curation job dispatches on.
        artifactType: row.artifact_type as StrandedCuration['artifactType'],
        recoveryAttemptedAt: attemptedAt(row.recovery_attempted_at),
      }));
    },

    markCurationAttempt: async (tx, input) => {
      await sqlOf(tx).query(
        `insert into knowledge_curations (artifact_id, recovery_attempted_at)
              values ($1, $2)
         on conflict (artifact_id) do update
            set recovery_attempted_at = excluded.recovery_attempted_at`,
        [input.artifactId, input.at],
      );
    },

    endCuration: async (tx, input) => {
      await sqlOf(tx).query(
        // `curated_at is null` in the predicate: a curation that arrived between the pass's read
        // and this write keeps its row, and this ending writes nothing rather than labelling a
        // curation that ran as one the platform gave up on.
        `insert into knowledge_curations (artifact_id, abandoned_at, detail)
              values ($1, $2, $3)
         on conflict (artifact_id) do update
            set abandoned_at = excluded.abandoned_at, detail = excluded.detail
          where knowledge_curations.curated_at is null`,
        [input.artifactId, input.at, input.reason],
      );
    },

    asksWithEndedRun: async (
      tx: Transaction,
      query: StrandedQuery,
    ): Promise<readonly StrandedAskWithEndedRun[]> => {
      const { rows } = await sqlOf(tx).query<EndedRunAskRow>(
        /**
         * A question still `pending` whose run is over (backlog 121).
         *
         * `runs.ended_at` is the terminal instant — `RunRepository.finish` is the only writer of a
         * terminal row and always stamps it — so *"ended before the grace"* is both the terminal
         * test and the grace in one predicate. The grace matters here: the ask executor writes the
         * answer and the run's ending in **one** transaction, so an ask that is `pending` a
         * microsecond after its run ended is a row in flight rather than a stranded one.
         */
        `select a.id, a.task_id, a.project_id, r.id as run_id,
                r.status::text as run_status, r.terminal_reason::text as terminal_reason
           from task_asks a
           join runs r on r.id = a.run_id
          where a.status = 'pending'
            and r.ended_at is not null
            and r.ended_at < $1::timestamptz
          order by r.ended_at
          limit $2`,
        [query.olderThan, query.limit],
      );
      return rows.map((row) => ({
        askId: row.id as Id,
        taskId: row.task_id as Id,
        projectId: row.project_id as Id,
        runId: row.run_id as Id,
        runStatus: row.run_status,
        runTerminalReason: row.terminal_reason,
      }));
    },
  };
};
