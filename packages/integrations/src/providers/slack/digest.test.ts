/**
 * The digest job — the mechanism, driven on an injected clock and a stub `Jobs`.
 *
 * WP-32 owns the policy. What is asserted here is the machinery it will inherit: the cron carries
 * its timezone, the outbound call goes through `IntegrationActionExecutor`, a shadow project posts
 * nothing, a second run on the same day replays, and an empty digest is not a message.
 */
import {
  type CronScheduleDefinition,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createMemoryIdempotencyStore,
  createVirtualTimer,
  type DigestItem,
  type JobHandler,
  type JobQueueDefinition,
  type Jobs,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFakeCommunication, type FakeCommunication } from '../../communication/fake.js';
import { createSlackDigestJob, SLACK_DIGEST_QUEUE } from './digest.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a8';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000b8';
const CHANNEL = '#agentic';

const ITEMS: readonly DigestItem[] = [
  { task_id: null, title: 'TASK-1', url: null, state: 'ready_for_merge', detail: null },
];

interface StubJobs extends Jobs {
  readonly queues: JobQueueDefinition[];
  readonly crons: CronScheduleDefinition[];
  readonly handlers: Map<string, JobHandler>;
}

const stubJobs = (): StubJobs => {
  const queues: JobQueueDefinition[] = [];
  const crons: CronScheduleDefinition[] = [];
  const handlers = new Map<string, JobHandler>();
  return {
    queues,
    crons,
    handlers,
    defineQueue: async (definition) => {
      queues.push(definition);
    },
    enqueue: async () => ({ status: 'enqueued', jobId: 'job_1' }),
    scheduleCron: async (definition) => {
      crons.push(definition);
    },
    unscheduleCron: async () => {},
    listCronSchedules: async () => [],
    work: async (request) => {
      handlers.set(request.queue, request.handler as JobHandler);
      return { queue: request.queue, stop: async () => {} };
    },
  };
};

let auditLog: MemoryIntegrationAuditLog;
let port: FakeCommunication;

beforeEach(() => {
  auditLog = createMemoryAuditLog();
  port = createFakeCommunication({ integrationId: INTEGRATION_ID, channels: [CHANNEL] });
});

const build = (options: {
  at: string;
  mode?: 'normal' | 'shadow';
  items?: readonly DigestItem[];
  jobs?: StubJobs;
  idempotency?: ReturnType<typeof createMemoryIdempotencyStore>;
  timezone?: string;
}) => {
  const clock = fixedClock(options.at);
  const jobs = options.jobs ?? stubJobs();
  const collected: string[] = [];
  const job = createSlackDigestJob({
    jobs,
    executor: createIntegrationActionExecutor({
      auditLog,
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock,
      idempotencyStore: options.idempotency,
    }),
    port,
    channel: CHANNEL,
    cron: '0 9 * * 1-5',
    timezone: options.timezone ?? 'Europe/Prague',
    clock,
    mode: options.mode ?? 'normal',
    projectId: PROJECT_ID,
    collect: async (at) => {
      collected.push(at);
      return options.items ?? ITEMS;
    },
  });
  return { job, jobs, collected };
};

describe('createSlackDigestJob', () => {
  it('declares its queue, schedules the cron in a named zone and subscribes a worker', async () => {
    const { job, jobs } = build({ at: '2026-06-01T09:00:00.000Z' });
    const worker = await job.register();

    expect(jobs.queues[0]).toMatchObject({ name: SLACK_DIGEST_QUEUE, policy: 'exclusive' });
    // Q38: a schedule that means 09:00 has to say whose 09:00.
    expect(jobs.crons[0]).toMatchObject({
      queue: SLACK_DIGEST_QUEUE,
      cron: '0 9 * * 1-5',
      timezone: 'Europe/Prague',
    });
    expect(worker.queue).toBe(SLACK_DIGEST_QUEUE);
    expect(jobs.handlers.has(SLACK_DIGEST_QUEUE)).toBe(true);
  });

  it('posts the digest through the executor and records the row', async () => {
    const { job, collected } = build({ at: '2026-06-01T09:00:00.000Z' });
    expect(await job.run()).toBe('posted');

    expect(collected, 'the collector was asked for the instant the job ran').toEqual([
      '2026-06-01T09:00:00.000Z',
    ]);
    expect(port.messagesIn(CHANNEL)).toHaveLength(1);
    expect(auditLog.entries).toHaveLength(1);
    expect(auditLog.entries[0]).toMatchObject({
      action: 'post_digest',
      status: 'ok',
      projectId: PROJECT_ID,
    });
  });

  it('posts nothing when there is nothing to say', async () => {
    const { job } = build({ at: '2026-06-01T09:00:00.000Z', items: [] });
    expect(await job.run()).toBe('empty');
    expect(port.messagesIn(CHANNEL)).toEqual([]);
    expect(auditLog.entries, 'no provider call, so no row').toEqual([]);
  });

  it('records a shadow project as would_have and posts nothing', async () => {
    const { job } = build({ at: '2026-06-01T09:00:00.000Z', mode: 'shadow' });
    expect(await job.run()).toBe('posted');
    expect(port.messagesIn(CHANNEL), 'shadow mode never reaches the provider').toEqual([]);
    expect(auditLog.entries[0]).toMatchObject({ action: 'post_digest', status: 'would_have' });
  });

  it('replays a second run on the same day and posts again the next one', async () => {
    const idempotency = createMemoryIdempotencyStore();
    const monday = build({ at: '2026-06-01T09:00:00.000Z', idempotency });
    expect(await monday.job.run()).toBe('posted');
    const again = build({ at: '2026-06-01T17:30:00.000Z', idempotency });
    expect(await again.job.run()).toBe('posted');

    expect(port.messagesIn(CHANNEL), 'one digest per channel per day').toHaveLength(1);
    expect(auditLog.entries.map((entry) => entry.status)).toEqual(['ok', 'replayed']);

    const tuesday = build({ at: '2026-06-02T09:00:00.000Z', idempotency });
    expect(await tuesday.job.run()).toBe('posted');
    expect(port.messagesIn(CHANNEL), 'a new day is a new digest').toHaveLength(2);
  });

  /**
   * The idempotency key is cut on a *day*, and the schedule fires in `digest_timezone`. Cutting the
   * day in UTC made the second of two consecutive fires look like a replay whenever both landed in
   * the same UTC date — which is what a DST transition does — so a day's digest was silently never
   * posted. Found at WP-10 review round 1.
   *
   * Each case below is a real pair of fires of one cron expression, given as the UTC instants the
   * clock reports. The assertion is the *count of messages*, because that is the observable a
   * skipped day changes.
   */
  describe('the day is cut in the schedule zone, not in UTC', () => {
    const twoFires = async (timezone: string, first: string, second: string): Promise<number> => {
      const idempotency = createMemoryIdempotencyStore();
      expect(await build({ at: first, timezone, idempotency }).job.run()).toBe('posted');
      expect(await build({ at: second, timezone, idempotency }).job.run()).toBe('posted');
      return port.messagesIn(CHANNEL).length;
    };

    it('posts on both sides of a southern-hemisphere DST start at UTC+13', async () => {
      // `0 12 * * *` in Auckland: 2026-09-26 12:00 NZST and 2026-09-27 12:00 NZDT. Both are UTC
      // 2026-09-26, and the zone moves to UTC+13 between them.
      expect(
        await twoFires('Pacific/Auckland', '2026-09-26T00:00:00.000Z', '2026-09-26T23:00:00.000Z'),
        'the second local day is a different digest, not a replay',
      ).toBe(2);
    });

    it('posts on both sides of a northern-hemisphere DST start and end', async () => {
      // `30 19 * * *` in New York, spring forward: local 2026-03-07 and 2026-03-08, both UTC 03-08.
      expect(
        await twoFires('America/New_York', '2026-03-08T00:30:00.000Z', '2026-03-08T23:30:00.000Z'),
      ).toBe(2);
      // …and fall back: local 2026-10-31 and 2026-11-01, both UTC 11-01.
      expect(
        await twoFires('America/New_York', '2026-11-01T00:30:00.000Z', '2026-11-01T23:30:00.000Z'),
      ).toBe(4);
    });

    it('still replays a second run inside the same local day, at UTC+13', async () => {
      // The control for the three cases above (standing rule 10): if the key were simply unique
      // per run, they would pass while the idempotency they are about had stopped working.
      // 2026-12-26 00:30 and 23:30 NZDT are one local day and *two* UTC days.
      const idempotency = createMemoryIdempotencyStore();
      const timezone = 'Pacific/Auckland';
      expect(await build({ at: '2026-12-25T11:30:00.000Z', timezone, idempotency }).job.run()).toBe(
        'posted',
      );
      expect(await build({ at: '2026-12-26T10:30:00.000Z', timezone, idempotency }).job.run()).toBe(
        'posted',
      );
      expect(port.messagesIn(CHANNEL), 'one local day is one digest').toHaveLength(1);
      expect(auditLog.entries.map((entry) => entry.status)).toEqual(['ok', 'replayed']);
    });

    it('refuses an IANA zone this runtime does not know, at wiring time', () => {
      // Inside a job it would surface as two retries and a dead job; here an operator sees it.
      expect(() => build({ at: '2026-06-01T09:00:00.000Z', timezone: 'Not/AZone' })).toThrow(
        RangeError,
      );
    });
  });

  it('runs the same code path from the queue handler as from a manual send', async () => {
    const { job, jobs } = build({ at: '2026-06-01T09:00:00.000Z' });
    await job.register();
    const handler = jobs.handlers.get(SLACK_DIGEST_QUEUE);
    await handler?.({
      id: 'job_1',
      queue: SLACK_DIGEST_QUEUE,
      data: {},
      signal: AbortSignal.abort(),
    });
    expect(port.messagesIn(CHANNEL)).toHaveLength(1);
  });
});
