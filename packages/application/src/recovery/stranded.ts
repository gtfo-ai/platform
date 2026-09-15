/**
 * The lost-wake-up class, as **one pass over a table of sites** — PROGRESS backlog **101**, which
 * carries entries **20**, **36**, **84** and **101** as four instances of one cause (WP-36's
 * criterion 10).
 *
 * ## The cause, once
 *
 * A row is committed and the job that continues it is enqueued on the **next line**, because
 * `Jobs.enqueue` does not join a transaction (TD-004). A process that dies in that window leaves
 * the row with nothing to move it: a `history_bootstrap_batches` row at `collecting` with no chunks,
 * a `task_asks` row `pending` for ever. Nothing re-emits it, nothing retries it, and nothing logs
 * it — `EventBus` logs only the case where a callback *threw*.
 *
 * ## Four sites, two of them here, and the other two named rather than silently absent
 *
 * | site | entry | what is lost | where the recovery is |
 * |---|---|---|---|
 * | history bootstrap | **101** | the whole batch, permanently | **here** — `history_bootstrap` below |
 * | ask-the-task | **84** | one question, pending for ever | **here** — `task_ask` below |
 * | intake, a matched ticket | **20** | one task never starts | `pipeline/intake-reconcile.ts`, and it stays there |
 * | curation, `artifact.created` | **36** | one task's proposals | **not built**, and the reason is below |
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
 * **Why entry 36 is deferred, stated rather than skipped** (standing rule 18): *a curation that ran
 * and proposed nothing is spelled identically to a curation that never ran*. `kb_proposals` has no
 * row in either case and the `LibrarianProposals` artifact carries no "curated" mark, so a query
 * would re-run the curation of every task whose model had nothing to say, for ever — and the
 * curation queue is `standard` with no singleton key, so the re-run would write a **second** set of
 * proposals rather than replacing the first. That site needs a mark that the curation happened
 * before a row can be written for it at all; it is still backlog 36.
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
 * *Residual, stated rather than implied*: an ask that is `pending` **with** a run attached is now
 * outside this table in both directions — it is never re-enqueued and never ended, so it stays
 * `pending`. That row is not a lost wake-up: its wake-up arrived and its run died, which is a
 * different question (*"is there a run that will never finish?"*) with a different reader
 * (`runs.status`) and no cheap idempotency. It is named here so the next reader meets the decision
 * rather than the gap.
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
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

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

/** What both queries are bounded by: the grace, the ending window and one pass's size. */
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
 * is **its own mark** (`recovery_attempted_at`, migration 0032) and each feature's **already
 * existing ending** — `markEmpty` for a batch, `recordRefusal(failed)` for an ask — which the
 * adapter reaches through those stores rather than re-spelling their SQL.
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

/**
 * One pass over both sites.
 *
 * The reads are in one transaction and the enqueues are **after** it, which is the shape every
 * enqueue in this platform has: `Jobs.enqueue` does not join a transaction, and holding one open
 * across a queue write would be the defect this whole module is about, one layer up. Each write —
 * a mark or an ending — is a transaction of its own, so one row that lost a race does not roll back
 * the others.
 *
 * **The mark is committed before the enqueue**, which is the safe order rather than the tidy one: a
 * crash between them costs that row its one attempt and it reaches its ending instead, where the
 * reverse order would let a crash loop restore exactly the unbounded re-enqueue this bound exists
 * to stop. One bounded loop is worth more than a second attempt.
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

  const found = await options.unitOfWork.transaction(async (scope) => ({
    bootstraps: await options.store.strandedBootstraps(scope.tx, query),
    asks: await options.store.strandedAsks(scope.tx, query),
  }));

  let bootstraps = 0;
  let bootstrapsEnded = 0;
  for (const batch of found.bootstraps) {
    const attempted = batch.recoveryAttemptedAt;
    if (attempted === null) {
      await options.unitOfWork.transaction(async (scope) => {
        await options.store.markBootstrapAttempt(scope.tx, { batchId: batch.batchId, at: now });
      });
      await options.jobs.enqueue({
        queue: JOB_QUEUES.historyBootstrap,
        data: { kind: 'collect', batch_id: batch.batchId, project_id: batch.projectId },
      });
      bootstraps += 1;
      logger.warn(
        { project_id: batch.projectId, batch_id: batch.batchId, older_than: olderThan },
        'a history bootstrap batch was left collecting with no chunks, so its collect job was enqueued again — once, and it is closed if that does not take (PROGRESS backlog 101, 105)',
      );
      continue;
    }
    await options.unitOfWork.transaction(async (scope) => {
      await options.store.endBootstrap(scope.tx, {
        batchId: batch.batchId,
        reason: bootstrapEndingReason(attempted),
        at: now,
      });
    });
    bootstrapsEnded += 1;
    logger.warn(
      { project_id: batch.projectId, batch_id: batch.batchId, attempted_at: attempted },
      'a history bootstrap batch did not collect after its one recovery attempt, so it was closed as empty and the project can be bootstrapped again (PROGRESS backlog 105)',
    );
  }

  let asks = 0;
  let asksEnded = 0;
  for (const ask of found.asks) {
    const attempted = ask.recoveryAttemptedAt;
    if (attempted === null) {
      await options.unitOfWork.transaction(async (scope) => {
        await options.store.markAskAttempt(scope.tx, { askId: ask.askId, at: now });
      });
      await enqueueAsk(options.jobs, {
        ask_id: ask.askId,
        task_id: ask.taskId,
        project_id: ask.projectId,
      });
      asks += 1;
      logger.warn(
        {
          project_id: ask.projectId,
          task_id: ask.taskId,
          ask_id: ask.askId,
          older_than: olderThan,
        },
        'a question was left pending with no run attached, so its ask job was enqueued again — once, and it is refused if that does not take (PROGRESS backlog 84, 105)',
      );
      continue;
    }
    await options.unitOfWork.transaction(async (scope) => {
      await options.store.endAsk(scope.tx, {
        askId: ask.askId,
        reason: askEndingReason(attempted),
      });
    });
    asksEnded += 1;
    logger.warn(
      {
        project_id: ask.projectId,
        task_id: ask.taskId,
        ask_id: ask.askId,
        attempted_at: attempted,
      },
      'a question got no run after its one recovery attempt, so it is recorded as failed rather than left pending for ever (PROGRESS backlog 105)',
    );
  }

  return [
    {
      site: 'history_bootstrap',
      found: found.bootstraps.length,
      reEnqueued: bootstraps,
      ended: bootstrapsEnded,
    },
    { site: 'task_ask', found: found.asks.length, reEnqueued: asks, ended: asksEnded },
  ];
};
