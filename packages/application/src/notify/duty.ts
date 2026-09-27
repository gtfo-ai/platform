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
import type { Id, IsoDateTime, JsonObject, NotificationClass, TaskMode } from '@platform/contracts';
import { notificationClassSchema } from '@platform/contracts';
import { isUrgentNotification, notificationDelivery, toApprovalRecord } from '@platform/domain';
import {
  communicationWrites,
  integrationsForProject,
  namesAProviderTicket,
  noRunScopedSecrets,
} from '../pipeline/integrations.js';
import type { PipelineOutboundData } from '../pipeline/jobs.js';
import type { MessageRef } from '../ports/integrations/communication.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import { settleApprovalMessage } from './approval-settled.js';
import type { NotifyOptions } from './options.js';
import { digestSettingsOf, localMinutesOf } from './policy.js';
import { awaitsImmediateRetry } from './ports.js';
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

  const fresh = options.ids.next();
  const recorded = await options.unitOfWork.transaction(async (scope) =>
    options.notifications.record(scope.tx, {
      id: fresh,
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
      // WP-65 (backlog 202): which approval the message asks about, so a later decision can find it.
      ...(approval === null ? {} : { approvalId: approval.approval.id }),
    }),
  );
  /**
   * **A duplicate is not a delivery** (WP-65 review round 1, the same shape as
   * `organisation.ts`). The row is recorded before the provider is called, so a provider failure
   * makes pg-boss retry this job into a `record` that answers `false`. For a project with the
   * digest **on**, the next digest would carry the row anyway (late, not lost); for one that
   * switched it **off**, nothing would, and the notification had one attempt. So the
   * retry reads the row back and delivers an undelivered, unclaimed `immediate` one under the same
   * idempotency keys, which the executor replays if the first attempt had in fact succeeded.
   *
   * **Residual, stated** (review round 2): on a digest-on project a retry that lands after
   * `DIGEST_IMMEDIATE_GRACE_MS` can read the row unclaimed an instant before a digest tick claims
   * it, and then both post it — one duplicate line, never a lost one. `markDelivered` does not
   * guard on `delivered_at is null`, so the later of the two writes wins the row's delivery record.
   */
  let id = fresh;
  let plan = delivery;
  if (!recorded) {
    const existing = await options.unitOfWork.transaction(async (scope) =>
      options.notifications.findByCause(scope.tx, { projectId, causeEventId, notificationClass }),
    );
    if (!awaitsImmediateRetry(existing)) {
      logger.debug(
        { project_id: projectId, cause_event_id: causeEventId },
        'notify: this notification is already delivered or held for the digest',
      );
      return;
    }
    id = existing.id;
    plan = existing.plannedDelivery;
  }
  if (plan === 'digest') {
    logger.debug(
      { project_id: projectId, notification_class: notificationClass },
      'notify: held for the next digest (quiet hours)',
    );
    return;
  }

  const chats = communicationWrites(integrations);
  const context = { projectId, taskId: stored?.task.id ?? null, mode };
  /** The posted approval's address, when it was posted with buttons (WP-65, backlog 202). */
  let buttonsAt: MessageRef | null = null;
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
       *
       * **And, for a held transport, only while a process holds it** (WP-72, PROGRESS backlog
       * 200). What no adapter can answer is whether a process is holding the socket *right now* —
       * on a deployment with no process serving `/webhooks/*` the configuration still said yes —
       * so the duty asks the liveness row the holder renews (migration 0054) instead of inferring
       * it. Outside every transaction, like the rest of this phase; a stale or absent row posts
       * text naming the task page, which is the conservative direction.
       */
      const capabilities = chat.port.capabilities();
      const unreachable = !capabilities.buttons
        ? 'this chat binding cannot receive a click'
        : capabilities.socketMode && !(await options.heldConnections.isHeld(chat.ref.integrationId))
          ? 'no process is holding this chat’s connection, so a click would reach nobody'
          : null;
      if (unreachable === null) {
        buttonsAt = await chats.approval(
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
              detail: `${draft.detail ?? ''}\nDecide on the task page: ${unreachable}.`.trim(),
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

  /**
   * The address is **redacted** before it is stored, like everything else this row holds (a
   * provider's own ids are provider text). A redaction inside an id would make the later edit miss
   * its message and fail `not_found` — the loud direction, and a case no provider's id shape reaches.
   */
  const messageRef =
    buttonsAt === null
      ? undefined
      : (chat.redactor.redactJson(buttonsAt as unknown as JsonObject)
          .value as unknown as MessageRef);
  await options.unitOfWork.transaction(async (scope) =>
    options.notifications.markDelivered(scope.tx, {
      id,
      at: options.clock.now() as IsoDateTime,
      via: 'immediate',
      ...(messageRef === undefined ? {} : { messageRef }),
    }),
  );

  if (buttonsAt !== null && approval !== null) {
    /**
     * **The race's second end** (`approval-settled.ts`): the approval was pending when this duty
     * read it, and a person or the deadline may have settled it while the buttons were being
     * posted — in which case the settled duty already ran, found no address, and stopped. So ask
     * again now that the address is recorded; the shared idempotency key makes a double edit a
     * replay.
     */
    await settleApprovalMessage(options, { projectId, approvalId: approval.approval.id });
  }
};
