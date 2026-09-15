/**
 * The lost-wake-up class, as **one pass over a table of sites** — PROGRESS backlog **101**, which
 * carries entries **20**, **36**, **84**, **101** and **106** as five instances of one cause
 * (WP-36's criterion 10, completed at WP-48).
 *
 * ## The cause, once
 *
 * A row is committed and the job that continues it is enqueued on the **next line**, because
 * `Jobs.enqueue` does not join a transaction (TD-004). A process that dies in that window leaves
 * the row with nothing to move it: a `history_bootstrap_batches` row at `collecting` with no chunks,
 * a `task_asks` row `pending` for ever. Nothing re-emits it, nothing retries it, and nothing logs
 * it — `EventBus` logs only the case where a callback *threw*.
 *
 * ## Six sites, five of them here, and the sixth named rather than silently absent
 *
 * | site | entry | what is lost | where the recovery is |
 * |---|---|---|---|
 * | history bootstrap, `collect` | **101** | the whole batch, permanently | **here** — `history_bootstrap` below |
 * | history bootstrap, `record` | **106** | one mining run's findings, and the batch never completes | **here** — `history_record` below |
 * | curation, `artifact.created` | **36** | one task's proposals | **here** — `knowledge_curation` below |
 * | ask-the-task | **84** | one question, pending for ever | **here** — `task_ask` below |
 * | a run nothing is driving | **109** | the run's row *and its budget reservation*, for ever | **here** — `run_lease`, in `./run-lease.ts` |
 * | intake, a matched ticket | **20** | one task never starts | `pipeline/intake-reconcile.ts`, and it stays there |
 *
 * …plus one row that is **not** a lost wake-up at all and rides the same pass because it is the
 * other half of one of them: `task_ask_run` (**121**), a question still `pending` whose run is
 * already terminal.
 *
 * **The run row is a different shape from the re-enqueuing ones, and that is why its body is its
 * own module** (WP-47). Their contract is *"find the row, enqueue the wake-up"*, bounded by an
 * attempt mark; a run whose process vanished has no wake-up to re-enqueue — there is nothing left
 * to wake — so the recovery is an **ending** rather than a retry: `run.failed` with the terminal
 * reason `lease_expired`, and the task escalated. It needs no `recovery_attempted_at` for the same
 * reason, because a terminal run cannot be found by the query twice. It rides this pass because
 * backlog 101's argument is about *timers*: one pass, one interval, one grace period, one pooled
 * connection. `./run-lease.ts` carries the whole of what a missing heartbeat does and does not
 * license anybody to conclude.
 *
 * **Why entry 20 is not a row of this table.** Its remedy is not a re-enqueue: the wake-up it lost
 * was an `afterCommit` callback of an event *handler*, and re-dispatching that event position is
 * skipped by its `handler_executions` record, so the recovery has to append a **new**
 * `ticket.matched` and mark it with a system actor so the next pass can tell a recovery from a
 * fresh match. That is an event-log operation with its own once-per-ticket bound, not a job
 * enqueue, and folding it into a table whose contract is *"find the row, enqueue the wake-up"* would
 * mean either widening the contract until it says nothing or re-deriving the mark. It runs on the
 * **same timer** as this table (`intakeReconcileHandler` calls both), which is what backlog 101 asks
 * for: one pass, one interval, one pool reservation.
 *
 * ## What each row owes: what to look for, how to re-enqueue, **what bounds it**
 *
 * The third of those was missing when this module shipped and is PROGRESS backlog **105**: the pass
 * wrote nothing, so the queries could not tell a row it had already recovered from one it had never
 * seen, and a row whose re-enqueued job *also* failed to move it was re-enqueued on every pass, for
 * ever, at `APP_INTAKE_RECONCILE_INTERVAL_MS` — a minute on the shipped defaults. Idempotency was
 * doing the only bounding, and idempotency bounds the effect of **one duplicate**, not the number of
 * attempts.
 *
 *  - **history bootstrap** (entry 101): a batch at `collecting` with **no chunk rows**, older than
 *    the interval. A second `collect` for a batch that did run creates no second set of tasks:
 *    `collectHistory` refuses a batch whose status is not `collecting`, and `(batch_id,
 *    chunk_index)` is unique. **Bounded** by `history_bootstrap_batches.recovery_attempted_at`
 *    (migration 0032): one attempt, and then — when the batch has not moved a whole ending window
 *    later — the ending backlog 101 named, `markEmpty` with the reason, because a batch nobody can
 *    clear is worse than a batch that says it failed (`history_bootstrap_batches_one_live` makes a
 *    batch stuck at `collecting` a permanent `already_running` for that project).
 *  - **history record** (entry 106, WP-48): a chunk with `recorded_at is null` whose task carries a
 *    `HistoryFindings` artifact older than the interval. A second `record` writes no second set of
 *    proposals: `markChunkRecorded` has `recorded_at is null` in its predicate and the whole
 *    transaction hangs off that claim. **Bounded** by `history_bootstrap_chunks.
 *    recovery_attempted_at` (migration 0036), ending in `abandonChunk` plus `completeIfDone` —
 *    because this loss bricks the project exactly as entry 101's does, one wake-up later: the batch
 *    never completes, and the same unique index then refuses every later bootstrap.
 *  - **curation** (entry 36, WP-48): an artifact of a curated type with **no `knowledge_curations`
 *    row**, older than the interval. That table is the mark the entry said this site could not do
 *    without (standing rule 18 — *a curation that ran and proposed nothing is spelled identically to
 *    one that never ran*), and because it is keyed on the artifact and claimed inside the curation's
 *    own write transaction, it is also what makes a re-enqueue safe: a second delivery writes **one**
 *    set of proposals, not two. **Bounded** by `knowledge_curations.recovery_attempted_at`, ending
 *    in `abandoned_at` with the reason, because a task's proposals are notification-shaped (rule 20)
 *    and re-running a curation for ever costs a model call a minute.
 *  - **ask** (entry 84): a `pending` ask **with no run attached**, older than the interval
 *    (`task_asks_pending_idx` exists for exactly this query). `enqueueAsk` is `stately` with
 *    `singletonKey: ask:<id>`, so a redelivered wake-up for a question already in flight collapses
 *    rather than starting a second paid run. **Bounded** by `task_asks.recovery_attempted_at` the
 *    same way, ending in `recordRefusal(failed)` so the thread says the platform could not run it
 *    rather than staying `pending` for ever.
 *
 * **`run_id is null` is the whole of "the wake-up never arrived", and it is a fix rather than a
 * narrowing** (backlog 105). An ask keeps `status = 'pending'` until a run answers it, and
 * `attachRun` fills `run_id` in the transaction that creates that run — so a query that asked only
 * *"pending and old"* found **every** ask whose run was still working after the grace, logged a
 * `warn` that was false about that row, and re-enqueued it. While a run is in flight the singleton
 * key collapses the repeat; but for an ask left `pending` by a run **another writer ended** — a
 * measured case, `ask-pipeline.test.ts`'s *"an ask whose run somebody else ended first"* — nothing
 * collapsed anything and the next pass started a **second paid run**, once a minute, with the ask
 * budget never firing because a run that wrote no answer wrote no `cost_entries` row either.
 *
 * *The residual that fix left is **closed at WP-48**, and this is what closed it*: an ask that is
 * `pending` **with** a run attached is the `task_ask_run` row above. WP-47 gave the *run* half an
 * owner — the `run_lease` sweep ends a run nothing is driving — and nothing turned that ending into
 * an ending for the **question**, so the thread said `pending` for ever (backlog **121**). It is an
 * ending and not a retry for the reason the run row is: the run it was waiting for is over, and
 * starting another would be a new paid run for a question whose asker was told nothing. It needs no
 * attempt mark, because `recordRefusal` moves the ask off `pending` and the query cannot find it
 * twice.
 *
 * ## The grace period is the interval, and that is one knob rather than two
 *
 * `intake-reconcile.ts` carries the reasoning and this module takes it unchanged: *a row that has
 * had a full pass interval to produce its effect and has not*. A row younger than that still has its
 * own job in flight, and re-enqueuing it would race the work it is waiting for.
 *
 * The **ending** window is deliberately not that number — see {@link STRANDED_ENDING_AFTER_MS}.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { enqueueAsk } from '../ask/commands.js';
import { enqueueCuration } from '../knowledge/librarian.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { RunLeaseSweepOptions } from './run-lease.js';
import { sweepExpiredRunLeases } from './run-lease.js';

/** A history bootstrap batch whose `collect` wake-up was lost (backlog 101). */
export interface StrandedBootstrapBatch {
  readonly batchId: Id;
  readonly projectId: Id;
  /** `null` until this pass has spent the row's one attempt (migration 0032, backlog 105). */
  readonly recoveryAttemptedAt: IsoDateTime | null;
}

/** An ask whose run wake-up was lost (backlog 84). */
export interface StrandedAsk {
  readonly askId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  /** `null` until this pass has spent the row's one attempt (migration 0032, backlog 105). */
  readonly recoveryAttemptedAt: IsoDateTime | null;
}

/**
 * A mining run whose `record` wake-up was lost (backlog 106).
 *
 * The chunk is the row that is stuck, and the **artifact** is what the wake-up carried: the job's
 * payload is `{kind: 'record', project_id, task_id, artifact_id}`, so the query has to answer with
 * the `HistoryFindings` artifact the run actually stored rather than let the pass guess one.
 */
export interface StrandedHistoryRecord {
  readonly chunkId: Id;
  readonly batchId: Id;
  readonly projectId: Id;
  readonly taskId: Id;
  readonly artifactId: Id;
  /** `null` until this pass has spent the row's one attempt (migration 0036, backlog 105). */
  readonly recoveryAttemptedAt: IsoDateTime | null;
}

/** A curation whose wake-up was lost (backlog 36). */
export interface StrandedCuration {
  readonly artifactId: Id;
  readonly projectId: Id;
  readonly taskId: Id;
  /** Which curation this artifact needs — the job dispatches on it (`knowledge/runtime.ts`). */
  readonly artifactType: 'LibrarianProposals' | 'ResearchReport';
  /** `null` until this pass has spent the row's one attempt (migration 0036, backlog 105). */
  readonly recoveryAttemptedAt: IsoDateTime | null;
}

/**
 * A question still `pending` whose run is **terminal** (backlog 121).
 *
 * The row {@link StrandedAsk} cannot see by construction: that query is *"pending with **no** run
 * attached"*, and this ask has one — a run somebody cancelled, or one the lease sweep ended. There
 * is no wake-up to re-enqueue and nothing to bound: the run it was waiting for is over, so the ask
 * is ended rather than retried.
 */
export interface StrandedAskWithEndedRun {
  readonly askId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly runId: Id;
  /** The run's own terminal status and reason, which the ask's refusal quotes. */
  readonly runStatus: string;
  readonly runTerminalReason: string | null;
}

/**
 * What every query-shaped site is bounded by: the grace, one pass's size, and the ending window
 * where the site has one (`asksWithEndedRun` has no mark and no attempt, so it ignores it).
 */
export interface StrandedQuery {
  /** A row younger than this still has its own job in flight. */
  readonly olderThan: IsoDateTime;
  /** A row whose attempt is older than this has had its one attempt and did not move. */
  readonly endingBefore: IsoDateTime;
  readonly limit: number;
}

/**
 * The queries and the two writes each site's bound needs, as a port.
 *
 * Reads and writes of *other features'* tables, which is why they are a port of their own rather
 * than methods on `HistoryBootstrapStore` and `AskStore`: those two are the stores their features
 * write through, and a recovery pass has no business holding a writer for either. What it does hold
 * is **its own mark** (`recovery_attempted_at`, migration 0032) and each feature's **ending** —
 * `markEmpty` for a batch and `recordRefusal(failed)` for an ask, which pre-existed, and
 * `abandonChunk` for a chunk and `endCuration` for a curation, which WP-48 added beside migration
 * 0036 — which the adapter reaches through those stores rather than re-spelling their SQL, except
 * the curation's: `knowledge_curations` has no feature store, so the adapter spells that insert
 * itself and says so in its own docblock.
 */
export interface StrandedWorkStore {
  /** Batches at `collecting` with no chunk rows, older than `olderThan`. */
  strandedBootstraps(
    tx: Transaction,
    query: StrandedQuery,
  ): Promise<readonly StrandedBootstrapBatch[]>;
  /** Records this pass's one attempt, which is what the next pass reads. */
  markBootstrapAttempt(
    tx: Transaction,
    input: { readonly batchId: Id; readonly at: IsoDateTime },
  ): Promise<void>;
  /** The ending: `markEmpty`, so the project's one live batch is released with a reason. */
  endBootstrap(
    tx: Transaction,
    input: { readonly batchId: Id; readonly reason: string; readonly at: IsoDateTime },
  ): Promise<void>;
  /** Asks still `pending` with no run attached, older than `olderThan`. */
  strandedAsks(tx: Transaction, query: StrandedQuery): Promise<readonly StrandedAsk[]>;
  /** Records this pass's one attempt, which is what the next pass reads. */
  markAskAttempt(
    tx: Transaction,
    input: { readonly askId: Id; readonly at: IsoDateTime },
  ): Promise<void>;
  /** The ending: `recordRefusal(failed)`, so the thread says so instead of staying `pending`. */
  endAsk(tx: Transaction, input: { readonly askId: Id; readonly reason: string }): Promise<void>;
  /** Chunks with no findings recorded whose task's `HistoryFindings` artifact is older than the grace. */
  strandedHistoryRecords(
    tx: Transaction,
    query: StrandedQuery,
  ): Promise<readonly StrandedHistoryRecord[]>;
  /** Records this pass's one attempt, which is what the next pass reads. */
  markHistoryRecordAttempt(
    tx: Transaction,
    input: { readonly chunkId: Id; readonly at: IsoDateTime },
  ): Promise<void>;
  /**
   * The ending: the chunk is abandoned with a reason **and the batch is completed if that was the
   * last one it was waiting for**, which is what releases `history_bootstrap_batches_one_live`.
   */
  endHistoryRecord(
    tx: Transaction,
    input: {
      readonly chunkId: Id;
      readonly batchId: Id;
      readonly reason: string;
      readonly at: IsoDateTime;
    },
  ): Promise<void>;
  /** Artifacts of a curated type with no `knowledge_curations` row, older than the grace. */
  strandedCurations(tx: Transaction, query: StrandedQuery): Promise<readonly StrandedCuration[]>;
  /** Records this pass's one attempt, which is what the next pass reads. */
  markCurationAttempt(
    tx: Transaction,
    input: { readonly artifactId: Id; readonly at: IsoDateTime },
  ): Promise<void>;
  /** The ending: the curation is given up on, with the reason on the row. */
  endCuration(
    tx: Transaction,
    input: { readonly artifactId: Id; readonly reason: string; readonly at: IsoDateTime },
  ): Promise<void>;
  /** Asks still `pending` whose attached run ended before `olderThan` (backlog 121). */
  asksWithEndedRun(
    tx: Transaction,
    query: StrandedQuery,
  ): Promise<readonly StrandedAskWithEndedRun[]>;
}

export interface StrandedRecoveryOptions {
  readonly store: StrandedWorkStore;
  readonly unitOfWork: UnitOfWork;
  readonly jobs: Jobs;
  readonly clock: { now(): IsoDateTime };
  /** A row younger than this still has its own job in flight. Equal to the pass interval. */
  readonly graceMs: number;
  /** How many rows **per site** one pass may act on. @default 50 */
  readonly limit?: number;
  /**
   * The run site: runs no process is renewing the lease of (backlog **109**, `./run-lease.ts`).
   *
   * **Absent is "runs are not swept"**, which is what every build before WP-47 did — a dead run
   * stayed `running` for ever and held its stage's budget with it. It is optional because this
   * site needs collaborators the query-shaped sites do not (the whole `PipelineStore`, the event
   * store and a command context: it ends an aggregate rather than enqueuing a job or ending a row
   * through a feature's own store), so a composition that has no pipeline can still recover the
   * five sites that are only queries.
   */
  readonly runs?: Omit<RunLeaseSweepOptions, 'clock' | 'graceMs' | 'limit' | 'logger'>;
  readonly logger?: Logger;
}

export const DEFAULT_STRANDED_LIMIT = 50;

/**
 * How long after its one attempt a row that has not moved is **ended** rather than re-enqueued.
 *
 * Not the grace, and the difference is the point. The grace answers *"has this row had time to
 * produce its own effect?"* — a minute is plenty, because the question is whether a job exists at
 * all. The ending answers *"did the job I enqueued fail to produce it?"*, and being early there
 * costs work that was about to happen: an ending fires `markEmpty` / `recordRefusal`, and both are
 * visible to the operator.
 *
 * So it is the longest a re-enqueued job can legitimately take to touch its row, rounded up:
 * `task.ask` runs at concurrency **1** with a 30-minute expiry, so a queued ask can sit behind
 * another ask's whole lease before admission attaches its run; `bootstrap.history` retries twice
 * from 60 s with backoff before pg-boss gives up. An hour is longer than either with slack. The
 * cost of being late is that a genuinely dead row says `pending` (or `collecting`) for an hour
 * rather than a minute — and it is already saying it, because nothing ended it before this.
 *
 * `max(graceMs, …)` rather than the constant alone, so an operator who sets the pass interval
 * *longer* than an hour does not get an ending before the second pass that would read it.
 */
export const STRANDED_ENDING_AFTER_MS = 60 * 60_000;

export interface StrandedSiteReport {
  readonly site: string;
  /** Rows this pass acted on: one attempt each, or one ending each. */
  readonly found: number;
  readonly reEnqueued: number;
  /** Rows whose one attempt did not take, which this pass gave their feature's ending. */
  readonly ended: number;
}

export type StrandedRecoveryReport = readonly StrandedSiteReport[];

const bootstrapEndingReason = (attemptedAt: IsoDateTime): string =>
  `the platform re-enqueued this bootstrap’s collection at ${attemptedAt} after its wake-up was lost, and the batch never collected anything; it is closed so a new bootstrap can be started for this project (PROGRESS backlog 105)`;

const askEndingReason = (attemptedAt: IsoDateTime): string =>
  `the platform re-enqueued this question’s run at ${attemptedAt} after its wake-up was lost, and no run ever started; ask again (PROGRESS backlog 105)`;

const recordEndingReason = (attemptedAt: IsoDateTime): string =>
  `the platform re-enqueued this mining run’s findings at ${attemptedAt} after its wake-up was lost, and they were never recorded; the batch is closed without them so this project can be bootstrapped again (PROGRESS backlog 106, 105)`;

const curationEndingReason = (attemptedAt: IsoDateTime): string =>
  `the platform re-enqueued this artifact’s curation at ${attemptedAt} after its wake-up was lost, and it never ran; this task’s knowledge proposals were not recorded (PROGRESS backlog 36, 105)`;

/**
 * Why a question the platform has given up on says so, quoting the run's **own** ending.
 *
 * Both strings are platform enum values (`run_status`, `run_terminal_reason`), not model or
 * provider text: the reason is stored on `task_asks` and shown in the thread, and this module has
 * no redactor.
 */
const askRunEndingReason = (ask: StrandedAskWithEndedRun): string =>
  `the run answering this question ended “${ask.runStatus}”${
    ask.runTerminalReason === null ? '' : ` (${ask.runTerminalReason})`
  } without writing an answer; ask again (PROGRESS backlog 121)`;

/**
 * One row's worth of the shape **four** of the five sites share.
 *
 * *Has this row been attempted?* No → mark it, then wake it. Yes, and long enough ago → end it.
 * Written once rather than four times, because the ordering below is the part that is easy to get
 * subtly wrong and a fourth copy is a fourth place to get it wrong in (standing rule 7).
 */
interface AttemptOrEndSite<TRow> {
  /** The name this site reports under; it appears in the pass's log line. */
  readonly site: string;
  readonly rows: readonly TRow[];
  attemptedAt(row: TRow): IsoDateTime | null;
  /** The mark, in a transaction of its own, committed **before** the wake-up. */
  mark(row: TRow): Promise<void>;
  /** The wake-up — an enqueue, therefore outside every transaction (TD-004). */
  wake(row: TRow): Promise<void>;
  /** The feature's own ending, in a transaction of its own. */
  end(row: TRow, attemptedAt: IsoDateTime): Promise<void>;
  logWake(row: TRow): void;
  logEnd(row: TRow, attemptedAt: IsoDateTime): void;
}

/**
 * The attempt-or-end loop, and the ordering that makes the bound hold.
 *
 * **The mark is committed before the enqueue**, which is the safe order rather than the tidy one: a
 * crash between them costs that row its one attempt and it reaches its ending instead, where the
 * reverse order would let a crash loop restore exactly the unbounded re-enqueue this bound exists
 * to stop. One bounded loop is worth more than a second attempt.
 */
const runAttemptOrEndSite = async <TRow>(
  site: AttemptOrEndSite<TRow>,
): Promise<StrandedSiteReport> => {
  let reEnqueued = 0;
  let ended = 0;
  for (const row of site.rows) {
    const attempted = site.attemptedAt(row);
    if (attempted === null) {
      await site.mark(row);
      await site.wake(row);
      reEnqueued += 1;
      site.logWake(row);
      continue;
    }
    await site.end(row, attempted);
    ended += 1;
    site.logEnd(row, attempted);
  }
  return { site: site.site, found: site.rows.length, reEnqueued, ended };
};

/**
 * One pass over every site.
 *
 * The reads are in one transaction and the enqueues are **after** it, which is the shape every
 * enqueue in this platform has: `Jobs.enqueue` does not join a transaction, and holding one open
 * across a queue write would be the defect this whole module is about, one layer up. Each write —
 * a mark or an ending — is a transaction of its own, so one row that lost a race does not roll back
 * the others.
 */
export const runStrandedRecovery = async (
  options: StrandedRecoveryOptions,
): Promise<StrandedRecoveryReport> => {
  const logger = options.logger ?? silentLogger;
  const limit = options.limit ?? DEFAULT_STRANDED_LIMIT;
  const now = options.clock.now();
  const at = Date.parse(now);
  const grace = Math.max(0, options.graceMs);
  const olderThan = new Date(at - grace).toISOString() as IsoDateTime;
  const endingBefore = new Date(
    at - Math.max(grace, STRANDED_ENDING_AFTER_MS),
  ).toISOString() as IsoDateTime;
  const query: StrandedQuery = { olderThan, endingBefore, limit };
  const write = async (fn: (tx: Transaction) => Promise<void>): Promise<void> => {
    await options.unitOfWork.transaction(async (scope) => fn(scope.tx));
  };

  // One transaction, every query: backlog 101's argument is about the pass being *one* pooled
  // connection, and five reads in five transactions would be five borrows for the same answer.
  const found = await options.unitOfWork.transaction(async (scope) => ({
    bootstraps: await options.store.strandedBootstraps(scope.tx, query),
    asks: await options.store.strandedAsks(scope.tx, query),
    records: await options.store.strandedHistoryRecords(scope.tx, query),
    curations: await options.store.strandedCurations(scope.tx, query),
    endedRunAsks: await options.store.asksWithEndedRun(scope.tx, query),
  }));

  const sites: StrandedSiteReport[] = [
    await runAttemptOrEndSite<StrandedBootstrapBatch>({
      site: 'history_bootstrap',
      rows: found.bootstraps,
      attemptedAt: (batch) => batch.recoveryAttemptedAt,
      mark: async (batch) =>
        write(async (tx) =>
          options.store.markBootstrapAttempt(tx, { batchId: batch.batchId, at: now }),
        ),
      wake: async (batch) => {
        await options.jobs.enqueue({
          queue: JOB_QUEUES.historyBootstrap,
          data: { kind: 'collect', batch_id: batch.batchId, project_id: batch.projectId },
        });
      },
      end: async (batch, attempted) =>
        write(async (tx) =>
          options.store.endBootstrap(tx, {
            batchId: batch.batchId,
            reason: bootstrapEndingReason(attempted),
            at: now,
          }),
        ),
      logWake: (batch) =>
        logger.warn(
          { project_id: batch.projectId, batch_id: batch.batchId, older_than: olderThan },
          'a history bootstrap batch was left collecting with no chunks, so its collect job was enqueued again — once, and it is closed if that does not take (PROGRESS backlog 101, 105)',
        ),
      logEnd: (batch, attempted) =>
        logger.warn(
          { project_id: batch.projectId, batch_id: batch.batchId, attempted_at: attempted },
          'a history bootstrap batch did not collect after its one recovery attempt, so it was closed as empty and the project can be bootstrapped again (PROGRESS backlog 105)',
        ),
    }),

    await runAttemptOrEndSite<StrandedAsk>({
      site: 'task_ask',
      rows: found.asks,
      attemptedAt: (ask) => ask.recoveryAttemptedAt,
      mark: async (ask) =>
        write(async (tx) => options.store.markAskAttempt(tx, { askId: ask.askId, at: now })),
      wake: async (ask) =>
        enqueueAsk(options.jobs, {
          ask_id: ask.askId,
          task_id: ask.taskId,
          project_id: ask.projectId,
        }),
      end: async (ask, attempted) =>
        write(async (tx) =>
          options.store.endAsk(tx, { askId: ask.askId, reason: askEndingReason(attempted) }),
        ),
      logWake: (ask) =>
        logger.warn(
          {
            project_id: ask.projectId,
            task_id: ask.taskId,
            ask_id: ask.askId,
            older_than: olderThan,
          },
          'a question was left pending with no run attached, so its ask job was enqueued again — once, and it is refused if that does not take (PROGRESS backlog 84, 105)',
        ),
      logEnd: (ask, attempted) =>
        logger.warn(
          {
            project_id: ask.projectId,
            task_id: ask.taskId,
            ask_id: ask.askId,
            attempted_at: attempted,
          },
          'a question got no run after its one recovery attempt, so it is recorded as failed rather than left pending for ever (PROGRESS backlog 105)',
        ),
    }),

    await runAttemptOrEndSite<StrandedHistoryRecord>({
      site: 'history_record',
      rows: found.records,
      attemptedAt: (chunk) => chunk.recoveryAttemptedAt,
      mark: async (chunk) =>
        write(async (tx) =>
          options.store.markHistoryRecordAttempt(tx, { chunkId: chunk.chunkId, at: now }),
        ),
      wake: async (chunk) => {
        await options.jobs.enqueue({
          queue: JOB_QUEUES.historyBootstrap,
          // The payload `record.ts`'s handler builds, rebuilt from the row rather than remembered:
          // a job is a wake-up and re-reads committed state when it fires (TD-004).
          data: {
            kind: 'record',
            project_id: chunk.projectId,
            task_id: chunk.taskId,
            artifact_id: chunk.artifactId,
          },
        });
      },
      end: async (chunk, attempted) =>
        write(async (tx) =>
          options.store.endHistoryRecord(tx, {
            chunkId: chunk.chunkId,
            batchId: chunk.batchId,
            reason: recordEndingReason(attempted),
            at: now,
          }),
        ),
      logWake: (chunk) =>
        logger.warn(
          {
            project_id: chunk.projectId,
            task_id: chunk.taskId,
            batch_id: chunk.batchId,
            older_than: olderThan,
          },
          'a mining run reported findings that were never recorded, so the record job was enqueued again — once, and the batch is closed without them if that does not take (PROGRESS backlog 106, 105)',
        ),
      logEnd: (chunk, attempted) =>
        logger.warn(
          {
            project_id: chunk.projectId,
            task_id: chunk.taskId,
            batch_id: chunk.batchId,
            attempted_at: attempted,
          },
          'a mining run’s findings never reached the proposal queue after one recovery attempt, so the chunk is closed without them and the batch can finish (PROGRESS backlog 106, 105)',
        ),
    }),

    await runAttemptOrEndSite<StrandedCuration>({
      site: 'knowledge_curation',
      rows: found.curations,
      attemptedAt: (curation) => curation.recoveryAttemptedAt,
      mark: async (curation) =>
        write(async (tx) =>
          options.store.markCurationAttempt(tx, { artifactId: curation.artifactId, at: now }),
        ),
      wake: async (curation) =>
        enqueueCuration(options.jobs, {
          project_id: curation.projectId,
          task_id: curation.taskId,
          artifact_id: curation.artifactId,
          artifact_type: curation.artifactType,
        }),
      end: async (curation, attempted) =>
        write(async (tx) =>
          options.store.endCuration(tx, {
            artifactId: curation.artifactId,
            reason: curationEndingReason(attempted),
            at: now,
          }),
        ),
      logWake: (curation) =>
        logger.warn(
          {
            project_id: curation.projectId,
            task_id: curation.taskId,
            artifact_id: curation.artifactId,
            artifact_type: curation.artifactType,
            older_than: olderThan,
          },
          'an artifact was stored and never curated, so the curation job was enqueued again — once, and it is given up on if that does not take (PROGRESS backlog 36, 105)',
        ),
      logEnd: (curation, attempted) =>
        logger.warn(
          {
            project_id: curation.projectId,
            task_id: curation.taskId,
            artifact_id: curation.artifactId,
            attempted_at: attempted,
          },
          'an artifact’s curation never ran after one recovery attempt, so this task’s knowledge proposals are recorded as lost rather than retried for ever (PROGRESS backlog 36, 105)',
        ),
    }),
  ];

  /**
   * The fifth site **ends** rather than re-enqueues, so it has no mark and no attempt (backlog 121).
   *
   * There is nothing to wake: the run this question was waiting for is terminal — a human cancelled
   * it, or the lease sweep ended it — and re-running it would be a *new* paid run for a question
   * whose asker was told nothing. The bound is the ask's own state machine, exactly as the run
   * row's is: `recordRefusal` moves it off `pending`, so the query cannot find it twice.
   */
  let asksEndedByRun = 0;
  for (const ask of found.endedRunAsks) {
    await write(async (tx) =>
      options.store.endAsk(tx, { askId: ask.askId, reason: askRunEndingReason(ask) }),
    );
    asksEndedByRun += 1;
    logger.warn(
      {
        project_id: ask.projectId,
        task_id: ask.taskId,
        ask_id: ask.askId,
        run_id: ask.runId,
        run_status: ask.runStatus,
        terminal_reason: ask.runTerminalReason,
      },
      'the run answering this question ended without an answer, so the question is recorded as failed rather than left pending for ever (PROGRESS backlog 121)',
    );
  }
  sites.push({
    site: 'task_ask_run',
    found: found.endedRunAsks.length,
    reEnqueued: 0,
    ended: asksEndedByRun,
  });

  if (options.runs !== undefined) {
    // The run site ends rows rather than re-enqueuing wake-ups, so `reEnqueued` is 0 by
    // construction and `ended` is the whole of what it did — which is why its own report has a
    // `skipped` count this shape has nowhere to put, and why that count is in its log line.
    const runs = await sweepExpiredRunLeases({
      ...options.runs,
      clock: options.clock,
      graceMs: grace,
      limit,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    sites.push({ site: 'run_lease', found: runs.found, reEnqueued: 0, ended: runs.ended });
  }

  return sites;
};
