/**
 * An in-memory {@link CostStore} — technical/10: fakes are first-class code.
 *
 * It is what the ledger's unit tier runs against, and it is held to the same contract suite as the
 * PostgreSQL implementation (`test/contract/support/cost-store-suite.ts`), so "the ledger works" and
 * "the ledger works on a database" are one claim rather than two.
 *
 * ## Divergence register — a fake may be stricter than the real adapter, never kinder
 *
 * | # | Divergence | Direction | Justification |
 * |---|---|---|---|
 * | 1 | No transaction isolation: a `Transaction` handle is accepted and ignored, so a rolled-back scope keeps its writes. | **kinder** | Rollback cannot be faked in a Map, which is why the same suite runs against PostgreSQL and why the reconciliation criterion is asserted on a database. **Positive assertion**: `memory-cost.test.ts` asserts the divergence explicitly rather than warning about it. |
 * | 2 | `appendEntries` accepts any `created_at`; PostgreSQL refuses a row whose month has no partition. | **kinder** | `cost_entries` is range-partitioned (migration 0007) and the ledger writes with the database's own `now()`, so the case only arises for a backfill of a month older than the retained partitions. Named here because it is exactly the case a backfill can hit. |
 * | 3 | No row locking, so two concurrent folds of one budget window would both read the same `spent_usd`. | **kinder** | The PostgreSQL adapter ensures the window row exists and takes `for update` in `applicable`, which is what serialises them. Nothing in this file is concurrent, so a test cannot observe the difference — which is why the property is asserted in the integration tier instead. |
 * | 4 | `saveEstimate` throws when the task is unknown; the SQL `update` would touch zero rows. | **same** | The SQL adapter checks `rowCount` and throws the same error: a projection that silently stops being written is the defect this prevents (standing rule 18's shape). |
 * | 5 | Everything is returned by structural clone. | **stricter** | A caller mutating what it read cannot change the store, which PostgreSQL also does not allow. |
 * | 6 | `StoredBudget.sequence` is **re-derived** from what a fold must have emitted (one event per newly notified threshold, plus one for the first crossing of the limit); the SQL adapter reads `max(stream_seq) + 1` off the `events` table. | **different** | The fake cannot see the log, and a sequence that did not advance makes the *second* fold of one budget fail its append with a stream conflict — so the alternative is a fake that cannot charge a budget twice. Both answers are the same number for every sequence of folds the ledger performs, which is what `memory-cost.test.ts` asserts against `MemoryEventing`'s own log. |
 */
import type { BudgetWindow, Id, IsoDateTime, Size } from '@platform/contracts';
import type { CostLedgerEntry, PriceRates, RollupDelta, TaskCostSample } from '@platform/domain';
import { roundUsd } from '@platform/domain';
import type {
  BudgetSubject,
  CostStore,
  ModelUsageRow,
  RunCostRow,
  StoredBudget,
  WindowStartOf,
} from '../cost/ports.js';
import type { Transaction } from '../ports/transaction.js';

export class CostStoreError extends Error {
  override readonly name = 'CostStoreError';
}

/** A budget definition as a test seeds it; the window rows are the store's own state. */
export interface SeededBudget {
  readonly id: Id;
  readonly scope: StoredBudget['scope'];
  readonly scopeId: Id | null;
  readonly projectId: Id | null;
  readonly window: BudgetWindow;
  readonly limitUsd: number;
  readonly notifyPct?: readonly number[];
}

/** A price row as a test seeds it, with the window it is in force for. */
export interface SeededPrice extends PriceRates {
  readonly effectiveFrom: IsoDateTime;
  readonly effectiveTo?: IsoDateTime;
}

export interface MemoryCostStore extends CostStore {
  seedRun(run: RunCostRow): void;
  seedPrice(price: SeededPrice): void;
  seedBudget(budget: SeededBudget): void;
  seedTask(task: { readonly id: Id; readonly projectId: Id }): void;
  seedRefinedSize(taskId: Id, size: Size | null): void;
  seedHistory(projectId: Id, samples: readonly TaskCostSample[]): void;
  seedTimezone(projectId: Id, timezone: string | null): void;
  /** Every ledger row written, in write order. */
  readonly entries: readonly CostLedgerEntry[];
  readonly modelUsage: readonly ModelUsageRow[];
  readonly rollups: readonly RollupDelta[];
  readonly windows: readonly {
    budgetId: Id;
    windowStart: IsoDateTime;
    spentUsd: number;
    notifiedPct: readonly number[];
  }[];
  readonly estimates: readonly { taskId: Id; size: Size; estimateUsd: number | null }[];
}

const clone = <T>(value: T): T => structuredClone(value) as T;

export interface MemoryCostStoreOptions {
  /**
   * Answers `runContext` for a run nobody seeded — the pipeline harness passes a reader over its
   * own `runs` and `tasks`, so a ledger test can drive a *real* pipeline instead of seeding the
   * very rows it is asserting about (standing rule 82: a fake that never reads the artefact under
   * test is how an acceptance criterion passes on nothing).
   */
  readonly runs?: (tx: Transaction, runId: Id) => Promise<RunCostRow | null>;
}

export const createMemoryCostStore = (options: MemoryCostStoreOptions = {}): MemoryCostStore => {
  const runs = new Map<Id, RunCostRow>();
  const prices: SeededPrice[] = [];
  const budgets: SeededBudget[] = [];
  const tasks = new Map<Id, { projectId: Id }>();
  const refinedSizes = new Map<Id, Size | null>();
  const history = new Map<Id, readonly TaskCostSample[]>();
  const timezones = new Map<Id, string | null>();
  const entries: CostLedgerEntry[] = [];
  const modelUsage: ModelUsageRow[] = [];
  const rollups: RollupDelta[] = [];
  const windows = new Map<
    string,
    { budgetId: Id; windowStart: IsoDateTime; spentUsd: number; notifiedPct: readonly number[] }
  >();
  const estimates: { taskId: Id; size: Size; estimateUsd: number | null }[] = [];
  const sequences = new Map<Id, number>();

  const windowKey = (budgetId: Id, windowStart: IsoDateTime) => `${budgetId}@${windowStart}`;

  const storedBudget = (budget: SeededBudget, windowStartOf: WindowStartOf): StoredBudget => {
    const windowStart = windowStartOf(budget.window);
    const row = windows.get(windowKey(budget.id, windowStart));
    return {
      id: budget.id,
      scope: budget.scope,
      scopeId: budget.scopeId,
      projectId: budget.projectId,
      window: budget.window,
      limitUsd: budget.limitUsd,
      notifyPct: budget.notifyPct ?? [50, 80],
      windowStart,
      spentUsd: row?.spentUsd ?? 0,
      notifiedPct: row?.notifiedPct ?? [],
      sequence: sequences.get(budget.id) ?? 1,
    };
  };

  const matches = (budget: SeededBudget, subject: BudgetSubject): boolean => {
    switch (budget.scope) {
      case 'org':
        return true;
      case 'project':
        return budget.scopeId === subject.projectId;
      case 'task':
        return subject.taskId !== null && budget.scopeId === subject.taskId;
      case 'run':
        return false;
    }
  };

  return {
    seedRun: (run) => {
      runs.set(run.runId, run);
      tasks.set(run.taskId, { projectId: run.projectId });
    },
    seedPrice: (price) => {
      prices.push(price);
    },
    seedBudget: (budget) => {
      budgets.push(budget);
    },
    seedTask: (task) => {
      tasks.set(task.id, { projectId: task.projectId });
    },
    seedRefinedSize: (taskId, size) => {
      refinedSizes.set(taskId, size);
    },
    seedHistory: (projectId, samples) => {
      history.set(projectId, samples);
    },
    seedTimezone: (projectId, timezone) => {
      timezones.set(projectId, timezone);
    },
    get entries() {
      return clone(entries);
    },
    get modelUsage() {
      return clone(modelUsage);
    },
    get rollups() {
      return clone(rollups);
    },
    get windows() {
      return clone([...windows.values()]);
    },
    get estimates() {
      return clone(estimates);
    },

    runContext: async (tx, runId) =>
      clone(runs.get(runId) ?? (await options.runs?.(tx, runId)) ?? null),

    pricesAt: async (_tx, models, at) => {
      const wanted = new Set(models);
      return prices
        .filter(
          (price) =>
            wanted.has(price.modelId) &&
            Date.parse(price.effectiveFrom) <= Date.parse(at) &&
            (price.effectiveTo === undefined || Date.parse(price.effectiveTo) > Date.parse(at)),
        )
        .map((price) => ({
          priceListId: price.priceListId,
          modelId: price.modelId,
          input: price.input,
          output: price.output,
          cacheWrite5m: price.cacheWrite5m,
          cacheWrite1h: price.cacheWrite1h,
          cacheRead: price.cacheRead,
        }));
    },

    appendEntries: async (_tx, rows) => {
      entries.push(...clone([...rows]));
    },

    saveModelUsage: async (_tx, rows) => {
      for (const row of rows) {
        const index = modelUsage.findIndex(
          (existing) => existing.runId === row.runId && existing.model === row.model,
        );
        if (index >= 0) {
          modelUsage[index] = clone(row);
        } else {
          modelUsage.push(clone(row));
        }
      }
    },

    applyRollups: async (_tx, deltas) => {
      for (const delta of deltas) {
        const index = rollups.findIndex(
          (existing) =>
            existing.projectId === delta.projectId &&
            existing.day === delta.day &&
            existing.template === delta.template &&
            existing.stage === delta.stage &&
            existing.model === delta.model &&
            existing.mode === delta.mode,
        );
        const current = rollups[index];
        if (current === undefined) {
          rollups.push(clone(delta));
          continue;
        }
        rollups[index] = {
          ...current,
          runs: current.runs + delta.runs,
          usd: roundUsd(current.usd + delta.usd),
          wallMs: current.wallMs + delta.wallMs,
          turns: current.turns + delta.turns,
          usage: {
            input_tokens: current.usage.input_tokens + delta.usage.input_tokens,
            output_tokens: current.usage.output_tokens + delta.usage.output_tokens,
            cache_write_5m_tokens:
              current.usage.cache_write_5m_tokens + delta.usage.cache_write_5m_tokens,
            cache_write_1h_tokens:
              current.usage.cache_write_1h_tokens + delta.usage.cache_write_1h_tokens,
            cache_read_tokens: current.usage.cache_read_tokens + delta.usage.cache_read_tokens,
          },
        };
      }
    },

    organisationTimezone: async (_tx, projectId) => timezones.get(projectId) ?? null,

    estimateHistory: async (_tx, projectId, limit) => ({
      project: clone([...(history.get(projectId) ?? [])]).slice(0, limit),
      org: clone([...history.values()].flat()).slice(0, limit),
    }),

    refinedSize: async (_tx, taskId) => refinedSizes.get(taskId) ?? null,

    saveEstimate: async (_tx, taskId, estimate) => {
      if (!tasks.has(taskId)) {
        throw new CostStoreError(`cost store: no task ${taskId} to estimate`);
      }
      estimates.push({ taskId, size: estimate.size, estimateUsd: estimate.estimateUsd });
    },

    taskEstimate: async (_tx, taskId) => {
      if (!tasks.has(taskId)) {
        return null;
      }
      const written = [...estimates].reverse().find((row) => row.taskId === taskId);
      return written === undefined
        ? { size: null, estimateUsd: null }
        : { size: written.size, estimateUsd: written.estimateUsd };
    },

    budgets: {
      applicable: async (_tx, subject, windowStartOf) =>
        budgets
          .filter((budget) => matches(budget, subject))
          .map((budget) => storedBudget(budget, windowStartOf)),
      saveWindow: async (_tx, row) => {
        const key = windowKey(row.budgetId, row.windowStart);
        const previous = windows.get(key);
        const definition = budgets.find((budget) => budget.id === row.budgetId);
        const crossedThresholds = row.notifiedPct.length - (previous?.notifiedPct.length ?? 0);
        const exhausted =
          definition !== undefined &&
          row.spentUsd >= definition.limitUsd &&
          (previous?.spentUsd ?? 0) < definition.limitUsd
            ? 1
            : 0;
        windows.set(key, {
          budgetId: row.budgetId,
          windowStart: row.windowStart,
          spentUsd: row.spentUsd,
          notifiedPct: [...row.notifiedPct],
        });
        sequences.set(
          row.budgetId,
          (sequences.get(row.budgetId) ?? 1) + Math.max(0, crossedThresholds) + exhausted,
        );
      },
    },
  };
};
