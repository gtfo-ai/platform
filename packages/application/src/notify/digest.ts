/**
 * The daily digest — product/18:33's *"one Slack summary a day"*, and what quiet hours defer into
 * (WP-32).
 *
 * The mechanism half of this file was written at WP-10 as `providers/slack/digest.ts`, whose own
 * docblock said *"WP-32 owns the digest and quiet hours … This module is what that decision will
 * run on"*. It runs on it here instead, one ring in, and the move is the decision BD-017 forces: a
 * digest is a behaviour of the **communication type**, not of Slack. A second provider must get
 * digests without touching the pipeline, and a scheduler that lived in `packages/integrations`
 * could only ever schedule the provider it was written for. Its four properties are kept, and each
 * is still a mistake this shape avoids:
 *
 *  1. **The schedule carries its own timezone** and never inherits the host's (Q38).
 *  2. **The clock is injected.** The day the idempotency key is cut on is read from it, so the test
 *     that proves the second run of a day posts nothing is not a hardware assertion (rule 2).
 *  3. **It goes through the executor**, so a shadow project's digest is recorded `would_have` and
 *     never posted, and a retried job replays instead of posting twice.
 *  4. **An empty digest is not posted.** "Nothing happened today" as a daily message trains people
 *     to ignore the channel.
 *
 * ## Why one schedule for the whole instance rather than one per project
 *
 * `features.digest.at` is a **project** setting and the cron is an **instance** schedule: the job
 * ticks every five minutes in the organisation's zone and each project is served in the tick whose
 * local time has reached its own `at`. The alternative — a cron entry per project — needs a
 * `bindings` sweep at boot and a new entry every time somebody creates a project, so a project
 * created at 10:00 would get no digest until the next restart. The cost of the tick is one indexed
 * query when nothing is pending.
 *
 * ## What stops it posting twice, in the order the guards fire
 *
 *  - a **claim**: the rows are stamped with the day inside a transaction before anything is sent,
 *    so a retry of the same job posts the same set rather than a growing one;
 *  - `digestDelivered`: a day that has already been delivered is skipped, so a later tick does not
 *    start a second digest out of rows that arrived after the first;
 *  - the executor's **idempotency key**, `<provider>:digest:<channel>:<day>`, which is the last
 *    line rather than the first — it makes a replay free, and a replay is not a plan.
 *
 * A *fourth* kind of duplicate is not this list's: a row whose **immediate** delivery is still in
 * flight is undelivered and would otherwise be claimable. {@link DIGEST_IMMEDIATE_GRACE_MS} is the
 * bound that answers it, and the residual it leaves is stated there.
 */
import type { Id, IsoDateTime, TaskMode } from '@platform/contracts';
import { minutesOfTimeOfDay } from '@platform/domain';
import {
  communicationWrites,
  integrationsForProject,
  noRunScopedSecrets,
} from '../pipeline/integrations.js';
import type { DigestItem } from '../ports/integrations/communication.js';
import type { JobHandler, JobWorker } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { NotifyOptions } from './options.js';
import { digestSettingsOf, localDayOf, localMinutesOf } from './policy.js';
import type { StoredNotification } from './ports.js';

/**
 * How often the tick fires, and the two bounds it is between.
 *
 * Finer than an hour, because `features.digest.at` is `HH:MM` and an hourly tick would read a
 * project's 09:30 as 09:00 — a stored key half-read is the defect PROGRESS backlog 58 and 60 are
 * both instances of. Coarser than a minute, because every tick costs one query per instance and a
 * digest is a daily message: five minutes is the granularity at which "09:30" is honoured to within
 * the time it takes somebody to read it.
 */
export const DIGEST_TICK_CRON = '*/5 * * * *';

/** How many projects one tick serves, and how many lines one digest carries. */
export const DIGEST_PROJECT_LIMIT = 200;
export const DIGEST_ITEM_LIMIT = 50;

/**
 * How long a row planned `immediate` is left alone before a digest may carry it.
 *
 * The window this closes: the duty **records** the row, **calls** the provider and **then** marks
 * it delivered, so between the first and the third step the row is undelivered and
 * indistinguishable from one whose delivery failed. A digest claiming it in that gap posts the
 * notification a second time, and `delivered_as` ends up being whichever write lands last.
 *
 * Two minutes is derived from what one call can cost: `DEFAULT_RETRY_POLICY` is three attempts with
 * each backoff capped at `maxDelayMs` (30 s), so at most a minute of waiting per call plus the
 * call itself — and the immediate path makes up to **two** calls (`chats.taskThread`, then
 * `chats.message`, `duty.ts`), so the derivation is per call and the worst case is roughly twice it
 * plus any rate-limiter wait, which the residual below already covers. The cost of overshooting is bounded and one-directional — a row whose immediate
 * delivery *failed* inside the grace is carried by the **next** day's digest instead of today's,
 * which is the same treatment `before` already gives a row created while the tick is running.
 *
 * **Residual, stated rather than implied**: this narrows the window, it does not close it. A
 * delivery still in flight after two minutes (a provider holding the connection open) is claimable
 * again. Closing it completely needs a *lease* on the row — a `delivering_at` stamp written in the
 * same transaction as the record and cleared on failure — which is a column, a migration and a
 * third state for a row to be stuck in; it is not this work package's, and the cheaper mitigation
 * is that the duplicate is one digest line rather than a second message.
 */
export const DIGEST_IMMEDIATE_GRACE_MS = 120_000;

/** `at` minus `ms`, in the platform's wire format. The clock is the caller's. */
const instantBefore = (at: IsoDateTime, ms: number): IsoDateTime =>
  new Date(Date.parse(at) - ms).toISOString() as IsoDateTime;

/** A stored notification as one line of the digest. */
export const digestItemOf = (row: StoredNotification): DigestItem => ({
  ...(row.taskId === null ? {} : { task_id: row.taskId }),
  title: row.title,
  ...(row.url === null ? {} : { url: row.url }),
  state: row.notificationClass,
  ...(row.detail === null ? {} : { detail: row.detail }),
});

/** Groups a day's claimed rows by the mode their call must be made in (BD-021). */
const byMode = (
  rows: readonly StoredNotification[],
): ReadonlyMap<TaskMode, StoredNotification[]> => {
  const grouped = new Map<TaskMode, StoredNotification[]>();
  for (const row of rows) {
    const bucket = grouped.get(row.mode) ?? [];
    bucket.push(row);
    grouped.set(row.mode, bucket);
  }
  return grouped;
};

export type DigestOutcome = 'posted' | 'empty' | 'not_due' | 'disabled' | 'no_binding' | 'sent';

/**
 * One project's digest, for the instant `at`.
 *
 * Exported so that the tick and a future "send it now" command are the same code path, which is
 * what `slack/digest.ts` gave its `run()` for.
 */
export const runProjectDigest = async (
  options: NotifyOptions,
  input: { readonly projectId: Id; readonly at: IsoDateTime },
): Promise<DigestOutcome> => {
  const logger: Logger = options.logger ?? silentLogger;
  const { projectId, at } = input;
  const day = localDayOf(at, options.timezone);
  const settings = await options.settings.forProject(projectId);
  const digest = digestSettingsOf(settings.config);
  if (!digest.enabled) {
    /**
     * Nothing is ever *deferred* for a project with the digest off (`notificationDelivery` returns
     * `immediate` for every class), so a row here is one whose immediate delivery failed. It is
     * left undelivered and counted rather than posted: the project asked for no daily message, and
     * a failure that turned into one would be the platform overriding that. It is visible in the
     * table and in this line, which is what standing rule 18 asks of an absent case.
     */
    logger.debug({ project_id: projectId }, 'digest: the project has it switched off');
    return 'disabled';
  }
  if (localMinutesOf(at, options.timezone) < minutesOfTimeOfDay(digest.at)) {
    return 'not_due';
  }
  const alreadySent = await options.unitOfWork.transaction(async (scope) =>
    options.notifications.digestDelivered(scope.tx, { projectId, day }),
  );
  if (alreadySent) {
    return 'sent';
  }

  const integrations = await integrationsForProject(
    options.integrations,
    projectId,
    noRunScopedSecrets(),
  );
  if (integrations.communication === null) {
    logger.debug({ project_id: projectId }, 'digest: the project has no communication binding');
    return 'no_binding';
  }

  const claimed = await options.unitOfWork.transaction(async (scope) =>
    options.notifications.claimForDigest(scope.tx, {
      projectId,
      day,
      before: at,
      immediateBefore: instantBefore(at, DIGEST_IMMEDIATE_GRACE_MS),
      limit: DIGEST_ITEM_LIMIT,
    }),
  );
  if (claimed.length === 0) {
    return 'empty';
  }
  if (claimed.length === DIGEST_ITEM_LIMIT) {
    /**
     * The day had at least as many rows as one message carries. The rest keep `digest_day` null and
     * are claimed by the **next** day's digest, so nothing is lost — but a day that silently sheds
     * its remainder is exactly the kind of absence standing rule 18 asks to be named, and it is the
     * only branch here that was not already saying something out loud.
     */
    logger.info(
      { project_id: projectId, day, items: claimed.length, limit: DIGEST_ITEM_LIMIT },
      'digest: the day filled the item limit; the remainder is carried by the next digest',
    );
  }

  const chats = communicationWrites(integrations);
  for (const [mode, rows] of byMode(claimed)) {
    await chats.digest({ items: rows.map(digestItemOf), day }, { projectId, taskId: null, mode });
  }
  await options.unitOfWork.transaction(async (scope) =>
    options.notifications.markDigested(scope.tx, {
      ids: claimed.map((row) => row.id),
      at: options.clock.now() as IsoDateTime,
    }),
  );
  logger.info(
    { project_id: projectId, day, items: claimed.length },
    'digest: posted the day’s notifications',
  );
  return 'posted';
};

/** The tick: every project with something waiting, served in the tick that is due for it. */
export const digestTickHandler =
  (options: NotifyOptions): JobHandler =>
  async () => {
    const at = options.clock.now() as IsoDateTime;
    const projects = await options.unitOfWork.transaction(async (scope) =>
      options.notifications.projectsAwaitingDigest(scope.tx, {
        before: at,
        limit: DIGEST_PROJECT_LIMIT,
      }),
    );
    for (const projectId of projects) {
      await runProjectDigest(options, { projectId, at });
    }
  };

/**
 * Declares the queue, schedules the tick and starts the worker. Safe to call on every boot.
 *
 * `exclusive` because two overlapping ticks would both claim rows for the same day; the claim and
 * the idempotency key are the second and third lines of defence, not the first.
 */
export const startDigestRuntime = async (options: NotifyOptions): Promise<JobWorker> => {
  await options.jobs.defineQueue({
    name: JOB_QUEUES.notifyDigest,
    policy: 'exclusive',
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: true,
  });
  await options.jobs.scheduleCron({
    queue: JOB_QUEUES.notifyDigest,
    cron: DIGEST_TICK_CRON,
    timezone: options.timezone,
    key: 'tick',
  });
  return options.jobs.work({ queue: JOB_QUEUES.notifyDigest, handler: digestTickHandler(options) });
};
