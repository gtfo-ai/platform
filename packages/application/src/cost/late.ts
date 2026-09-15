/**
 * What a run that was ended by somebody else still owes the ledger — **Q70 (b)**, PROGRESS backlog
 * **50**, and the other half of backlog **109**.
 *
 * ## The loss, exactly
 *
 * Two things can end a run that is still executing, and neither of them knows what it cost.
 * `POST /api/runs/:run_id/cancel` writes `{ usd: 0, is_estimate: true }` because an HTTP request
 * has no way to reach the session; the lease sweep (`../recovery/run-lease.ts`) writes no figure at
 * all, because a missing heartbeat says nothing about spend. Either way the run's own terminal
 * event carries no usage, the ledger takes its `no_spend` / `no_usage_and_no_cost` branch, and
 * **nothing moves** — not `cost_entries`, not `cost_rollup_daily`, not `run_model_usage` and not a
 * single budget window. A run cancelled at 90 % of a daily cap leaves the cap looking untouched.
 *
 * The process that *ran* the session knows the number exactly, and is refused the write: its
 * `RunRepository.finish` is conditional on the run still being live, which is what stops a stage
 * executor overwriting a human's `cancelled` (WP-15e's lost update, one table across). So the
 * money is known and unwritable — until this module.
 *
 * ## The mechanism, and why it is this one
 *
 * Q70 offered two shapes: a **narrow `runs.recordCost` write** the losing process may make against
 * an already-terminal row, or a **cost-correction event** the technical/02 catalogue does not have.
 * WP-47 implements the first, and the second is not merely "cheaper": a second terminal event on a
 * run's stream would be read by every consumer of `run.finished` as a second ending, and the
 * catalogue has no type that means *"the same ending, with the number filled in"*.
 *
 * So the shape is: the losing process writes the cost onto the terminal row
 * ({@link PipelineStore.runs.recordCost}, which refuses a live run, a row that already carries a
 * figure and a run the ledger has already charged) and, **in the same transaction**, charges the
 * ledger through the ledger's own body ({@link chargeRunSpend}). One transaction, so a row that
 * says "this run cost $2" and a ledger that never heard of it is not a state this can produce.
 *
 * ## Labelled, not merged
 *
 * `cost_entries.late` is `true` for every row written here (migration 0035). An operator
 * reconciling an invoice is asking a different question of a charge the ledger made when the run
 * ended and one it made afterwards, and merging the two would answer both with the first.
 *
 * ## What it cannot do
 *
 * It needs a process that survived the run. A run whose process really died — the case the lease
 * sweep exists for — has nobody left to call this, and its spend is **genuinely unknown**: the
 * platform writes no figure and no ledger row rather than a zero (standing rule 16). That is the
 * residual, and it is the honest one: the alternative would be publishing "this run was free".
 */
import type { Id, IsoDateTime, ModelUsage, RunCost, TokenUsage } from '@platform/contracts';
import type { RunRepository } from '../pipeline/store.js';
import { silentLogger } from '../ports/logger.js';
import type { TransactionScope } from '../ports/unit-of-work.js';
import type { ChargeRunResult, CostLedgerOptions } from './ledger.js';
import { chargeRunSpend } from './ledger.js';

/** What the process that ran the session measured, in the shape the run's own outcome carries. */
export interface LateRunSpend {
  readonly runId: Id;
  readonly sessionId: string | null;
  readonly numTurns: number;
  readonly usage: TokenUsage;
  readonly modelUsage: readonly ModelUsage[];
  readonly cost: RunCost;
  readonly wallMs: number;
}

export interface LateCostRecorderOptions extends CostLedgerOptions {
  readonly runs: RunRepository;
}

export interface LateCostOutcome {
  /** Did `recordCost` write? `false` means the row already carried a figure or was already charged. */
  readonly recorded: boolean;
  readonly charge: ChargeRunResult | null;
}

/**
 * The recorder as a port, so the stage executor can be given one without depending on `CostStore`.
 *
 * The executor lives in the pipeline module and must not know what a price list is — exactly the
 * argument `BudgetGuard` already makes one function along. A composition with no cost store passes
 * {@link noLateCostRecorder} and loses nothing it had.
 */
export interface LateCostRecorder {
  /**
   * @param scope the **caller's** transaction and event appender: the correction to the row, the
   * ledger rows and any `budget.exhausted` it crosses commit together with whatever else the caller
   * is writing, or not at all.
   */
  record(scope: TransactionScope, spend: LateRunSpend, at: IsoDateTime): Promise<LateCostOutcome>;
}

/**
 * The recorder a composition with no cost ledger uses: it writes **nothing** — no row is
 * corrected and nothing is charged — and answers `{recorded: false, charge: null}`, which is what
 * the stage executor's `lostTheRun` branch and `late.test.ts` pin. A composition without a
 * `CostStore` therefore keeps the pre-WP-47 behaviour for a run that ends outside its own process:
 * the terminated row keeps whatever figure it had, and `GET /api/runs/:id` publishes that. The
 * production composition (`apps/server/src/pipeline.ts`) never uses this one.
 */
export const noLateCostRecorder: LateCostRecorder = {
  record: async () => ({ recorded: false, charge: null }),
};

export const createLateCostRecorder = (options: LateCostRecorderOptions): LateCostRecorder => {
  const logger = options.logger ?? silentLogger;
  return {
    record: async (scope, spend, at) => {
      const recorded = await options.runs.recordCost(scope.tx, {
        runId: spend.runId,
        sessionId: spend.sessionId,
        numTurns: spend.numTurns,
        usage: spend.usage,
        cost: spend.cost,
        wallMs: spend.wallMs,
      });
      if (!recorded) {
        // Not a failure and not an error: the row already carries a figure, or the ledger has
        // already charged this run. Both mean the money is accounted for by somebody who knew it,
        // and charging again here would double it.
        logger.debug(
          { run_id: spend.runId },
          'late cost: the run already carries a cost or a ledger row, so nothing was written',
        );
        return { recorded: false, charge: null };
      }
      const charge = await chargeRunSpend(options, {
        tx: scope.tx,
        emit: (events) => scope.events.append(events),
        spend: {
          runId: spend.runId,
          usage: spend.usage,
          modelUsage: spend.modelUsage,
          usd: spend.cost.usd,
          isEstimate: spend.cost.is_estimate,
          numTurns: spend.numTurns,
          wallMs: spend.wallMs,
        },
        occurredAt: at,
        // No event caused this charge: the run's terminal event was appended by the *other* writer
        // and carried the zero this corrects. `null` is what `events.cause_event_id` is for.
        causeEventId: null,
        late: true,
      });
      logger.info(
        {
          run_id: spend.runId,
          entries: charge.entries,
          usd: charge.usd,
          budgets: charge.budgets,
          reason: charge.reason,
        },
        'late cost: a run ended by another writer was charged what the process that ran it measured',
      );
      return { recorded: true, charge };
    },
  };
};
