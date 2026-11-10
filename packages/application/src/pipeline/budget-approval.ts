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
 * (`integrations/inbound-decisions.ts`) — and both ask these two functions in the same order: the
 * change is **read** before the aggregate decides (so the event carries it), and **written** only
 * after the aggregate and the subject check accepted the decision, so a refused decision writes
 * no cap.
 */
import { MAX_TASK_CAP_USD } from '@platform/contracts';
import type { ApprovalCapChange } from '@platform/domain';
import { capAfterBudgetApproval } from '@platform/domain';
import type { Transaction } from '../ports/transaction.js';
import type { StoredApproval, TaskRepository } from './store.js';

/** What approving `stored` would do to its task's cap, or `undefined` for nothing. Reads only. */
export const budgetApprovalCapChange = async (
  tasks: Pick<TaskRepository, 'budgetCap'>,
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
  const beforeUsd = (await tasks.budgetCap(tx, approval.taskId)) ?? input.defaultCapUsd;
  const afterUsd = capAfterBudgetApproval({
    estimateUsd,
    capUsd: beforeUsd,
    maxCapUsd: MAX_TASK_CAP_USD,
  });
  return afterUsd === null ? undefined : { beforeUsd, afterUsd };
};

/** Writes the raise the decision carried — after the aggregate accepted it, never before. */
export const applyBudgetApprovalCap = async (
  tasks: Pick<TaskRepository, 'raiseBudgetCap'>,
  tx: Transaction,
  input: {
    readonly taskId: StoredApproval['approval']['taskId'];
    readonly change: ApprovalCapChange | undefined;
    readonly defaultCapUsd: number;
  },
): Promise<void> => {
  if (input.change === undefined) {
    return;
  }
  // `raised: false` only when another writer already put the cap at or above the estimate in this
  // instant (the row lock serialises the two): the task is then covered, and nothing is lowered.
  await tasks.raiseBudgetCap(tx, {
    taskId: input.taskId,
    capUsd: input.change.afterUsd,
    defaultCapUsd: input.defaultCapUsd,
  });
};

/** The audit row's two fields for a decision that raised the cap (`human_actions.params`). */
export const capChangeAuditParams = (
  change: ApprovalCapChange | null | undefined,
): Readonly<Record<string, number>> =>
  change === null || change === undefined
    ? {}
    : { cap_before_usd: change.beforeUsd, cap_after_usd: change.afterUsd };
