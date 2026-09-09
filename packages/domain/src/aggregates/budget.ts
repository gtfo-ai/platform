/**
 * The Budget aggregate — technical/02 (Budget, CostEntry) and product/09 § "Budgets".
 *
 * "Spent is a projection over the cost ledger": the aggregate folds cost entries into the current
 * window and emits the notification events. It never stops a run — BD-010: "Reaching an org/project
 * budget prevents *new* runs; running runs finish" — so nothing here cancels anything. What a
 * budget blocks is decided in `../policies/budgets.js`.
 *
 * Money is `numeric(12,6)` in Postgres (technical/03), so every fold rounds to six decimals; that
 * keeps repeated additions associative enough for the property tests and identical to what the
 * database will store.
 */
import type { BudgetRecord, BudgetScope, BudgetWindow, Id, IsoDateTime } from '@platform/contracts';
import { PolicyViolationError } from '../errors.js';
import { type CommandContext, type Decision, eventRecorder } from '../events.js';

/** product/09: "Thresholds: notify at 50% and 80% (configurable), block at 100%." */
export const DEFAULT_NOTIFY_PCT = [50, 80] as const;

/** technical/03 stores USD as `numeric(12,6)`. */
export const roundUsd = (usd: number): number => Math.round(usd * 1_000_000) / 1_000_000;

export interface Budget {
  readonly id: Id;
  readonly scope: BudgetScope;
  /** The org/project/task/run the budget belongs to; null for the single org-wide budget. */
  readonly scopeId: Id | null;
  /** Carried on every budget event so project dashboards can filter without a join. */
  readonly projectId: Id | null;
  readonly window: BudgetWindow;
  readonly limitUsd: number;
  readonly notifyPct: readonly number[];
  readonly spentUsd: number;
  readonly windowStart: IsoDateTime | null;
  /** Percentages already notified, so a threshold fires once per window. */
  readonly notifiedPct: readonly number[];
  readonly exhaustedNotified: boolean;
  readonly sequence: number;
}

export type BudgetDecision = Decision<Budget>;

const recorderFor = (budget: Budget, context: CommandContext) =>
  eventRecorder({ streamType: 'budget', streamId: budget.id }, budget.sequence, context);

const basePayload = (budget: Budget, spentUsd: number) => ({
  project_id: budget.projectId,
  budget_id: budget.id,
  scope: budget.scope,
  scope_id: budget.scopeId,
  window: budget.window,
  limit_usd: budget.limitUsd,
  spent_usd: spentUsd,
});

export interface CreateBudgetInput {
  readonly id: Id;
  readonly scope: BudgetScope;
  readonly scopeId?: Id;
  readonly projectId?: Id;
  readonly window: BudgetWindow;
  readonly limitUsd: number;
  readonly notifyPct?: readonly number[];
  readonly windowStart?: IsoDateTime;
  readonly spentUsd?: number;
}

export const createBudget = (input: CreateBudgetInput): Budget => {
  if (!Number.isFinite(input.limitUsd) || input.limitUsd < 0) {
    throw new PolicyViolationError('budget.limit', `limit must be a non-negative amount`);
  }
  return {
    id: input.id,
    scope: input.scope,
    scopeId: input.scopeId ?? null,
    projectId: input.projectId ?? null,
    window: input.window,
    limitUsd: roundUsd(input.limitUsd),
    notifyPct: [...(input.notifyPct ?? DEFAULT_NOTIFY_PCT)].sort((a, b) => a - b),
    spentUsd: roundUsd(input.spentUsd ?? 0),
    windowStart: input.windowStart ?? null,
    notifiedPct: [],
    exhaustedNotified: false,
    sequence: 0,
  };
};

/** Percentage of the limit spent. A zero limit counts as fully spent from the first cent. */
export const percentSpent = (budget: Budget): number =>
  budget.limitUsd === 0 ? 100 : (budget.spentUsd / budget.limitUsd) * 100;

/** At or over the limit: no *new* run may start against this budget (BD-010). */
export const isExhausted = (budget: Budget): boolean => budget.spentUsd >= budget.limitUsd;

/**
 * Folds one cost entry into the window.
 *
 * Emits `budget.threshold.reached` once per configured percentage per window, and
 * `budget.exhausted` the first time the limit is met. Recording spend past the limit is normal:
 * a run that was already running finishes and its cost still lands here.
 */
export const recordSpend = (
  budget: Budget,
  input: { readonly usd: number },
  context: CommandContext,
): BudgetDecision => {
  if (!Number.isFinite(input.usd) || input.usd < 0) {
    throw new PolicyViolationError('budget.spend', 'a cost entry must be a non-negative amount');
  }
  const spentUsd = roundUsd(budget.spentUsd + input.usd);
  const next: Budget = { ...budget, spentUsd };
  const recorder = recorderFor(budget, context);
  const pctSpent = percentSpent(next);

  const crossed = next.notifyPct.filter(
    (pct) => pctSpent >= pct && !budget.notifiedPct.includes(pct),
  );
  for (const pct of crossed) {
    recorder.emit('budget.threshold.reached', { ...basePayload(next, spentUsd), pct });
  }

  const exhausted = isExhausted(next) && !budget.exhaustedNotified;
  if (exhausted) {
    recorder.emit('budget.exhausted', basePayload(next, spentUsd));
  }

  return {
    aggregate: {
      ...next,
      notifiedPct: [...budget.notifiedPct, ...crossed],
      exhaustedNotified: budget.exhaustedNotified || exhausted,
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

/**
 * The window rolled over (BD-010: windows are in the organisation timezone and reset at the
 * boundary). Spend and notifications start again.
 */
export const resetWindow = (
  budget: Budget,
  input: { readonly windowStart: IsoDateTime },
  context: CommandContext,
): BudgetDecision => {
  const recorder = recorderFor(budget, context);
  recorder.emit('budget.reset', {
    ...basePayload(budget, 0),
    window_start: input.windowStart,
  });
  return {
    aggregate: {
      ...budget,
      spentUsd: 0,
      notifiedPct: [],
      exhaustedNotified: false,
      windowStart: input.windowStart,
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

export const toBudgetRecord = (budget: Budget): BudgetRecord => ({
  id: budget.id,
  scope: budget.scope,
  scope_id: budget.scopeId,
  window: budget.window,
  limit_usd: budget.limitUsd,
  notify_pct: [...budget.notifyPct],
  spent_usd: budget.spentUsd,
  window_start: budget.windowStart,
});
