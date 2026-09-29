/**
 * `pipeline.outbound` duty **question_settled** — an answered or expired question's chat message
 * says so, and loses its buttons (WP-88, PROGRESS backlog 233).
 *
 * WP-88 posts a question through `postQuestion`, whose Block Kit carries one button per option and
 * the line *"Reply in this thread to answer."* Once the question is answered — on the task page, in
 * the ticket, by a click, or by a reply — or expires at its deadline, that message is a request for
 * something already done, and its buttons are a control that lies (the aggregate refuses a second
 * answer, `decision_refused: already_decided`). This edits it, exactly as WP-65's
 * `approval-settled.ts` edits a settled approval: the same questions, in the same order, and the
 * same two-ended race.
 *
 *  1. **Is the question settled?** Reloaded rather than read off the wake-up: the aggregate is the
 *     authority. `escalated` follows `expired` (the escalation handler parks the task), so both read
 *     as expired.
 *  2. **Was a message posted with an address?** The notify duty records the question's
 *     `message_ref` whenever it posted it immediately (WP-88). No address means a digest line or
 *     nothing — nothing to edit.
 *  3. **Can this binding edit a message?** A provider that cannot is named and left alone.
 *  4. **Edit**, through the executor, keyed by the question, so a retried job replays.
 *
 * The notify duty that posts the question may still be running when the answer lands; it asks
 * question 1 again after it records the address and calls {@link settleQuestionMessage} itself, and
 * both ends use {@link questionSettledKey}, so whichever runs second replays.
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
import { type SettledQuestionOutcome, settledQuestionBody } from './render.js';

/** The key both ends of the race use — platform identities only (`idempotencyScopeFor`). */
export const questionSettledKey = (questionId: Id): string =>
  `notify:question-settled:${questionId}`;

export type QuestionSettledOutcome =
  | 'updated'
  | 'open'
  | 'no_question'
  | 'no_message'
  | 'no_binding'
  | 'cannot_update';

/**
 * Edits the question's message, if there is one to edit. Exported for the notify duty's end of the
 * race; the job's end is {@link runQuestionSettled}.
 */
export const settleQuestionMessage = async (
  options: NotifyOptions,
  input: { readonly projectId: Id; readonly questionId: Id },
): Promise<QuestionSettledOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const { projectId, questionId } = input;
  const read = await options.unitOfWork.transaction(async (scope) => {
    const question = await options.store.questions.load(scope.tx, questionId);
    if (question === null) {
      return null;
    }
    const message = await options.notifications.questionMessage(scope.tx, questionId);
    const task =
      message === null || message.taskId === null
        ? null
        : await options.store.tasks.load(scope.tx, message.taskId);
    const answererId = question.answeredByUserId;
    const answerer =
      answererId === null ? null : await options.notifications.userName(scope.tx, answererId);
    return { question, message, task, answerer };
  });
  if (read === null) {
    logger.debug({ question_id: questionId }, 'question settled: the question is gone');
    return 'no_question';
  }
  const status = read.question.status;
  if (status === 'open') {
    return 'open';
  }
  if (read.message === null || read.message.messageRef === null) {
    logger.debug(
      { question_id: questionId },
      'question settled: no message was posted for it with an address, so there is nothing to edit',
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
      { project_id: projectId, question_id: questionId },
      'question settled: the project no longer has a chat binding; the posted question cannot be edited',
    );
    return 'no_binding';
  }
  if (!chat.port.capabilities().messageUpdate) {
    logger.info(
      { project_id: projectId, question_id: questionId, provider: chat.ref.provider },
      'question settled: this chat provider cannot edit a message, so the posted question stays; a second answer is refused by the question',
    );
    return 'cannot_update';
  }

  const outcome: SettledQuestionOutcome = status === 'answered' ? 'answered' : 'expired';
  const ticket = read.task?.task.ticket ?? null;
  const name = chat.redactor.redactText(ticket?.key ?? 'This task').value;
  const url = ticket === null ? null : chat.redactor.redactText(ticket.url).value;
  const mode: TaskMode = read.message.mode;
  await communicationWrites(integrations).updateMessage(
    {
      message: messageRef,
      body: settledQuestionBody({
        subject: { name, url },
        outcome,
        answerer:
          outcome === 'answered' && read.answerer !== null
            ? chat.redactor.redactText(read.answerer).value
            : null,
      }),
      idempotencyKey: questionSettledKey(questionId),
    },
    { projectId, taskId: read.message.taskId, mode },
  );
  return 'updated';
};

export const runQuestionSettled = async (
  options: NotifyOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  if (data.question_id === undefined) {
    (options.logger ?? silentLogger).warn(
      { project_id: data.project_id },
      'question settled: the wake-up named no question',
    );
    return;
  }
  await settleQuestionMessage(options, {
    projectId: data.project_id as Id,
    questionId: data.question_id as Id,
  });
};
