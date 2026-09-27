/**
 * `pipeline.outbound` duty **approval_settled** — a decided or expired approval's chat message
 * loses its buttons (WP-65, PROGRESS backlog 202).
 *
 * WP-43 posts an approval with Approve / Request changes buttons, and `updateMessage` — declared on
 * the port and implemented by Slack — had no caller, so once the approval was decided on the task
 * page or expired at its deadline (WP-56) the buttons stayed live. A press was then refused by the
 * aggregate (`decision_refused: already_decided`), which kept the state right and left a control
 * that lies. This edits the message to say how the approval was settled.
 *
 * ## The questions, in order
 *
 *  1. **Is the approval settled?** Reloaded rather than read off the wake-up: the aggregate is the
 *     authority, and the event's `decision` must agree with it (a disagreement is logged, and the
 *     row wins).
 *  2. **Was a message with buttons posted?** The outbox row the notify duty wrote carries the
 *     message's address (`message_ref`, migration 0051) only when it posted an approval with
 *     buttons immediately. No address means nothing to edit — a digest line, the text fallback of a
 *     binding that cannot receive a click, a shadow task, or an approval announced by nobody.
 *  3. **Can this binding edit a message?** `capabilities().messageUpdate`; a provider that cannot is
 *     named and left alone, never answered with a second message beside live buttons.
 *  4. **Edit**, through the executor, keyed by the approval, so a retried job replays.
 *
 * ## The race, closed from both ends
 *
 * The notify duty that posts the buttons may still be running when the decision lands — it read
 * the approval as pending, then the person decided on the task page. Question 2 would then find no
 * address yet and stop, and the buttons would be posted a moment later with nothing left to edit
 * them. So the notify duty asks question 1 again **after** it records the address, and calls
 * {@link settleApprovalMessage} itself when the approval is no longer pending. Both ends use the
 * same idempotency key, so whichever runs second replays instead of editing twice.
 */
import type { Id, TaskMode } from '@platform/contracts';
import {
  communicationWrites,
  integrationsForProject,
  noRunScopedSecrets,
} from '../pipeline/integrations.js';
import type { PipelineOutboundData } from '../pipeline/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { NotifyOptions } from './options.js';
import { type SettledApprovalOutcome, settledApprovalBody } from './render.js';

/** The key both ends of the race use — platform identities only (`idempotencyScopeFor`). */
export const approvalSettledKey = (approvalId: Id): string =>
  `notify:approval-settled:${approvalId}`;

export type ApprovalSettledOutcome =
  | 'updated'
  | 'pending'
  | 'no_approval'
  | 'no_message'
  | 'no_binding'
  | 'cannot_update';

/**
 * Edits the approval's message, if there is one to edit. Exported for the notify duty's end of the
 * race; the job's end is {@link runApprovalSettled}.
 */
export const settleApprovalMessage = async (
  options: NotifyOptions,
  input: { readonly projectId: Id; readonly approvalId: Id; readonly decision?: string },
): Promise<ApprovalSettledOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const { projectId, approvalId } = input;
  const read = await options.unitOfWork.transaction(async (scope) => {
    const approval = await options.store.approvals.load(scope.tx, approvalId);
    if (approval === null) {
      return null;
    }
    const message = await options.notifications.approvalMessage(scope.tx, approvalId);
    const task =
      message?.taskId === null || message === null
        ? null
        : await options.store.tasks.load(scope.tx, message.taskId);
    // Who decided, by name (WP-73, backlog 234); an expired approval has no decider.
    const deciderId = approval.approval.decidedByUserId;
    const decider =
      deciderId === null ? null : await options.notifications.userName(scope.tx, deciderId);
    return { approval, message, task, decider };
  });
  if (read === null) {
    logger.debug({ approval_id: approvalId }, 'approval settled: the approval is gone');
    return 'no_approval';
  }
  const status = read.approval.approval.status;
  if (status === 'pending') {
    return 'pending';
  }
  if (input.decision !== undefined && input.decision !== status) {
    logger.warn(
      { approval_id: approvalId, event_decision: input.decision, status },
      'approval settled: the event and the approval row disagree; the row is what the message says',
    );
  }
  if (read.message === null || read.message.messageRef === null) {
    logger.debug(
      { approval_id: approvalId },
      'approval settled: no message with buttons was posted for it, so there is nothing to edit',
    );
    return 'no_message';
  }
  const messageRef = read.message.messageRef;

  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const chat = integrations.communication;
  if (chat === null) {
    logger.info(
      { project_id: projectId, approval_id: approvalId },
      'approval settled: the project no longer has a chat binding; the posted buttons cannot be removed',
    );
    return 'no_binding';
  }
  if (!chat.port.capabilities().messageUpdate) {
    logger.info(
      { project_id: projectId, approval_id: approvalId, provider: chat.ref.provider },
      'approval settled: this chat provider cannot edit a message, so the posted buttons stay; a press is refused by the approval',
    );
    return 'cannot_update';
  }

  const ticket = read.task?.task.ticket ?? null;
  const name = chat.redactor.redactText(ticket?.key ?? 'This task').value;
  const url = ticket === null ? null : chat.redactor.redactText(ticket.url).value;
  const mode: TaskMode = read.message.mode;
  await communicationWrites(integrations).updateMessage(
    {
      message: messageRef,
      body: settledApprovalBody({
        subject: { name, url },
        outcome: status as SettledApprovalOutcome,
        decider: read.decider === null ? null : chat.redactor.redactText(read.decider).value,
      }),
      idempotencyKey: approvalSettledKey(approvalId),
    },
    { projectId, taskId: read.message.taskId, mode },
  );
  return 'updated';
};

export const runApprovalSettled = async (
  options: NotifyOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  if (data.approval_id === undefined) {
    (options.logger ?? silentLogger).warn(
      { project_id: data.project_id },
      'approval settled: the wake-up named no approval',
    );
    return;
  }
  await settleApprovalMessage(options, {
    projectId: data.project_id as Id,
    approvalId: data.approval_id as Id,
    ...(data.approval_decision === undefined ? {} : { decision: data.approval_decision }),
  });
};
