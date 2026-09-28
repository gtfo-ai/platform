/**
 * `pipeline.outbound` duty **notify_organisation** — the notification that has no project (WP-65,
 * PROGRESS backlog 80).
 *
 * BD-010's organisation cap is the budget with the widest blast radius: at 100 % it stops every
 * project's runs. It was also the one budget nobody heard about — `decideNotification` returned
 * `null` for it, because a chat binding belongs to a project and this has none, and
 * `notifications.project_id` was `not null`, so there was no row for it to live in either.
 *
 * Backlog 80 weighed three answers and this is **(c), the account's own channel**: a communication
 * account (`integrations`, org-scoped by construction) names a default channel in its own config,
 * the one every project binding overrides. So the organisation already has a channel a human
 * chose, and this posts **exactly one** message there. The rejected two: (a) an organisation-level
 * binding is a new binding scope `bindings(project_id)` cannot express; (b) a fan-out to every
 * project's channel is N messages for one event, each reading as though that project's cap were
 * spent.
 *
 * The shape is `duty.ts`'s — transaction / no transaction / transaction — with three differences,
 * each a consequence of having no project:
 *
 *  1. **No digest and no quiet hours.** Both are `features.digest`, a *project* setting, and there
 *     is no organisation configuration document to hang one on (technical/08: `PATCH /api/org` is
 *     unbuilt). The only two classes that reach here are budget classes, delivered immediately. A
 *     failed delivery is therefore never carried by a digest: it stays undelivered and is counted
 *     by the `notifications_undelivered` gauge past the job's own retry window (backlog 81), and
 *     since WP-84 the recovery pass re-posts it once past that window (backlog 236 (2)). A
 *     configuration the loader refuses records the undelivered row too (Q103, below).
 *  2. **The row has no project and no task** (migration 0051, `nulls not distinct`), so a
 *     duplicated wake-up still stops at the unique key.
 *  3. **The audit row names the account and no project.** The call goes through
 *     `IntegrationActionExecutor` like every other, and its audit row, idempotency record and
 *     rate-limit budget are keyed by `integrations.id` — that account's credential is what was in
 *     scope. Attributing it to a project the account happens to be bound to would state something
 *     false about what was in scope (WP-51's rule; technical/06 § "Outbound: actions").
 */
import type { Id, IsoDateTime, NotificationClass } from '@platform/contracts';
import { notificationClassSchema } from '@platform/contracts';
import { isUrgentNotification } from '@platform/domain';
import {
  communicationWrites,
  integrationsForOrganisation,
  noRunScopedSecrets,
  type PipelineIntegrations,
} from '../pipeline/integrations.js';
import type { OrganisationOutboundData } from '../pipeline/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { NotifyOptions } from './options.js';
import { awaitsImmediateRetry } from './ports.js';
import { notificationBody, notificationDraft } from './render.js';

/** The classes an organisation-scoped notification can be; anything else is refused by name. */
const ORGANISATION_CLASSES = ['budget_threshold', 'budget_exhausted'] as const;

export const runOrganisationNotification = async (
  options: NotifyOptions,
  data: OrganisationOutboundData,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const parsed = notificationClassSchema.safeParse(data.notification_class);
  if (!parsed.success || !(ORGANISATION_CLASSES as readonly string[]).includes(parsed.data)) {
    logger.warn(
      { notification_class: String(data.notification_class) },
      'notify: an organisation-scoped wake-up named a class that is not an organisation budget',
    );
    return;
  }
  const notificationClass = parsed.data;
  const causeEventId = data.cause_event_id as Id;

  // Outside every transaction: the account's row, its secret and an envelope decryption.
  let integrations: PipelineIntegrations;
  try {
    integrations = await integrationsForOrganisation(options.organisation, noRunScopedSecrets());
  } catch (error) {
    await recordRefusedConfiguration(options, {
      notificationClass,
      causeEventId,
      subject: String(data.notification_subject ?? 'The organisation'),
      detail: data.notification_detail === undefined ? null : String(data.notification_detail),
    });
    throw error;
  }
  const chat = integrations.communication;
  if (chat === null) {
    /**
     * **`warn`, not `debug`** — the project path's answer to a missing binding is `debug`, because
     * a project with no chat is a project that chose none. This is the stop of every project with
     * nobody told, and standing rule 18 says the absent case must not be the quiet one.
     */
    logger.warn(
      { notification_class: notificationClass, cause_event_id: causeEventId },
      'notify: an organisation budget notification has no channel — no communication account names a default channel (integrations.config), so nobody was told',
    );
    return;
  }

  const at = options.clock.now() as IsoDateTime;
  const subject = chat.redactor.redactText(String(data.notification_subject ?? 'The organisation'));
  const detail =
    data.notification_detail === undefined
      ? { value: null as string | null, count: 0 }
      : chat.redactor.redactText(String(data.notification_detail));
  const draft = notificationDraft({
    notificationClass,
    subject: { name: subject.value, url: null },
    detail: detail.value,
  });

  const fresh = options.ids.next();
  const recorded = await options.unitOfWork.transaction(async (scope) =>
    options.notifications.record(scope.tx, {
      id: fresh,
      projectId: null,
      taskId: null,
      notificationClass,
      causeEventId,
      title: draft.title,
      detail: draft.detail,
      url: null,
      // The organisation has no `features.digest.urgent` to consult, so the platform default is
      // the answer — which lists `budget_exhausted` (product/18:33's "budget 100 %").
      urgent: isUrgentNotification(notificationClass, undefined),
      plannedDelivery: 'immediate',
      mode: 'normal',
      createdAt: at,
      redactionCount: subject.count + detail.count,
    }),
  );
  /**
   * **A duplicate is not a delivery** (WP-65 review round 1). The row is recorded *before* the
   * provider is called, so when that call throws, pg-boss retries the job and `record` answers
   * `false` — and reading that as "already told" gave the organisation's loudest alarm exactly one
   * attempt, with no digest to carry it afterwards. So the retry reads the row back: a delivered
   * row is a stop; a recorded, undelivered one is this job’s own
   * earlier attempt, and it posts again under the same idempotency key.
   */
  let id = fresh;
  let posted = draft;
  if (!recorded) {
    const existing = await options.unitOfWork.transaction(async (scope) =>
      options.notifications.findByCause(scope.tx, {
        projectId: null,
        causeEventId,
        notificationClass,
      }),
    );
    if (!awaitsImmediateRetry(existing)) {
      logger.debug(
        { cause_event_id: causeEventId, notification_class: notificationClass },
        'notify: this organisation notification is already delivered',
      );
      return;
    }
    id = existing.id;
    // The row's own words (WP-84): a re-post rebuilt from the row carries no detail to re-render.
    posted = {
      notificationClass,
      title: existing.title,
      detail: existing.detail,
      url: existing.url,
    };
  }

  await communicationWrites(integrations).channelMessage(
    {
      body: notificationBody(posted),
      // The platform's identities only — an event id and a closed class — so the executor never
      // has to refuse the key (`idempotencyScopeFor`). Scoped by the executor to this account.
      idempotencyKey: `notify:${causeEventId}:${notificationClass}`,
    },
    { projectId: null, taskId: null, mode: 'normal' },
  );

  await options.unitOfWork.transaction(async (scope) =>
    options.notifications.markDelivered(scope.tx, {
      id,
      at: options.clock.now() as IsoDateTime,
      via: 'immediate',
    }),
  );
};

/**
 * A refused organisation configuration **leaves a row** (WP-84, PROGRESS backlog 236 half (2), Q103).
 *
 * The loader throws for a configuration it will not guess about — two communication accounts that
 * each name a channel (Q103's refusal), an account it cannot build — and before WP-84 it threw
 * before `record`, so the organisation's loudest alarm left **no** `notifications` row: the
 * `notifications_undelivered` gauge could not count what did not exist, and the only traces were a
 * log line and a failed job. So the refusal records the row it would have delivered — undelivered,
 * planned `immediate` — and the job still fails with the loader's error. The gauge counts it past
 * the job's retry window; the re-post row re-enqueues it once, which meets the same refusal until an
 * operator fixes the configuration, and then delivers it.
 *
 * **Unredacted, and why that is sound here**: there is no account to take a redactor from — that is
 * what was refused — and the two strings are platform text (the handler's `The organisation` and a
 * budget line of two numbers and a window name, `notify/handlers.ts`), so `redaction_count` is 0 by
 * construction rather than by omission. A duplicate from a retry stops at the unique key.
 */
const recordRefusedConfiguration = async (
  options: NotifyOptions,
  input: {
    readonly notificationClass: NotificationClass;
    readonly causeEventId: Id;
    readonly subject: string;
    readonly detail: string | null;
  },
): Promise<void> => {
  const draft = notificationDraft({
    notificationClass: input.notificationClass,
    subject: { name: input.subject, url: null },
    detail: input.detail,
  });
  await options.unitOfWork.transaction(async (scope) =>
    options.notifications.record(scope.tx, {
      id: options.ids.next(),
      projectId: null,
      taskId: null,
      notificationClass: input.notificationClass,
      causeEventId: input.causeEventId,
      title: draft.title,
      detail: draft.detail,
      url: null,
      urgent: isUrgentNotification(input.notificationClass, undefined),
      plannedDelivery: 'immediate',
      mode: 'normal',
      createdAt: options.clock.now() as IsoDateTime,
      redactionCount: 0,
    }),
  );
};
