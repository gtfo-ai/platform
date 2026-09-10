/**
 * The digest job — the *mechanism*, not the policy.
 *
 * WP-32 owns the digest and quiet hours: what goes in a digest, whether it is sent at all, and
 * what happens inside an organisation's quiet window are product decisions with their own work
 * package. This module is what that decision will run on: a queue, a cron schedule with an
 * explicit timezone, a handler that asks a caller-supplied collector for the day's lines, and one
 * outbound call through `IntegrationActionExecutor`.
 *
 * Four properties are worth stating, because each is a mistake this shape avoids:
 *
 *  1. **The schedule carries its own timezone.** `CronScheduleDefinition.timezone` is required by
 *     the Jobs port — "a schedule that means 09:00 has to say whose 09:00, and inheriting the
 *     host's zone is how a container migration silently moves it" — and this module never defaults
 *     it to the host (Q38) — and `dayOf` reads the *same* zone, because a schedule that fires in
 *     `Pacific/Auckland` and an idempotency key cut in UTC disagree twice a year.
 *  2. **The clock is injected.** The idempotency key is derived from the *day* the handler runs,
 *     so the job needs "now"; reading a wall clock would make the test that proves the second run
 *     of a day posts nothing a hardware assertion (standing rule 2).
 *  3. **It goes through the executor.** A digest is a message in a channel: a mutation. So it
 *     carries the task's `mode`, a `shadowResult` and a `describeResult`, which means a shadow
 *     project's digest is recorded as `would_have` and never posted, and the idempotency key means
 *     a retried job replays instead of posting twice.
 *  4. **An empty digest is not posted.** "Nothing happened today" as a daily message trains people
 *     to ignore the channel. The handler reports `empty` and writes no row.
 */
import {
  type CommunicationPort,
  type DigestItem,
  type IntegrationActionExecutor,
  type JobHandler,
  type Jobs,
  type JobWorker,
  type Logger,
  type MessageRef,
  silentLogger,
} from '@platform/application';
import type { Id, JsonObject, TaskMode } from '@platform/contracts';
import type { Clock } from '@platform/domain';

/** TD-004 enumerates the queue names it knows; the digest is WP-32's, and this is its mechanism. */
export const SLACK_DIGEST_QUEUE = 'digest.slack';

export interface SlackDigestOptions {
  readonly jobs: Jobs;
  readonly executor: IntegrationActionExecutor;
  readonly port: CommunicationPort;
  /** Where the digest is posted. */
  readonly channel: string;
  /** Five cron fields, read in `timezone`. WP-32 decides them; this module only runs them. */
  readonly cron: string;
  /** IANA zone. Required, never inherited from the host. */
  readonly timezone: string;
  readonly clock: Clock;
  /** `tasks.mode`. A shadow project's digest is recorded and not sent. */
  readonly mode: TaskMode;
  readonly projectId?: Id | null;
  /**
   * The day's lines. WP-32's policy — quiet hours, what counts as digest-worthy — lives here, and
   * an empty result is a legitimate answer that this module honours by posting nothing.
   */
  collect(at: string): Promise<readonly DigestItem[]>;
  readonly logger?: Logger;
}

export type DigestOutcome = 'posted' | 'empty';

export interface SlackDigestJob {
  /** Declares the queue, schedules the cron and starts the worker. Safe to call on every boot. */
  register(): Promise<JobWorker>;
  /** Runs one digest now. The cron handler and a manual "send it now" are the same code path. */
  run(): Promise<DigestOutcome>;
}

/**
 * The day a run belongs to, **in the schedule's own zone** — the unit the idempotency key is one of.
 *
 * Found at WP-10 review round 1. Slicing the UTC instant silently skipped a day whenever two
 * consecutive fires landed in the same UTC date, which is exactly what a DST transition does:
 * `0 12 * * *` in `Pacific/Auckland` fires at `2026-09-26T00:00Z` (NZST) and `2026-09-26T23:00Z`
 * (NZDT), both UTC `2026-09-26`, so the second day's digest was treated as a replay and never
 * posted. It is not a southern-hemisphere quirk either: `30 19 * * *` in `America/New_York` fires
 * at `2026-03-08T00:30Z` and `2026-03-08T23:30Z` across spring-forward, and again at
 * `2026-11-01T00:30Z` / `2026-11-01T23:30Z` across fall-back.
 *
 * `en-CA` is the locale whose short date is already `YYYY-MM-DD`, so no reassembly is needed.
 */
const dayFormatter = (timeZone: string): Intl.DateTimeFormat =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

export const createSlackDigestJob = (options: SlackDigestOptions): SlackDigestJob => {
  const logger = options.logger ?? silentLogger;
  // Built once, at wiring time: an IANA zone this runtime does not know throws `RangeError` here,
  // where an operator sees it, rather than inside a job that then retries twice and gives up.
  const formatDay = dayFormatter(options.timezone);
  const dayOf = (at: string): string => formatDay.format(new Date(at));

  const run = async (): Promise<DigestOutcome> => {
    const at = options.clock.now();
    const items = await options.collect(at);
    if (items.length === 0) {
      logger.debug({ provider: 'slack', channel: options.channel }, 'digest is empty; not posted');
      return 'empty';
    }
    await options.executor.execute<MessageRef>({
      integration: options.port.ref,
      action: 'post_digest',
      mutating: true,
      mode: options.mode,
      payload: { channel: options.channel, item_count: items.length, day: dayOf(at) },
      projectId: options.projectId ?? null,
      taskId: null,
      // One digest per channel per day, whatever retries the queue performs.
      idempotency: {
        key: `slack:digest:${options.channel}:${dayOf(at)}`,
        encode: (result) => result as unknown as JsonObject,
        decode: (stored) => stored as unknown as MessageRef,
      },
      shadowResult: () => ({
        provider: options.port.ref.provider,
        channel: options.channel,
        message_id: 'shadow',
        thread_id: null,
        url: null,
      }),
      describeResult: (result) => ({ channel: result.channel, message_id: result.message_id }),
      perform: async () => options.port.postDigest(options.channel, items),
    });
    return 'posted';
  };

  const handler: JobHandler = async () => {
    await run();
  };

  return {
    run,
    register: async () => {
      await options.jobs.defineQueue({
        name: SLACK_DIGEST_QUEUE,
        // One digest at a time per binding: a cron tick that overlaps a slow run would otherwise
        // post twice, and the idempotency key is the second line of defence, not the first.
        policy: 'exclusive',
        retryLimit: 2,
        retryDelaySeconds: 60,
        retryBackoff: true,
      });
      await options.jobs.scheduleCron({
        queue: SLACK_DIGEST_QUEUE,
        cron: options.cron,
        timezone: options.timezone,
        key: options.channel,
      });
      return options.jobs.work({ queue: SLACK_DIGEST_QUEUE, handler });
    },
  };
};
