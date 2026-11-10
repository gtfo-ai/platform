/**
 * **Approving an estimate above the task's cap raises the cap** (S-28.16, BD-010's 2026-11-10
 * amendment decision 2, TD-035's 2026-11-10 amendment decision 2, M28 ruling B2).
 *
 * On Autix the budget approval said *"Approve: the task goes on to Implementation and may spend what
 * was estimated"* — $123.66 — while the task's own cap stayed $50.00, so an approved task would have
 * paused at $50 anyway. A maintainer who approves an estimate is approving that spend, so the
 * decision raises the task's cap to the estimate (rounded up to the cent) in the decision's own
 * transaction, through the one narrow writer `POST /api/tasks/:id/budget` uses
 * (`TaskRepository.raiseBudgetCap`), and the cap before and after ride on `task.approval.decided`
 * and the transport's `human_actions` row. An estimate within the cap changes nothing; a reject
 * changes nothing; a cap is never lowered.
 *
 * Two doors decide an approval — the route (`decideTaskApproval`) and a chat button
 * (`integrations/inbound-decisions.ts`) — and both take the same steps: the aggregate is asked
 * first (a dry run, so a refused decision writes no cap), then the cap is raised, then the decision
 * is recorded carrying the change `raiseBudgetCap` itself reported.
 */
import { MAX_TASK_CAP_USD } from '@platform/contracts';
import type { ApprovalCapChange } from '@platform/domain';
import { usdUpToCents } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';
import type { StoredApproval, TaskRepository } from './store.js';

/**
 * Raises the task's cap for an approved budget, and answers the change **as written** — the cap
 * before is `raiseBudgetCap`'s own `previousCapUsd`, read under the row lock it takes — or
 * `undefined` when nothing was raised (not a budget, not an approval, no recorded estimate, or an
 * estimate at or under the cap in force). Called after the aggregate has accepted the decision (a
 * dry run) and before the decision is recorded, so the event carries exactly what was written
 * (closing BACKLOG 1600).
 */
export const raiseCapForBudgetApproval = async (
  tasks: Pick<TaskRepository, 'raiseBudgetCap'>,
  tx: Transaction,
  input: {
    readonly stored: StoredApproval;
    readonly decision: 'approved' | 'rejected';
    /** The cap a task with no override of its own has (`ProjectSettings.taskBudgetUsd`). */
    readonly defaultCapUsd: number;
  },
): Promise<ApprovalCapChange | undefined> => {
  const { approval, subjectDetail } = input.stored;
  if (approval.kind !== 'budget' || input.decision !== 'approved') {
    return undefined;
  }
  // A row asked before the subject was recorded (pre-0103) names no estimate: nothing to raise to.
  const estimateUsd = subjectDetail?.estimate_usd;
  if (estimateUsd === undefined) {
    return undefined;
  }
  // `max(cap in force, estimate up to the cent)`: `raiseBudgetCap` writes only a raise.
  const afterUsd = Math.min(usdUpToCents(estimateUsd), MAX_TASK_CAP_USD);
  const written = await tasks.raiseBudgetCap(tx, {
    taskId: approval.taskId,
    capUsd: afterUsd,
    defaultCapUsd: input.defaultCapUsd,
  });
  return written.raised ? { beforeUsd: written.previousCapUsd, afterUsd } : undefined;
};

/** The audit row's two fields for a decision that raised the cap (`human_actions.params`). */
export const capChangeAuditParams = (
  change: ApprovalCapChange | null | undefined,
): Readonly<Record<string, number>> =>
  change === null || change === undefined
    ? {}
    : { cap_before_usd: change.beforeUsd, cap_after_usd: change.afterUsd };
