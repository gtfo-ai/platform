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
 *
 * **What the projection cannot see, this guard counts itself.** `budget_windows.spent_usd` is
 * written by the cost ledger's handler on `run.finished`, *after* the run's own transaction, so
 * between those two commits the platform has spent money no query can see and a second admission
 * reads a window that is lower than it is. `pendingSpend` is the second number — the runs of the
 * scope the ledger has not recorded, valued at what a live one may still spend and at what an
 * ended one reported — and, since WP-131, the third: an ended run **nobody measured**, held at the
 * reservation it was admitted at. The rule, the measurement (two runs admitted against a cap that allows one,
 * three times out of three, with the handler delayed) and the residual are in `./pending.ts`.
 */
import type { BudgetScope, BudgetWindow, Id, IsoDateTime } from '@platform/contracts';
import type { Transaction } from '../ports/transaction.js';
import { type Commitment, capIsSpent, holdDetail } from './pending.js';
import type { CostStore } from './ports.js';
import { budgetWindowStart, resolveBudgetTimezone } from './window.js';

/** The budget that refused a new run, in the words an operator needs to raise it. */
export interface BlockingBudget {
  readonly id: Id;
  readonly scope: BudgetScope;
  readonly window: BudgetWindow;
  readonly limitUsd: number;
  /** The ledger's own figure — money charged, not money committed. */
  readonly spentUsd: number;
  /**
   * What runs the ledger has not recorded have committed to this window (`./pending.ts`).
   *
   * Kept apart from {@link BlockingBudget.spentUsd} rather than summed into it because an operator
   * raising a cap has to be able to tell a charge from a reservation — and because a run that is
   * still live has not spent anything yet.
   */
  readonly pendingUsd: number;
  /**
   * The window's runs **nobody measured**, held at the reservations they were admitted at, and how
   * many (WP-131, `./pending.ts`). Apart from both numbers above: it is neither a charge nor a live
   * run's reservation, and the pause names it in its own words ({@link holdDetail}).
   */
  readonly heldUsd: number;
  readonly heldRuns: number;
  /** What the run being admitted may spend — counted against the window since WP-131 (406). */
  readonly reserveUsd: number;
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
  /**
   * @param reserveUsd what a run of the admitting stage may spend — the value this guard puts on a
   * run of the scope that is still live and therefore missing from the ledger (`./pending.ts`).
   */
  blockingFor(
    tx: Transaction,
    projectId: Id,
    at: IsoDateTime,
    reserveUsd: number,
  ): Promise<BlockingBudget | null>;
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

/** What a scope's runs commit to a window: the pending term and the hold, summed for the decision. */
const committedUsd = (committed: Commitment | undefined): number =>
  (committed?.pendingUsd ?? 0) + (committed?.heldUsd ?? 0);

/**
 * The words a pause or a refusal carries for a {@link BlockingBudget}, with the charge, the pending
 * reservations and the hold kept apart (`./pending.ts`'s `capSpendDetail`, for a `budgets` row).
 * One spelling for the stage executor and the ask executor, which both refuse on it.
 */
export const blockingBudgetDetail = (blocker: BlockingBudget): string =>
  `the ${blocker.scope} budget for this ${blocker.window} cannot take this run: ` +
  `${blocker.spentUsd} spent of ${blocker.limitUsd} USD since ${blocker.windowStart}` +
  (blocker.pendingUsd > 0
    ? `, plus ${blocker.pendingUsd} committed by runs the ledger has not recorded yet`
    : '') +
  (blocker.heldRuns > 0 ? `, plus ${holdDetail(blocker)}` : '') +
  `, and this run may spend ${blocker.reserveUsd} more`;

export interface BudgetGuardOptions {
  readonly store: CostStore;
}

export const createBudgetGuard = (options: BudgetGuardOptions): BudgetGuard => ({
  blockingFor: async (tx, projectId, at, reserveUsd) => {
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
    /**
     * One extra query per applicable budget — there are at most two on this path (the org's and the
     * project's), and only for a deployment that has any at all. The alternative, folding the term
     * into `applicable`, would write a reservation back as spend the next time the ledger charges
     * that window (see the port's docblock).
     */
    const pending = new Map<Id, Commitment>();
    for (const budget of budgets) {
      pending.set(
        budget.id,
        await options.store.pendingSpend(
          tx,
          { scope: budget.scope, scopeId: budget.scopeId },
          budget.windowStart,
          reserveUsd,
        ),
      );
    }
    /**
     * **The comparison every other cap makes** (WP-131 pre-review round, PROGRESS backlog 406):
     * the window's charge, what its other runs have committed, what its runs nobody measured are
     * held at, **and what this run may spend** — refused when the sum is past the limit
     * (`capIsSpent`, `>`: a run that exactly fills the window is admitted). Until then this guard
     * refused only a window already used up (`isExhausted`, `spent >= limit`), so one admission at
     * the edge took the window past its limit by that run's own per-run cap, while the shadow,
     * maintenance, bootstrap and task caps refused it. A window that **is** used up still refuses
     * every run, including one that may spend nothing (`reserveUsd` 0 — the scheduler's question).
     */
    const blocking = budgets.find((budget) => {
      const committed = pending.get(budget.id);
      const admission = {
        capUsd: budget.limitUsd,
        spentUsd: budget.spentUsd,
        pendingUsd: committed?.pendingUsd ?? 0,
        heldUsd: committed?.heldUsd ?? 0,
        heldRuns: committed?.heldRuns ?? 0,
        reserveUsd,
      };
      return budget.spentUsd + committedUsd(committed) >= budget.limitUsd || capIsSpent(admission);
    });
    if (blocking === undefined) {
      return null;
    }
    const committed = pending.get(blocking.id);
    return {
      id: blocking.id,
      scope: blocking.scope,
      window: blocking.window,
      limitUsd: blocking.limitUsd,
      spentUsd: blocking.spentUsd,
      pendingUsd: committed?.pendingUsd ?? 0,
      heldUsd: committed?.heldUsd ?? 0,
      heldRuns: committed?.heldRuns ?? 0,
      reserveUsd,
      windowStart: blocking.windowStart ?? (at as IsoDateTime),
    };
  },
});
