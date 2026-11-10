/**
 * **Budget approvals an earlier build asked on too few finished tasks are settled by the platform**
 * (S-28.16, BD-010's 2026-11-10 amendment decision 4, TD-035's 2026-11-10 amendment decision 3, M28
 * ruling B2 (4)) — a row of the recovery pass (`./stranded.ts`).
 *
 * Since S-28.16 an estimate resting on fewer than `MIN_ESTIMATE_SAMPLES_FOR_APPROVAL` finished tasks
 * asks nobody (`budgetApprovalReasons`). On Autix four tasks were already waiting on such an ask —
 * a mean of **one** finished task — when this shipped. This row finds every **pending** budget
 * approval whose estimate rests on fewer (`ApprovalRepository.pendingBudgetBelowSamples`) and
 * settles it through the Approval aggregate (`settleBudgetApprovalNotRequired`): `approved`, no
 * decider, `auto_decided`, the reason `estimate_basis_too_thin` with its numbers, and the ordinary `task.approval.decided` — which the
 * saga's approval handler turns into the task going on, exactly as a person's approval does (or,
 * for a task paused meanwhile, the resume applies it). The cap is not touched: nobody approved the
 * spend, so the task's cap still bounds it.
 *
 * **Why a recovery row and why it is one-off without a revision mark.** It needs no person and runs
 * on the pass every worker already has, the first interval after the deploy. And it can only ever
 * find rows an earlier build wrote: the gate this build ships never creates a budget approval below
 * the floor, and a settled row is no longer `pending` — so after the first pass the query answers
 * nothing, for ever, at the cost of one indexed read per pass. Each approval is settled in a
 * transaction of its own, re-read there, so two passes racing settle it once (the second finds it
 * decided and skips it).
 *
 * **The bound**: {@link BUDGET_APPROVAL_SETTLE_PER_PASS} approvals a pass, never more than the
 * pass's own `limit`.
 */
import type { Id } from '@platform/contracts';
import {
  type CommandContext,
  estimateRestsOnEnough,
  MIN_ESTIMATE_SAMPLES_FOR_APPROVAL,
  settleBudgetApprovalNotRequired,
} from '@platform/domain';
import type { ApprovalRepository, TaskRepository } from '../pipeline/store.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/** The site name the pass reports under (`./stranded.ts`). */
export const BUDGET_APPROVAL_SETTLE_SITE = 'budget_approval_settle';

/** Approvals one pass settles, at most. */
export const BUDGET_APPROVAL_SETTLE_PER_PASS = 20;

/** The system component the settle's events carry. */
export const BUDGET_APPROVAL_SETTLE_COMPONENT = 'recovery.budget_approval_settle';

export interface BudgetApprovalSettleRecoverySite {
  readonly approvals: Pick<ApprovalRepository, 'pendingBudgetBelowSamples' | 'load' | 'save'>;
  readonly tasks: Pick<TaskRepository, 'load'>;
  /** The system actor the settle's decision carries. */
  readonly context: (correlationId: Id) => CommandContext;
}

/** One pass: the approvals below the floor, each settled in a transaction of its own. */
export const recoverBudgetApprovalSettle = async (
  options: { readonly unitOfWork: UnitOfWork; readonly logger?: Logger },
  site: BudgetApprovalSettleRecoverySite,
  input: { readonly limit: number },
): Promise<{ readonly found: number; readonly settled: number }> => {
  const due = await options.unitOfWork.transaction(async (scope) =>
    site.approvals.pendingBudgetBelowSamples(scope.tx, {
      belowSamples: MIN_ESTIMATE_SAMPLES_FOR_APPROVAL,
      limit: Math.max(0, Math.min(input.limit, BUDGET_APPROVAL_SETTLE_PER_PASS)),
    }),
  );
  let settled = 0;
  const logger = options.logger ?? silentLogger;
  for (const approvalId of due) {
    // One approval's lost race (a person deciding it in the same instant, a version conflict on
    // its task's stream) must not abort the rest of this row or of the recovery pass: it is
    // logged and found again on the next pass while it is still pending.
    const done = await options.unitOfWork
      .transaction(async (scope) => {
        // Re-read in this transaction: another pass, or a person, may have decided it since.
        const stored = await site.approvals.load(scope.tx, approvalId);
        if (stored === null || stored.approval.kind !== 'budget') {
          return false;
        }
        if (stored.approval.status !== 'pending') {
          return false;
        }
        const samples =
          stored.subjectDetail?.estimate_samples ??
          (await site.tasks.load(scope.tx, stored.approval.taskId))?.estimateSamples ??
          null;
        if (samples === null || estimateRestsOnEnough(samples)) {
          return false;
        }
        const decision = settleBudgetApprovalNotRequired(
          stored.approval,
          { samples, min: MIN_ESTIMATE_SAMPLES_FOR_APPROVAL },
          site.context(stored.approval.taskId),
        );
        await site.approvals.save(scope.tx, {
          ...stored,
          approval: decision.aggregate,
          autoDecided: true,
        });
        await scope.events.append(decision.events);
        return true;
      })
      .catch((error: unknown) => {
        logger.warn(
          { err: error, approval_id: approvalId },
          'budget approval settle: this approval could not be settled now; the next pass tries again',
        );
        return false;
      });
    if (done) {
      settled += 1;
    }
  }
  if (settled > 0) {
    logger.info(
      { settled, min_samples: MIN_ESTIMATE_SAMPLES_FOR_APPROVAL },
      'budget approvals asked on too few finished tasks were settled as no longer required (S-28.16)',
    );
  }
  return { found: due.length, settled };
};
