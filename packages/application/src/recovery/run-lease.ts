/**
 * The run whose process died — PROGRESS backlog **109**, the third site of `./stranded.ts`'s table.
 *
 * ## What is wrong without this
 *
 * Nothing in the build before WP-47 ever ended a run whose process vanished, and nothing detected
 * one. Both watchdogs the platform has — the wall clock and the stall detector — are armed **inside
 * the process running the query** (`runner/claude-runner.ts`), which is precisely the case they
 * cannot cover. So the row stayed `running` for ever, and since WP-40's cap fix it held its stage's
 * per-run budget for ever with it: admission values a live run at the admitting stage's
 * `reserveUsd` and there is no rollover, so **one stranded `implementation` run subtracts $15 from
 * every future daily and monthly window** of its project *and* of its organisation
 * (`DEFAULT_STAGE_RUN_BUDGET_USD`). The only lever an operator had was
 * `POST /api/runs/:run_id/cancel`, which released the reservation and **lost the spend** (backlog
 * 50) — turning a cap that read $15 too high into one that read whatever the run had burned too low.
 *
 * ## What a missing heartbeat licenses, and what this therefore does
 *
 * **Only that no process is renewing the lease.** Never that the model stopped — a session in a
 * process that lost its database connection is still running and still spending. Never that the
 * work was wasted.
 *
 * So the sweep ends the **row**, and writes nothing else — with two consequences the row's ending
 * now has, each the work of a *separate* row of the same pass rather than a write from here,
 * because a cancelled or otherwise ended run reaches the same state with no lease involved:
 *
 *  - the **question** a run was answering: `./stranded.ts`'s `task_ask_run` row (PROGRESS backlog
 *    **121**, WP-48) reads a `pending` ask whose attached run is terminal and refuses it, so the
 *    thread says what happened instead of `pending` for ever;
 *  - the run's **git credential** (PROGRESS backlog **155**, WP-77): `./run-credential.ts` finds a
 *    terminal run whose credential nothing confirmed revoked and revokes it once, by address, a
 *    pass interval after this ending. **That has a consequence for a process that is only
 *    partitioned from the database** — the caveat above: its session may still be running, and
 *    once its credential is revoked its pushes, and a take-over's export push, are refused by the
 *    provider. That is consistent with the ending rather than a second decision: the row is already
 *    terminal, the task already escalated, and nothing that process writes back will be accepted
 *    as the run's result, so cutting its access to the repository is the same conclusion reached
 *    at the provider. What it does *not* do is stop the session; a missing heartbeat still licenses
 *    nothing about that.
 *
 * The ending itself is `run.failed` with the named terminal reason
 * `lease_expired` (migration 0035), which is neither `crash` (a claim about the session) nor
 * `cancelled` (a claim about a human). The task is escalated to `needs_human` with a brief, which
 * is the stage executor's own ending for a run that produced no result — no new task state, no
 * automatic retry of a stage that may still be executing somewhere.
 *
 * And it releases the reservation **with whatever the run reported**, which for a run nobody
 * measured is *nothing*: `finish` is given `cost: null`, both cost columns stay null, the pending
 * term's `coalesce(usd_reported, usd_estimated, 0)` values the ended row at 0, and the ledger's
 * `run.failed` carries no usage and no cost so it writes **no row at all** rather than a zero
 * (standing rule 16). If the run's own process is still alive it will finish, find the row terminal
 * and write the real figure through `runs.recordCost` (`../cost/late.ts`) — which is the only path
 * by which that money can ever be known.
 *
 * ## The bound is both, and which is primary
 *
 * 1. **The lease** (primary). `lease_expires_at < now - grace`, where the grace is the pass's own
 *    interval, the same one every row of `./stranded.ts` uses: *a row that has had a full pass
 *    interval past its deadline and nothing renewed it.* At the shipped numbers that is the
 *    five-minute TTL plus a minute.
 * 2. **The wall clock** (backstop). `lease_expires_at is null and started_at < now - (wallClockMs
 *    + grace)`. It is for rows written **before this column had a writer** — every `runs` row in
 *    every database that existed before WP-47 — and for runs started by a composition that passes
 *    no `lease`. **Both compositions that start a run pass one since WP-48** (PROGRESS backlog
 *    120): the stage executor and the ask executor, from the same `RunLeaseOptions` and therefore
 *    with the same owner string, so an ask's run is reached at the lease bound (about six minutes)
 *    rather than at this one (about an hour). A living run is guaranteed to stop at the wall-clock
 *    ceiling by the in-process watchdog, so a row past it plus a grace is either dead or a runner
 *    defect, and both want this ending.
 *
 * The wall clock cannot be the primary signal: its default is an **hour**, so a process that dies a
 * minute into a run would hold the reservation for the rest of it.
 *
 * ## Why there is no attempt mark, unlike the re-enqueuing rows of the table
 *
 * `./stranded.ts`'s four re-enqueuing sites wake a job again and therefore need
 * `recovery_attempted_at` to bound how many times they may (backlog 105). This site does not re-enqueue anything: one pass
 * ends the row, the row is terminal, and the query cannot see it again. The bound is the state
 * machine's, which is stronger than a column.
 *
 * ## The claim is a row lock, not a re-read
 *
 * {@link ExpiredRunStore.claimExpiredRun} re-evaluates the whole predicate **and takes `for
 * update`** in the ending's own transaction. A `select` followed by an `update` would not be
 * enough at READ COMMITTED: a heartbeat committing between them leaves the run live and the
 * `update`'s own predicate (`status = any(active)`) still true, so the sweep would end a run whose
 * lease had just been renewed. With the lock, the heartbeat blocks until this transaction commits
 * and then writes nothing, because its own predicate no longer holds. That negative case is
 * asserted (standing rule 42).
 */
import type { Id, IsoDateTime, Slug } from '@platform/contracts';
import { agentRoleSchema, effortSchema, runModeSchema } from '@platform/contracts';
import type { CommandContext, Run } from '@platform/domain';
import { canTransitionTask, escalateTask, failRun } from '@platform/domain';
import type { PipelineStore, StoredRun } from '../pipeline/store.js';
import { retryOnTaskConflict } from '../pipeline/task-conflict.js';
import type { EventStore } from '../ports/event-store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** A run no process is renewing the lease of. */
export interface ExpiredRunLease {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly stage: Slug | null;
  readonly attempt: number;
  /** Who held it, for the log line and the brief; `null` for a row from before WP-47. */
  readonly leaseOwner: string | null;
  readonly leaseExpiresAt: IsoDateTime | null;
  readonly startedAt: IsoDateTime | null;
}

/** The double bound, as two instants the caller computes once per pass. */
export interface ExpiredRunQuery {
  /** A lease that expired before this is gone — `now - grace`. */
  readonly leaseExpiredBefore: IsoDateTime;
  /** The backstop for a run that never held a lease — `now - (wallClockMs + grace)`. */
  readonly startedBefore: IsoDateTime;
  readonly limit: number;
}

export interface ExpiredRunStore {
  /**
   * Live runs matching either half of the bound, oldest first.
   *
   * Restricted to `starting` and `running`: `created` is a pre-state the aggregate has no `failed`
   * edge from, and nothing in the tree inserts a row in it — both insert sites write the status of
   * a `markRunning` aggregate. A `created` row would therefore be a row this ending cannot express,
   * and inventing a transition for it here would put the state machine in two places.
   */
  expiredRuns(tx: Transaction, query: ExpiredRunQuery): Promise<readonly ExpiredRunLease[]>;
  /**
   * Re-evaluates the bound for one run and **locks the row** for the rest of the transaction.
   *
   * `false` is the negative case this whole mechanism turns on: between the pass's read and this
   * transaction the lease was renewed, or the run ended by itself. Nothing is written.
   */
  claimExpiredRun(
    tx: Transaction,
    input: { readonly runId: Id; readonly query: ExpiredRunQuery },
  ): Promise<boolean>;
}

export interface RunLeaseSweepOptions {
  readonly store: ExpiredRunStore;
  readonly pipeline: PipelineStore;
  readonly unitOfWork: UnitOfWork;
  readonly eventStore: Pick<EventStore, 'nextStreamSequence'>;
  /** The system actor every ending this sweep writes carries. */
  readonly context: (correlationId: Id) => CommandContext;
  readonly clock: { now(): IsoDateTime };
  /** A lease that expired less than this ago may still be renewed; equal to the pass interval. */
  readonly graceMs: number;
  /** The backstop's ceiling — a run's hard wall clock. @default runLimitsDefaults.wallClockMs */
  readonly wallClockMs: number;
  readonly limit: number;
  readonly logger?: Logger;
}

export interface RunLeaseSweepReport {
  readonly found: number;
  /** Runs this pass ended. */
  readonly ended: number;
  /** Runs whose lease was renewed, or which ended by themselves, between the read and the write. */
  readonly skipped: number;
}

/** Wall time for a run ended from outside the process that started it; `0` when it never started. */
const wallMsSince = (startedAt: IsoDateTime | null, now: IsoDateTime): number =>
  startedAt === null ? 0 : Math.max(0, Date.parse(now) - Date.parse(startedAt));

/**
 * A `StoredRun` as the Run aggregate, at the sequence the log says its stream is at.
 *
 * Every field the aggregate types more narrowly than the row does is **parsed**, not cast, for the
 * reason `commands.ts`'s twin gives: a value the enum does not have would otherwise reach an event
 * payload and be rejected by the catalogue's schema at append time. It differs from that twin in
 * one way — a `stage: null` run is accepted, because the aggregate has allowed it since WP-31 and
 * a run outside a pipeline stage can strand exactly like one inside it.
 */
const toRunAggregate = (stored: StoredRun, sequence: number): Run => ({
  id: stored.id,
  taskId: stored.taskId,
  projectId: stored.projectId,
  stage: stored.stage,
  role: agentRoleSchema.parse(stored.role),
  mode: runModeSchema.parse(stored.mode),
  attempt: stored.attempt,
  model: stored.model,
  effort: effortSchema.parse(stored.effort),
  promptVersion: stored.promptVersion,
  status: stored.status,
  startedAt: stored.startedAt,
  lastOutputAt: null,
  endedAt: null,
  terminalReason: stored.terminalReason,
  sequence,
});

const endingReason = (run: ExpiredRunLease): string =>
  run.leaseExpiresAt === null
    ? `no process has held a lease on this run and it started at ${run.startedAt ?? 'an unknown time'}, longer ago than a run's whole wall clock`
    : `the lease on this run expired at ${run.leaseExpiresAt} and no process renewed it`;

const blockerBrief = (run: ExpiredRunLease, ticketKey: string): string =>
  `A run of ${ticketKey}${run.stage === null ? '' : ` at "${run.stage}"`} was ended by the platform because ` +
  'no process was renewing its lease. That means only that nothing is driving the run — it does ' +
  'not mean the agent stopped, and the session may have kept working after the platform lost ' +
  'sight of it. Nothing was retried automatically and no cost was recorded for the attempt, ' +
  "because nobody measured it. Open the run's transcript, decide what should change, and hand the " +
  'task back at the stage you want it to resume from.';

/**
 * One pass over the runs nothing is renewing.
 *
 * Each ending is a transaction of its own — one run that lost a race does not roll back the others
 * — and each is wrapped in {@link retryOnTaskConflict}, because the ending escalates the **task**
 * and a task's `save` is versioned (WP-15e). A task whose write loses every attempt lets the
 * `TaskConflictExhaustedError` escape to the pass's caller, exactly as a job's would: the run row
 * was already made terminal by the attempt that committed, so the reservation is released either
 * way and what is lost is the escalation, which the next pass cannot redo (the run is no longer
 * live). That is stated rather than hidden, and it is the same trade `escalateTaskAfterConflict`
 * makes everywhere else.
 */
export const sweepExpiredRunLeases = async (
  options: RunLeaseSweepOptions,
): Promise<RunLeaseSweepReport> => {
  const logger = options.logger ?? silentLogger;
  const now = options.clock.now();
  const at = Date.parse(now);
  const grace = Math.max(0, options.graceMs);
  const query: ExpiredRunQuery = {
    leaseExpiredBefore: new Date(at - grace).toISOString() as IsoDateTime,
    startedBefore: new Date(at - options.wallClockMs - grace).toISOString() as IsoDateTime,
    limit: options.limit,
  };

  const found = await options.unitOfWork.transaction(async (scope) =>
    options.store.expiredRuns(scope.tx, query),
  );

  let ended = 0;
  let skipped = 0;
  for (const run of found) {
    const acted = await retryOnTaskConflict(
      {
        taskId: run.taskId,
        what: 'ending a run whose lease expired',
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      },
      async () => endOneRun(options, run, query),
    );
    if (acted) {
      ended += 1;
      logger.warn(
        {
          project_id: run.projectId,
          task_id: run.taskId,
          run_id: run.runId,
          stage: run.stage,
          lease_owner: run.leaseOwner,
          lease_expires_at: run.leaseExpiresAt,
        },
        'no process was renewing this run’s lease, so the run was failed and its task escalated; the reservation it held is released and no cost was recorded because nobody measured one (PROGRESS backlog 109)',
      );
      continue;
    }
    skipped += 1;
  }
  return { found: found.length, ended, skipped };
};

const endOneRun = async (
  options: RunLeaseSweepOptions,
  run: ExpiredRunLease,
  query: ExpiredRunQuery,
): Promise<boolean> =>
  options.unitOfWork.transaction(async (scope) => {
    const claimed = await options.store.claimExpiredRun(scope.tx, { runId: run.runId, query });
    if (!claimed) {
      return false;
    }
    const stored = await options.pipeline.runs.load(scope.tx, run.runId);
    if (stored === null) {
      return false;
    }
    const now = options.clock.now();
    const context = options.context(run.taskId);
    const won = await options.pipeline.runs.finish(scope.tx, {
      runId: run.runId,
      status: 'failed',
      terminalReason: 'lease_expired',
      sessionId: stored.sessionId,
      numTurns: stored.numTurns,
      // The row's own zeros: nothing here measured this run's usage, and the `runs` columns are
      // already what they were. What must **not** happen is a cost — see the module docblock.
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        cache_write_5m_tokens: 0,
        cache_write_1h_tokens: 0,
        cache_read_tokens: 0,
      },
      cost: null,
      wallMs: wallMsSince(stored.startedAt, now),
    });
    if (!won) {
      return false;
    }
    const aggregate = toRunAggregate(
      stored,
      await options.eventStore.nextStreamSequence('run', run.runId),
    );
    const failed = failRun(
      aggregate,
      {
        status: 'failed',
        terminalReason: 'lease_expired',
        error: endingReason(run),
        // No `usage` and no `cost`: both are optional on this input and both become `null` in the
        // payload, which is what makes the cost ledger's `no_usage_and_no_cost` branch the right
        // one. A `{ usd: 0 }` here would be published as a free run.
      },
      context,
    );
    const events = [...failed.events];

    const task = await options.pipeline.tasks.load(scope.tx, run.taskId);
    if (task !== null && canTransitionTask(task.task.state, 'needs_human')) {
      const escalated = escalateTask(
        task.task,
        {
          reason: `run ${run.runId}: ${endingReason(run)}`,
          blockerBrief: blockerBrief(run, task.task.ticket.key),
        },
        context,
      );
      await options.pipeline.tasks.save(scope.tx, { ...task, task: escalated.aggregate });
      if (run.stage !== null) {
        await options.pipeline.tasks.recordStageExited(scope.tx, {
          taskId: run.taskId,
          stage: run.stage,
          attempt: run.attempt,
          outcome: 'failed',
          returnReason: endingReason(run),
        });
      }
      events.push(...escalated.events);
    }
    await scope.events.append(events);
    return true;
  });
