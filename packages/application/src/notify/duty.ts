/**
 * `pipeline.outbound` duty **notify** — the job that actually says something (WP-32).
 *
 * The shape is WP-15d's and the ordering is the whole of it: **transaction / no transaction /
 * transaction**. The task is read in one, the bindings are resolved and the provider is called in
 * none, and the row that records what happened is written in another. Nothing here holds a database
 * connection while a chat provider is answering, and `events/open-transaction.ts` refuses it if a
 * later change tries.
 *
 * ## Six questions, in this order, and each one has a name
 *
 *  1. **What class is this?** From the wake-up, parsed rather than cast — a job payload is a wire
 *     boundary like any other.
 *  2. **Is there still a task, and is it one a human would want a message about?** A platform-issued
 *     ticket (`platform:lint!ACME-2`, a review-only subject, a discovery task) gets no *started*,
 *     *completed* or *cancelled* message: there is no ticket for a human to open, and the platform's
 *     own housekeeping arriving in a channel is what makes a bot unwelcome. Its **questions and
 *     escalations still notify**, because those are the two classes where a human is the point.
 *  3. **Does this project have a chat binding?** `null` is absent-not-broken (standing rule 20):
 *     logged with a reason and no row written, because a row nothing can ever deliver is a table
 *     that grows for ever. A binding that fails to *load* throws, which is the loader's asymmetry
 *     and not this file's.
 *  4. **Immediate or digest?** `notificationDelivery` decides, from the project's configuration and
 *     the organisation's wall clock — the injected one, never the host's.
 *  5. **Has this already been recorded?** `(project, cause event, class)` is unique, so a duplicated
 *     wake-up stops here. This is the idempotency that matters: the provider's own key stops a
 *     duplicate *message*, and this stops a duplicate *row* — and therefore a duplicate digest line.
 *  6. **Deliver, or leave it for the digest.** An immediate delivery that throws leaves the row
 *     undelivered, which means the next digest carries it: a failure is a delay, never a loss.
 */
import type { Id, IsoDateTime, NotificationClass, TaskMode } from '@platform/contracts';
import { notificationClassSchema } from '@platform/contracts';
import { isUrgentNotification, notificationDelivery, toApprovalRecord } from '@platform/domain';
import {
  communicationWrites,
  integrationsForProject,
  namesAProviderTicket,
  noRunScopedSecrets,
} from '../pipeline/integrations.js';
import type { PipelineOutboundData } from '../pipeline/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { NotifyOptions } from './options.js';
import { digestSettingsOf, localMinutesOf } from './policy.js';
import { notificationBody, notificationDraft } from './render.js';

/** The classes a task with no human-visible ticket is not worth announcing. */
const PLATFORM_TASK_SILENT_CLASSES: readonly NotificationClass[] = [
  'task_started',
  'task_completed',
  'task_cancelled',
];

export const runNotification = async (
  options: NotifyOptions,
  data: PipelineOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const projectId = data.project_id as Id;
  const causeEventId = data.cause_event_id as Id;
  const parsedClass = notificationClassSchema.safeParse(data.notification_class);
  if (!parsedClass.success) {
    logger.warn(
      { project_id: projectId, notification_class: String(data.notification_class) },
      'notify: the wake-up named no notification class this build knows',
    );
    return;
  }
  const notificationClass = parsedClass.data;

  const stored =
    data.task_id === undefined
      ? null
      : await options.unitOfWork.transaction(async (scope) =>
          options.store.tasks.load(scope.tx, data.task_id as Id),
        );
  if (data.task_id !== undefined && stored === null) {
    logger.debug({ task_id: data.task_id }, 'notify: the task is gone');
    return;
  }
  if (
    stored !== null &&
    !namesAProviderTicket(stored.task.ticket) &&
    PLATFORM_TASK_SILENT_CLASSES.includes(notificationClass)
  ) {
    logger.debug(
      { task_id: stored.task.id, notification_class: notificationClass },
      'notify: a platform-issued ticket has no lifecycle a channel needs to hear about',
    );
    return;
  }

  /**
   * An approval is announced only while it is still pending (WP-43). The wake-up is at-least-once
   * and minutes late, and by then a person may have decided it on the task page or the deadline may
   * have expired it: a message with buttons for a decided approval is the dead control WP-32
   * refused to ship, so a settled one is not announced at all — no row, no message.
   */
  const approval =
    notificationClass === 'approval' && data.approval_id !== undefined
      ? await options.unitOfWork.transaction(async (scope) =>
          options.store.approvals.load(scope.tx, data.approval_id as Id),
        )
      : null;
  if (
    notificationClass === 'approval' &&
    (approval === null || approval.approval.status !== 'pending')
  ) {
    logger.debug(
      { task_id: data.task_id, approval_id: data.approval_id },
      'notify: the approval is no longer pending, so there is nothing to ask',
    );
    return;
  }

  const mode: TaskMode = stored?.task.mode ?? 'normal';
  // Outside every transaction: resolving a binding is a `bindings` read, a `secrets` read and an
  // envelope decryption, and the executor's audit row commits in a transaction of its own.
  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  const chat = integrations.communication;
  if (chat === null) {
    logger.debug(
      { project_id: projectId, notification_class: notificationClass },
      'notify: the project has no communication binding',
    );
    return;
  }

  const settings = await options.settings.forProject(projectId);
  const digest = digestSettingsOf(settings.config);
  const at = options.clock.now() as IsoDateTime;
  const delivery = notificationDelivery({
    notificationClass,
    digestEnabled: digest.enabled,
    quietHours: digest.quietHours,
    urgentClasses: digest.urgent,
    localMinutes: localMinutesOf(at, options.timezone),
  });

  // TD-012 step 1 **and** step 2, from the binding this message is going through: the title, the
  // detail and the URL are stored, and the executor redacts the audit row rather than the text a
  // caller keeps.
  const redactedDetail =
    data.notification_detail === undefined
      ? { value: null as string | null, count: 0 }
      : (() => {
          const outcome = chat.redactor.redactText(String(data.notification_detail));
          return { value: outcome.value, count: outcome.count };
        })();
  const subjectName =
    stored === null ? String(data.notification_subject ?? 'This project') : stored.task.ticket.key;
  const redactedSubject = chat.redactor.redactText(subjectName);
  // The URL is provider text like the other two, and it is stored *and* sent: `tasks.ticket_url`
  // is whatever the ticket said, and `urlSchema` is `z.url()` — no bound, any scheme (Q49). So it
  // goes through the binding's redactor here and through `boundUrl` in the renderer, and its
  // replacements are counted into the row like the subject's and the detail's.
  const ticketUrl = stored?.task.ticket.url ?? null;
  const redactedUrl =
    ticketUrl === null
      ? { value: null as string | null, count: 0 }
      : chat.redactor.redactText(ticketUrl);
  const draft = notificationDraft({
    notificationClass,
    subject: { name: redactedSubject.value, url: redactedUrl.value },
    detail: redactedDetail.value,
  });

  const id = options.ids.next();
  const recorded = await options.unitOfWork.transaction(async (scope) =>
    options.notifications.record(scope.tx, {
      id,
      projectId,
      taskId: stored?.task.id ?? null,
      notificationClass,
      causeEventId,
      title: draft.title,
      detail: draft.detail,
      url: draft.url,
      urgent: isUrgentNotification(notificationClass, digest.urgent),
      plannedDelivery: delivery,
      mode,
      createdAt: at,
      redactionCount: redactedDetail.count + redactedSubject.count + redactedUrl.count,
    }),
  );
  if (!recorded) {
    logger.debug(
      { project_id: projectId, cause_event_id: causeEventId },
      'notify: this notification is already recorded',
    );
    return;
  }
  if (delivery === 'digest') {
    logger.debug(
      { project_id: projectId, notification_class: notificationClass },
      'notify: held for the next digest (quiet hours)',
    );
    return;
  }

  const chats = communicationWrites(integrations);
  const context = { projectId, taskId: stored?.task.id ?? null, mode };
  const body = notificationBody(draft);
  const idempotencyKey = `notify:${causeEventId}:${notificationClass}`;
  if (stored === null) {
    /**
     * No task, so no thread: a budget window belongs to a project, not to a ticket
     * (`postChannelMessage`, the port obligation this work package added).
     */
    await chats.channelMessage({ body, idempotencyKey }, context);
  } else {
    /**
     * The thread's **root** is the task header and every other notification is a reply to it
     * (product/03 UJ-2: one thread per task, and the answers stay with the question).
     *
     * `task_started` is the one class whose message *is* the root, so it is not posted twice: for
     * every other class the root is opened with the header alone — which happens at most once per
     * task, because the call carries an idempotency plan keyed by the task and a second one
     * replays the stored `ThreadRef` without issuing a request.
     */
    const root =
      notificationClass === 'task_started'
        ? body
        : notificationBody(
            notificationDraft({
              notificationClass: 'task_started',
              subject: { name: redactedSubject.value, url: redactedUrl.value },
              detail: null,
            }),
          );
    const thread = await chats.taskThread({ taskId: stored.task.id, body: root }, context);
    if (thread === null) {
      return;
    }
    if (approval !== null) {
      /**
       * **Buttons only once a click can arrive** (WP-43, criterion 6). The adapter answers
       * `buttons` from its own configuration — for Slack, the transport it is set to receive on
       * and the credentials that transport needs — so a binding that could never deliver a click
       * gets the same notification as text, which names the task page as the place to decide.
       * What no adapter can answer is whether a process is holding the socket *right now*; that
       * residual is named in PROGRESS under WP-43 rather than implied here.
       */
      if (chat.port.capabilities().buttons) {
        await chats.approval(
          {
            thread,
            approval: toApprovalRecord(approval.approval),
            body,
            idempotencyKey,
          },
          context,
        );
      } else {
        await chats.message(
          {
            thread,
            body: notificationBody({
              ...draft,
              detail:
                `${draft.detail ?? ''}\nDecide on the task page: this chat binding cannot receive a click.`.trim(),
            }),
            idempotencyKey,
          },
          context,
        );
      }
    } else if (notificationClass !== 'task_started') {
      await chats.message({ thread, body, idempotencyKey }, context);
    }
  }

  await options.unitOfWork.transaction(async (scope) =>
    options.notifications.markDelivered(scope.tx, {
      id,
      at: options.clock.now() as IsoDateTime,
      via: 'immediate',
    }),
  );
};
