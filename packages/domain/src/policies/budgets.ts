/**
 * What budgets do and do not stop — BD-010, product/09 § "Budgets", BD-011.
 *
 * | Scope        | Behaviour when reached                                   |
 * |--------------|----------------------------------------------------------|
 * | organisation | no new runs anywhere; running runs finish                 |
 * | project      | no new runs for that project                              |
 * | task         | task → `Paused: budget`, a human can raise the cap        |
 * | stage run    | the run stops through the SDK's own budget mechanism      |
 *
 * "**Never kill a run mid-flight for an organisation/project budget** — that wastes the spend
 * already made. Only per-run caps stop a run, and those are known upfront." Nothing in this module
 * cancels a run; the only outputs are "may a *new* run start" and "what cap does this run get".
 */
import type { Slug } from '@platform/contracts';
import { type Budget, isExhausted } from '../aggregates/budget.js';
import { PolicyViolationError } from '../errors.js';

/** product/09: task scope is "a total cap (default $50, per template)". */
export const DEFAULT_TASK_BUDGET_USD = 50;

/**
 * Per-run caps from product/04 § "Stage defaults", which BD-013 records. A stage not listed here
 * has no default cap; the effective configuration's `stages.<id>.budget_usd` always wins.
 */
export const DEFAULT_STAGE_RUN_BUDGET_USD: Readonly<Record<string, number>> = {
  intake: 0.1,
  refinement: 2,
  investigation: 5,
  architecture: 5,
  implementation: 15,
  code_review: 5,
  business_review: 3,
  retrospective: 2,
  librarian: 2,
};

/**
 * The first budget that blocks a new run, or `null` when every applicable budget has room.
 *
 * The caller passes the budgets that apply to the run — org, project, task — in the order it
 * wants them reported; scope order is not a domain rule, "any exhausted budget blocks" is.
 */
export const blockingBudget = (budgets: readonly Budget[]): Budget | null =>
  budgets.find((budget) => isExhausted(budget)) ?? null;

/** Guard form, for the code path that is about to start a run. */
export const assertRunMayStart = (budgets: readonly Budget[]): void => {
  const blocker = blockingBudget(budgets);
  if (blocker !== null) {
    throw new PolicyViolationError(
      'budget.exhausted',
      `${blocker.scope} budget ${blocker.id} (${blocker.window}) is exhausted: ` +
        `${blocker.spentUsd} of ${blocker.limitUsd} USD`,
    );
  }
};

/**
 * The per-run cap handed to the SDK (`max_budget_usd`). `null` means uncapped, which the runner
 * treats as "the stage default is absent and the project asked for no cap".
 */
export const resolveRunCapUsd = (stage: Slug, configured?: number): number | null =>
  configured ?? DEFAULT_STAGE_RUN_BUDGET_USD[stage] ?? null;

/**
 * A task budget being reached pauses the task rather than blocking silently (product/09), and a
 * human may raise the cap. This is the predicate the pipeline consults before each stage.
 */
export const shouldPauseTaskForBudget = (taskBudget: Budget | null): boolean =>
  taskBudget !== null && isExhausted(taskBudget);
