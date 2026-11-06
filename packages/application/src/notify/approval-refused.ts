/**
 * `pipeline.outbound` duty **approval_refused** — a chat *Approve* the subject guard refused is
 * answered in the approval's thread with the reason and the task page (S-25.9, TD-035 decision 6).
 *
 * The decision path refuses onto the delivery's `inbox` row and decides nothing
 * (`integrations/inbound-decisions.ts`), which keeps the approval right and leaves the person who
 * pressed the button looking at a message that did nothing. So the ingress enqueues this duty after
 * its commit, and the duty says, in the thread the button lives in, why nothing was approved and
 * where to look.
 *
 * ## The questions, in order
 *
 *  1. **Is the wake-up one this build understands?** The refusal is a closed code, parsed rather
 *     than cast; anything else is logged and dropped.
 *  2. **Is there still an approval, and a message to answer under?** The address is the one the
 *     notify duty recorded when it posted the buttons (`message_ref`); a click can only come from
 *     such a message, so none means there is nowhere sensible to answer, and nothing is posted.
 *  3. **Does the project still have a chat binding?** Absent is not broken (standing rule 20).
 *  4. **Answer**, through the executor, keyed by the wake-up's `reply_id`, so a retried job replays
 *     the answer instead of posting it twice.
 *
 * Platform words only (`approval-text.ts`): the reason is a closed code and the name is the ticket
 * key, redacted with the binding's redactor and bounded like every notification's.
 */
import type { Id, TaskMode } from '@platform/contracts';
import type { ApprovalSubjectRefusal } from '../pipeline/commands.js';
import {
  communicationWrites,
  integrationsForProject,
  noRunScopedSecrets,
} from '../pipeline/integrations.js';
import type { ApprovalRefusedData } from '../pipeline/jobs.js';
import type { ThreadRef } from '../ports/integrations/communication.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { APPROVAL_REFUSAL_WORDS, approvalRefusalBody, taskPageUrl } from './approval-text.js';
import type { NotifyOptions } from './options.js';

/** The reply's key — platform identities only (`idempotencyScopeFor`). */
export const approvalRefusedKey = (replyId: string): string => `notify:approval-refused:${replyId}`;

export type ApprovalRefusedOutcome =
  | 'answered'
  | 'unknown_refusal'
  | 'no_approval'
  | 'no_message'
  | 'no_binding';

const isRefusal = (value: unknown): value is ApprovalSubjectRefusal =>
  typeof value === 'string' && Object.hasOwn(APPROVAL_REFUSAL_WORDS, value);

export const runApprovalRefused = async (
  options: NotifyOptions,
  data: ApprovalRefusedData,
): Promise<ApprovalRefusedOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const projectId = data.project_id as Id;
  const approvalId = data.approval_id as Id;
  if (!isRefusal(data.refusal)) {
    logger.warn(
      { approval_id: approvalId, refusal: String(data.refusal) },
      'approval refused: the wake-up named no refusal this build knows',
    );
    return 'unknown_refusal';
  }
  const refusal = data.refusal;

  const read = await options.unitOfWork.transaction(async (scope) => {
    const approval = await options.store.approvals.load(scope.tx, approvalId);
    if (approval === null) {
      return null;
    }
    const message = await options.notifications.approvalMessage(scope.tx, approvalId);
    const task = await options.store.tasks.load(scope.tx, approval.approval.taskId);
    return { approval, message, task };
  });
  if (read === null || read.task === null || read.task.task.projectId !== projectId) {
    logger.debug({ approval_id: approvalId }, 'approval refused: the approval or its task is gone');
    return 'no_approval';
  }
  const messageRef = read.message?.messageRef ?? null;
  if (read.message === null || messageRef === null) {
    logger.info(
      { approval_id: approvalId, refusal },
      'approval refused: no message with buttons is recorded for this approval, so there is no thread to answer in; the refusal is on the inbox row',
    );
    return 'no_message';
  }

  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const chat = integrations.communication;
  if (chat === null) {
    logger.info(
      { project_id: projectId, approval_id: approvalId },
      'approval refused: the project no longer has a chat binding, so the refused press is not answered',
    );
    return 'no_binding';
  }

  // The thread the button lives in: the approval message's own thread, or the message itself when
  // a provider posted it as a thread root.
  const thread: ThreadRef = {
    provider: messageRef.provider,
    channel: messageRef.channel,
    thread_id: messageRef.thread_id ?? messageRef.message_id,
    url: null,
  };
  const mode: TaskMode = read.message.mode;
  await communicationWrites(integrations).message(
    {
      thread,
      body: approvalRefusalBody({
        name: chat.redactor.redactText(read.task.task.ticket.key).value,
        kind: read.approval.approval.kind,
        refusal,
        reviewUrl: taskPageUrl(options.baseUrl, read.task.task.id),
      }),
      idempotencyKey: approvalRefusedKey(data.reply_id),
    },
    { projectId, taskId: read.task.task.id, mode },
  );
  return 'answered';
};
