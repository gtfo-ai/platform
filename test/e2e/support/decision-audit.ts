/**
 * **The shape a decision's `human_actions` row has, whichever door it came through** (WP-88,
 * PROGRESS backlog 199).
 *
 * The ruling on backlog 199 (technical/13, WP-88) is that a chat decision writes its
 * `human_actions` row in the delivery's transaction, so the task's audit panel — which pages that
 * table only — reads one shape whether a person pressed Approve on the task page or in Slack. This
 * helper is that shape, and both e2e cases (`test/e2e/server/command-api.e2e.test.ts` for the task
 * page, `test/e2e/pipeline/slack-socket.e2e.test.ts` for chat) assert against it, so the two doors
 * cannot drift apart without one of them failing.
 *
 * What is **common** — `action`, `user_id`, `task_id` and the params keys `task_id`,
 * `approval_id`, `decision`, `channel` — is compared here. What is the **door's own** stays with the
 * case: the route's `idempotency_key`/`body_digest`, and the chat's `provider`/`integration_id`/
 * `delivery_id`.
 */
import type { JsonObject } from '@platform/contracts';

export const DECISION_AUDIT_PARAM_KEYS = ['task_id', 'approval_id', 'decision', 'channel'] as const;

export interface DecisionAuditRow {
  readonly action: string;
  readonly user_id: string | null;
  readonly task_id: string | null;
  readonly params: JsonObject;
}

/** The common half of an approval decision's audit row. */
export const decisionAuditShape = (row: DecisionAuditRow) => ({
  action: row.action,
  user_id: row.user_id,
  task_id: row.task_id,
  params: Object.fromEntries(
    DECISION_AUDIT_PARAM_KEYS.map((key) => [key, row.params[key] ?? null]),
  ) as Record<(typeof DECISION_AUDIT_PARAM_KEYS)[number], unknown>,
});

/** What that half must say for an approval `approvalId` on `taskId`, decided by `userId`. */
export const expectedApprovalAudit = (input: {
  readonly taskId: string;
  readonly approvalId: string;
  readonly userId: string;
  readonly channel: 'ui' | 'slack';
}) => ({
  action: 'task.approval.decide',
  user_id: input.userId,
  task_id: input.taskId,
  params: {
    task_id: input.taskId,
    approval_id: input.approvalId,
    decision: 'approve',
    channel: input.channel,
  },
});
