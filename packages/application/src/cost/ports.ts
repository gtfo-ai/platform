/**
 * The cost ledger's persistence port — the rows technical/03 § "Cost and governance" keeps, behind
 * an interface this ring can name.
 *
 * Transaction-bound like `PipelineStore`, and for the same reason: a ledger row, the rollup it
 * folds into, the budget window it moves and the events that announces all commit together with the
 * `handler_executions` claim that says the handler ran (TD-005). That is what makes the projection
 * exactly-once without a unique key on an append-only table.
 *
 * ## Why the ledger has a store of its own rather than methods on `PipelineStore`
 *
 * Standing rule 79, measured at WP-15d: a whole-row `tasks.save` from a writer that runs beside the
 * stage executor is a lost update, and it cost 0.40 USD of a task's recorded spend. The ledger runs
 * in an **event handler**, concurrently with the `stage.execute` job that owns the task row, so it
 * touches `tasks` through exactly one narrow write ({@link CostStore.saveEstimate}, two columns
 * nothing else writes) and keeps everything else in tables of its own. It is deliberately **not** a
 * `tasks.save` site — a count `task-save-sites.test.ts` now produces rather than a number stated
 * here, because it had already moved by the time WP-15e read it (standing rule 63).
 */
import type {
  BudgetScope,
  BudgetWindow,
  Id,
  IsoDateTime,
  Size,
  TokenUsage,
} from '@platform/contracts';
import type { CostLedgerEntry, PriceRates, RollupDelta, TaskCostSample } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';

/** The run row a `run.finished` payload does not carry: its model, its stage and its lineage. */
export interface RunCostRow {
  readonly runId: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly orgId: Id;
  readonly template: string;
  /** The stage slug, or `null` for a run outside a pipeline stage (discovery, maintenance). */
  readonly stage: string | null;
  readonly model: string;
  /** When the run started — the instant the price table is read at (technical/03). */
  readonly startedAt: IsoDateTime | null;
}

/** One `run_model_usage` row (technical/03), as the ledger writes it. */
export interface ModelUsageRow {
  readonly runId: Id;
  readonly model: string;
  readonly usage: TokenUsage;
  /** The provider's own per-model number; `null` when it reported none. */
  readonly usdReported: number | null;
  /** The price table's number; `null` when no row covered this model (never a zero — rule 18). */
  readonly usdEstimated: number | null;
}

/** A budget definition plus the window row the caller asked for; `spentUsd` is the projection. */
export interface StoredBudget {
  readonly id: Id;
  readonly scope: BudgetScope;
  readonly scopeId: Id | null;
  readonly projectId: Id | null;
  readonly window: BudgetWindow;
  readonly limitUsd: number;
  readonly notifyPct: readonly number[];
  readonly windowStart: IsoDateTime;
  readonly spentUsd: number;
  readonly notifiedPct: readonly number[];
  /** `max(stream_seq) + 1` of this budget's event stream — the aggregate's next sequence. */
  readonly sequence: number;
}

/**
 * The scopes one run's spend is charged to (product/09's budget table).
 *
 * The organisation is **not** here: it is a function of the project, and the store resolves it, so
 * the two callers (the ledger, which knows the org, and the guard, which does not) cannot disagree
 * about which organisation a project belongs to (standing rule 9).
 */
export interface BudgetSubject {
  readonly projectId: Id;
  /** `null` asks for the org and project scopes only — what a *new run* is blocked by (BD-010). */
  readonly taskId: Id | null;
}

/** Computes the window start of a budget; `budgetWindowStart` bound to the org's timezone. */
export type WindowStartOf = (window: BudgetWindow) => IsoDateTime;

/**
 * The **charge** path's view of `budgets`. There is deliberately no read-only listing here: the read
 * behind `GET /api/projects/:id/budgets` is a projection in `apps/server/src/queries/cost-queries.ts`,
 * because {@link BudgetRepository.applicable} *writes* — it inserts the window row and locks it — and
 * a `GET` may do neither. One method, one caller, one claim (standing rule 31).
 */
export interface BudgetRepository {
  /**
   * Every budget that applies to `subject`, each with the window row `windowStartOf` selects.
   *
   * One method rather than "load definitions, then load windows" because the pair has to be read in
   * the same transaction as the write that follows it: a second reader between them is a lost
   * update on `spent_usd`, which is the class standing rule 79 names.
   */
  applicable(
    tx: Transaction,
    subject: BudgetSubject,
    windowStartOf: WindowStartOf,
  ): Promise<readonly StoredBudget[]>;

  /** Upserts the projection row. `spentUsd` and `notifiedPct` are absolute, not deltas. */
  saveWindow(
    tx: Transaction,
    row: {
      readonly budgetId: Id;
      readonly windowStart: IsoDateTime;
      readonly spentUsd: number;
      readonly notifiedPct: readonly number[];
    },
  ): Promise<void>;
}

export interface CostStore {
  /** The run's row joined to its task and project, or `null` when the run is unknown. */
  runContext(tx: Transaction, runId: Id): Promise<RunCostRow | null>;

  /**
   * Price rows for `models` in force at `at` — `effective_from <= at` and not yet superseded
   * (technical/03). A model with no row is simply absent from the result: the caller refuses it by
   * name rather than pricing it at zero (standing rule 16).
   */
  pricesAt(
    tx: Transaction,
    models: readonly string[],
    at: IsoDateTime,
  ): Promise<readonly PriceRates[]>;

  /** Appends the ledger rows. Append-only: there is no update and no delete (technical/03). */
  appendEntries(tx: Transaction, entries: readonly CostLedgerEntry[]): Promise<void>;

  /** Upserts `run_model_usage` for one run, replacing nothing it did not write. */
  saveModelUsage(tx: Transaction, rows: readonly ModelUsageRow[]): Promise<void>;

  /** `INSERT … ON CONFLICT DO UPDATE` per delta, adding to the counters (technical/03). */
  applyRollups(tx: Transaction, deltas: readonly RollupDelta[]): Promise<void>;

  /**
   * The timezone of the project's organisation (BD-010, Q12); the caller falls back to UTC.
   *
   * Budget windows and the rollup's `day` are both read in it, so one query answers both and the
   * dashboard cannot disagree with the budget about when the day turned.
   */
  organisationTimezone(tx: Transaction, projectId: Id): Promise<string | null>;

  /**
   * Finished tasks with a size and a spend, for the estimate (product/09).
   *
   * The organisation is resolved from the project rather than passed in: the caller is an
   * `artifact.created` handler, whose payload names a project and no org, and two ways of deciding
   * which organisation a project belongs to is one way too many (standing rule 9).
   */
  estimateHistory(
    tx: Transaction,
    projectId: Id,
    limit: number,
  ): Promise<{
    readonly project: readonly TaskCostSample[];
    readonly org: readonly TaskCostSample[];
  }>;

  /**
   * The `size` of the task's newest `RefinedSpec` artifact, or `null` when there is none and when
   * the artifact's data does not parse as one (an artifact is model output — BD-022).
   */
  refinedSize(tx: Transaction, taskId: Id): Promise<Size | null>;

  /**
   * Writes **only** `tasks.size` and `tasks.estimate_usd`.
   *
   * The third narrow task write, after `saveWorkpad` (WP-15d) and `saveTicketSnapshot` (WP-15f),
   * and for the same measured reason: this runs in an event handler beside the `stage.execute`
   * job's transactions, so a whole-row `save` would put the task's state, stage and cost back as
   * they were when the handler loaded them.
   *
   * @throws when the task does not exist — a write that hit no row is how a projection silently
   * stops being written.
   */
  saveEstimate(
    tx: Transaction,
    taskId: Id,
    estimate: { readonly size: Size; readonly estimateUsd: number | null },
  ): Promise<void>;

  /** `tasks.estimate_usd`, `tasks.size` and whether the ledger has already estimated this task. */
  taskEstimate(
    tx: Transaction,
    taskId: Id,
  ): Promise<{ readonly size: Size | null; readonly estimateUsd: number | null } | null>;

  readonly budgets: BudgetRepository;
}
