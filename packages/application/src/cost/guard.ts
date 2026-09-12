/**
 * What a budget stops — BD-010, product/09 § "Budgets".
 *
 * | scope | behaviour when reached |
 * |---|---|
 * | organisation | no new runs anywhere; running runs finish |
 * | project | no new runs for that project |
 * | task | task → `Paused: budget`, a human can raise the cap |
 *
 * The first two are this module. They are asked as a **read at admission** rather than answered by
 * a handler on `budget.exhausted`, and that is a decision rather than an omission: a handler would
 * have to enumerate every task that might start a run next and pause each of them, which is a
 * different set at every moment and wrong the instant a queued task is admitted. The question "may
 * *this* run start" has exactly one moment — the stage executor's admission transaction — and this
 * is asked there, from the same `budget_windows` projection the ledger writes. What the events are
 * for is *telling somebody* (technical/02's Slack and UI consumers), which is why they stay
 * declared unconsumed in this build.
 *
 * The **task** scope stays where WP-15 put it: `taskBudgetExhausted` in the stage executor, against
 * `settings.taskBudgetUsd` (product/09's "$50 default, per template"). Two enforcement paths for one
 * scope would be two answers; a `budgets` row scoped to a task is still *projected* by the ledger,
 * so its spend is visible, and enforcing it from a row instead of from configuration is a product
 * decision nobody has made.
 *
 * **Running runs are never killed.** Nothing here cancels anything: BD-010 is explicit that spend
 * already made must not be wasted, and the only thing that stops a run mid-flight is its own
 * per-run cap, which is known upfront.
 */
import type { BudgetScope, BudgetWindow, Id, IsoDateTime } from '@platform/contracts';
import { blockingBudget } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';
import type { CostStore } from './ports.js';
import { budgetWindowStart, resolveBudgetTimezone } from './window.js';

/** The budget that refused a new run, in the words an operator needs to raise it. */
export interface BlockingBudget {
  readonly id: Id;
  readonly scope: BudgetScope;
  readonly window: BudgetWindow;
  readonly limitUsd: number;
  readonly spentUsd: number;
  readonly windowStart: IsoDateTime;
}

/**
 * Asked once per stage admission, inside the executor's own transaction.
 *
 * A port rather than a function because the stage executor is in the pipeline module and must not
 * depend on the cost store: a deployment that has no budgets composes {@link noBudgetGuard} and
 * nothing changes.
 */
export interface BudgetGuard {
  blockingFor(tx: Transaction, projectId: Id, at: IsoDateTime): Promise<BlockingBudget | null>;
}

/**
 * The guard a composition with no cost store uses: nothing ever blocks.
 *
 * It is the **default** in the stage executor, so adding budgets to a deployment is a composition
 * change and not a behaviour change for one that has none. A test that asserts a task is *not*
 * paused must therefore assert which guard ran (standing rule 10) — see `guard.test.ts`.
 */
export const noBudgetGuard: BudgetGuard = {
  blockingFor: async () => null,
};

export interface BudgetGuardOptions {
  readonly store: CostStore;
}

export const createBudgetGuard = (options: BudgetGuardOptions): BudgetGuard => ({
  blockingFor: async (tx, projectId, at) => {
    // The same substitution the ledger makes (`resolveBudgetTimezone`): a zone `budgetWindowStart`
    // would refuse must not throw here either — this runs inside the stage executor's admission
    // transaction, so a throw fails the job into a retry loop instead of answering "may this run
    // start".
    const { timezone } = resolveBudgetTimezone(
      await options.store.organisationTimezone(tx, projectId),
    );
    const budgets = await options.store.budgets.applicable(
      tx,
      // `taskId: null` — the org and project scopes only. The task cap is the executor's own,
      // against the project's effective configuration (see the docblock).
      { projectId, taskId: null },
      (window) => budgetWindowStart(window, at, timezone),
    );
    const blocker = blockingBudget(
      budgets.map((budget) => ({
        id: budget.id,
        scope: budget.scope,
        scopeId: budget.scopeId,
        projectId: budget.projectId,
        window: budget.window,
        limitUsd: budget.limitUsd,
        notifyPct: budget.notifyPct,
        spentUsd: budget.spentUsd,
        windowStart: budget.windowStart,
        notifiedPct: budget.notifiedPct,
        exhaustedNotified: false,
        sequence: budget.sequence,
      })),
    );
    return blocker === null
      ? null
      : {
          id: blocker.id,
          scope: blocker.scope,
          window: blocker.window,
          limitUsd: blocker.limitUsd,
          spentUsd: blocker.spentUsd,
          windowStart: blocker.windowStart ?? (at as IsoDateTime),
        };
  },
});
