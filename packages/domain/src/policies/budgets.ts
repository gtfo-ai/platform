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
  /**
   * product/06 § "Step 2": the Discovery agent is *"automatic, ~minutes, cheap"* with a **bounded
   * budget**. Two dollars is the same cap the other Sonnet stages carry (retrospective,
   * librarian), and it is a cap rather than an estimate: the run stops at it.
   */
  discovery: 2,
  /**
   * The ticket readiness linter (WP-25). product/19 § 12 publishes its cost implication as *"~$0.10
   * per ticket"*, and this is **a cap rather than that estimate**: a cap equal to the expected cost
   * stops every lint that lands at the top of its normal range, and a lint stopped half-way produces
   * no artifact and therefore no comment — the feature would fail silently for exactly the tickets
   * with the most to read. Five times the published figure is the smallest number that leaves the
   * expectation an order of magnitude of room and still costs a quarter of one refinement ($2) when
   * a run goes wrong.
   */
  ticket_lint: 0.5,
  /**
   * The rebase gate's conflict resolution (WP-26). A third of `implementation`'s cap, for the
   * reason `STAGE_AGENT_DEFAULTS.conflict_resolution` gives: the work is bounded by the conflicted
   * hunks rather than by the ticket, and product/04 S6b calls it *"a short Implementation run"*.
   * It is a cap rather than an estimate — the run stops at it, and a task may spend it twice
   * (`DEFAULT_ITERATION_LIMITS.rebase`).
   */
  conflict_resolution: 5,
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
