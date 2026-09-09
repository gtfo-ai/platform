/**
 * The `Jobs` contract suite (technical/10: "`describe.each(providers)` against the in-memory fake
 * and each real adapter").
 *
 * One suite, two runners: `test/contract/jobs.contract.test.ts` runs it against the in-memory fake
 * on every `verify`, and `test/integration/jobs/pg-boss-jobs.integration.test.ts` runs the *same*
 * assertions against pg-boss on a real PostgreSQL 18. Anything a later work package may rely on —
 * a timer that never fires early, a burst that executes once — is asserted here, so the fake can
 * never drift into being kinder than production.
 *
 * The two implementations differ only in how time passes, which the harness abstracts:
 * the fake advances a virtual clock; pg-boss waits on the real one.
 */
import { randomUUID } from 'node:crypto';
import { coalescingSlotStart, type JobData, type JobsRuntime } from '@platform/application';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** What one implementation gives the suite. */
export interface JobsContractContext {
  readonly runtime: JobsRuntime;
  /** The implementation's own clock — virtual for the fake, `Date.now` for pg-boss. */
  readonly now: () => Date;
  /** Lets `milliseconds` of that clock pass, running whatever falls due. */
  readonly elapse: (milliseconds: number) => Promise<void>;
  /** Waits until `predicate` holds; fails the test with `description` if it never does. */
  readonly waitFor: (predicate: () => boolean, description: string) => Promise<void>;
  /** How late a timer may fire and still count as accurate on this implementation. */
  readonly timerToleranceMs: number;
  /** Poll interval the suite asks its workers for. */
  readonly pollingIntervalSeconds: number;
  readonly cleanup: () => Promise<void>;
}

export interface JobsContractHarness {
  readonly name: string;
  readonly create: () => Promise<JobsContractContext>;
}

/** A fresh queue name per test, so the suite needs no reset between cases. */
const uniqueQueue = (label: string): string => `test.${label}.${randomUUID().slice(0, 8)}`;

interface Execution {
  readonly at: Date;
  readonly data: JobData;
  readonly id: string;
}

export const runJobsContract = (harness: JobsContractHarness): void => {
  describe(`Jobs port — ${harness.name}`, () => {
    let context: JobsContractContext;

    beforeAll(async () => {
      context = await harness.create();
      await context.runtime.start();
    });

    afterAll(async () => {
      await context?.runtime.stop();
      await context?.cleanup();
    });

    /**
     * How long to wait for "and then nothing else happened".
     *
     * Three poll intervals rather than a round number of seconds: against pg-boss these are real
     * waits and this file is most of the integration tier's wall clock, while against the fake
     * they are virtual and free. Expressing them in polls keeps the negative assertions honest if
     * the harness ever changes its interval.
     *
     * **Current margin, for whoever tightens this next.** These waits were 2000–3000 ms — four to
     * six polls at the integration harness's 0.5 s — and are now 1500 ms, three polls. The
     * maintenance observation window in the integration file went 6 s to 3 s at a one-second
     * interval, so three background passes instead of six. Both are adequate but no longer
     * generous; going below three polls means a single missed poll turns a negative assertion red.
     *
     * The suite is deliberately *not* `describe.concurrent`: the fake runs on a single virtual
     * clock, so concurrent cases would interleave each other's `advance` calls and every timer
     * assertion would become meaningless.
     */
    const settle = (): Promise<void> =>
      context.elapse(Math.max(1_000, context.pollingIntervalSeconds * 3_000));

    /** Declares a queue, subscribes a recording handler and returns both. */
    const recordingQueue = async (
      label: string,
      options: {
        readonly policy?: 'standard' | 'short' | 'singleton' | 'stately' | 'exclusive';
        readonly retryLimit?: number;
        readonly deadLetterQueue?: string;
        readonly fail?: boolean;
      } = {},
    ): Promise<{ queue: string; executions: Execution[]; stop: () => Promise<void> }> => {
      const queue = uniqueQueue(label);
      const executions: Execution[] = [];
      await context.runtime.jobs.defineQueue({
        name: queue,
        ...(options.policy === undefined ? {} : { policy: options.policy }),
        ...(options.retryLimit === undefined ? {} : { retryLimit: options.retryLimit }),
        ...(options.deadLetterQueue === undefined
          ? {}
          : { deadLetterQueue: options.deadLetterQueue }),
      });
      const worker = await context.runtime.jobs.work({
        queue,
        pollingIntervalSeconds: context.pollingIntervalSeconds,
        handler: async (job) => {
          executions.push({ at: context.now(), data: job.data, id: job.id });
          if (options.fail === true) {
            throw new Error('deliberate handler failure');
          }
        },
      });
      return { queue, executions, stop: () => worker.stop() };
    };

    it('runs an enqueued job exactly once, with its payload', async () => {
      const { queue, executions } = await recordingQueue('basic');

      const result = await context.runtime.jobs.enqueue({ queue, data: { ticket_key: 'PROJ-1' } });
      expect(result.status).toBe('enqueued');

      await context.waitFor(() => executions.length > 0, 'the job to run');
      await settle();

      expect(executions).toHaveLength(1);
      expect(executions[0]?.data).toEqual({ ticket_key: 'PROJ-1' });
    });

    it('declares a queue idempotently', async () => {
      const queue = uniqueQueue('idempotent');
      await context.runtime.jobs.defineQueue({ name: queue });
      await expect(context.runtime.jobs.defineQueue({ name: queue })).resolves.toBeUndefined();
    });

    it('refuses to enqueue onto a queue that was never declared', async () => {
      await expect(
        context.runtime.jobs.enqueue({ queue: uniqueQueue('missing') }),
      ).rejects.toThrow();
    });

    it('rejects a malformed queue name before it reaches the database', async () => {
      await expect(
        context.runtime.jobs.defineQueue({ name: "robert'); drop table events;--" }),
      ).rejects.toThrow(/invalid queue name/);
    });

    // ── Timers ───────────────────────────────────────────────────────────────
    //
    // Every assertion below is on a *recorded execution time*, never on "nothing has happened
    // yet by now". A stalled runner (a loaded CI box, a long GC pause) makes the second kind fail
    // while the implementation is perfectly correct, and the first kind catches exactly the same
    // defect: a job that ignored its timer records an `at` before its deadline either way.
    it('never runs a timer before its startAfter, and runs it soon after', async () => {
      const { queue, executions } = await recordingQueue('timer');
      const startAfter = new Date(context.now().getTime() + 1_500);

      await context.runtime.jobs.enqueue({ queue, data: { n: 1 }, startAfter });

      await context.elapse(1_500);
      await context.waitFor(() => executions.length > 0, 'the timer to fire');

      const ranAt = executions[0]?.at.getTime() ?? 0;
      // Never early: this is the assertion a question deadline depends on.
      expect(ranAt).toBeGreaterThanOrEqual(startAfter.getTime());
      expect(ranAt - startAfter.getTime()).toBeLessThanOrEqual(context.timerToleranceMs);
      expect(executions).toHaveLength(1);
    });

    it('holds each timer until its own deadline', async () => {
      const { queue, executions } = await recordingQueue('timer-independent');
      const base = context.now().getTime();
      const deadlines = { late: new Date(base + 3_000), early: new Date(base + 800) };

      // Enqueued late-first on purpose: due jobs are fetched in creation order, so nothing but the
      // deadlines themselves can keep "late" from running first.
      await context.runtime.jobs.enqueue({
        queue,
        data: { label: 'late' },
        startAfter: deadlines.late,
      });
      await context.runtime.jobs.enqueue({
        queue,
        data: { label: 'early' },
        startAfter: deadlines.early,
      });

      await context.elapse(3_000);
      await context.waitFor(() => executions.length === 2, 'both timers to fire');

      for (const execution of executions) {
        const label = execution.data.label as 'early' | 'late';
        expect(execution.at.getTime()).toBeGreaterThanOrEqual(deadlines[label].getTime());
      }
      expect(executions.map((execution) => execution.data.label).sort()).toEqual(['early', 'late']);
    });

    it('treats a startAfter in the past as due now', async () => {
      const { queue, executions } = await recordingQueue('timer-past');
      await context.runtime.jobs.enqueue({
        queue,
        startAfter: new Date(context.now().getTime() - 60_000),
      });
      await context.waitFor(() => executions.length > 0, 'the overdue timer to fire');
      expect(executions).toHaveLength(1);
    });

    // ── Coalescing ───────────────────────────────────────────────────────────
    //
    // Coalescing buckets on a fixed grid of Unix time, so a burst that straddles a slot boundary
    // legitimately produces two jobs. That is the design, not a defect — but it makes any test
    // that asserts exact statuses a coin flip whose odds get much worse on a slow runner. Every
    // case below therefore runs its whole burst inside `inOneSlot`, which throws the attempt away
    // and retries on a fresh queue when the clock crossed a boundary mid-burst.
    const inOneSlot = async <T>(windowSeconds: number, body: () => Promise<T>): Promise<T> => {
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const before = coalescingSlotStart(context.now(), windowSeconds);
        const result = await body();
        if (coalescingSlotStart(context.now(), windowSeconds) === before) {
          return result;
        }
      }
      throw new Error(
        `could not complete a ${windowSeconds}s coalescing burst inside one slot after 8 attempts`,
      );
    };

    it('coalesces a burst of enqueues on one key into exactly one execution', async () => {
      const burst = 12;

      const { executions, results } = await inOneSlot(120, async () => {
        const recorded = await recordingQueue('coalesce');
        const sent = await Promise.all(
          Array.from({ length: burst }, () =>
            context.runtime.jobs.enqueue({
              queue: recorded.queue,
              data: { note: 'mr comment' },
              coalesce: { key: 'mr:42', windowSeconds: 120 },
            }),
          ),
        );
        return { executions: recorded.executions, results: sent };
      });

      expect(results.filter((result) => result.status === 'enqueued')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'coalesced')).toHaveLength(burst - 1);

      await context.waitFor(() => executions.length > 0, 'the coalesced job to run');
      await settle();
      expect(executions).toHaveLength(1);
    });

    it('keeps the slot taken after the coalesced job has run', async () => {
      const coalesce = { key: 'mr:43', windowSeconds: 600 } as const;

      const { executions, second } = await inOneSlot(coalesce.windowSeconds, async () => {
        const recorded = await recordingQueue('coalesce-after');
        await context.runtime.jobs.enqueue({ queue: recorded.queue, coalesce });
        await context.waitFor(() => recorded.executions.length > 0, 'the first job to run');
        // Same window, after the job completed: still coalesced, so a burst spanning the whole
        // window really does produce one execution rather than one per poll.
        return {
          executions: recorded.executions,
          second: await context.runtime.jobs.enqueue({ queue: recorded.queue, coalesce }),
        };
      });

      expect(second.status).toBe('coalesced');
      await settle();
      expect(executions).toHaveLength(1);
    });

    it('does not coalesce different keys', async () => {
      const { queue, executions } = await recordingQueue('coalesce-keys');

      const first = await context.runtime.jobs.enqueue({
        queue,
        coalesce: { key: 'mr:1', windowSeconds: 600 },
      });
      const second = await context.runtime.jobs.enqueue({
        queue,
        coalesce: { key: 'mr:2', windowSeconds: 600 },
      });

      expect(first.status).toBe('enqueued');
      expect(second.status).toBe('enqueued');

      await context.waitFor(() => executions.length === 2, 'both keys to run');
      expect(executions).toHaveLength(2);
    });

    it('throttle_with_trailing adds exactly one trailing job, on the leading edge', async () => {
      const coalesce = { key: 'mr:99', windowSeconds: 2, mode: 'throttle_with_trailing' } as const;

      const { executions, sent } = await inOneSlot(coalesce.windowSeconds, async () => {
        const recorded = await recordingQueue('trailing');
        return {
          executions: recorded.executions,
          sent: [
            await context.runtime.jobs.enqueue({ queue: recorded.queue, coalesce }),
            await context.runtime.jobs.enqueue({ queue: recorded.queue, coalesce }),
            await context.runtime.jobs.enqueue({ queue: recorded.queue, coalesce }),
          ],
        };
      });

      // First send takes the current slot; the second lands in the next one; the third finds both
      // taken. Three sends therefore mean two executions, never three.
      expect(sent.map((result) => result.status)).toEqual(['enqueued', 'enqueued', 'coalesced']);

      // The trailing job lands at most a window plus a second out — pg-boss's own margin.
      await context.elapse((coalesce.windowSeconds + 1) * 1_000);
      await context.waitFor(() => executions.length === 2, 'the leading and trailing jobs to run');
      expect(executions).toHaveLength(2);
      // That the *leading* job is not delayed — the reason this is not a debounce — is asserted
      // structurally where each implementation stores it: `pgboss.job.start_after` in the
      // integration suite, `snapshot()` in the fake's own unit tests. Asserting it here from a
      // recorded execution time would only measure how fast the runner happened to be.
    });

    it('rejects a job that sets both a singleton key and coalescing', async () => {
      const queue = uniqueQueue('conflict');
      await context.runtime.jobs.defineQueue({ name: queue });
      await expect(
        context.runtime.jobs.enqueue({
          queue,
          singletonKey: 'task:1',
          coalesce: { key: 'task:1', windowSeconds: 60 },
        }),
      ).rejects.toThrow(/singletonKey and coalesce/);
    });

    it('rejects a job that sets both a timer and coalescing', async () => {
      // The slot comes from the clock at enqueue and the trailing job overwrites `startAfter`, so
      // the pair would mean different things in the fake and in pg-boss. Refused in the port,
      // which is the only place both adapters share.
      const queue = uniqueQueue('timer-coalesce');
      await context.runtime.jobs.defineQueue({ name: queue });
      await expect(
        context.runtime.jobs.enqueue({
          queue,
          startAfter: new Date(context.now().getTime() + 120_000),
          coalesce: { key: 'mr:1', windowSeconds: 120 },
        }),
      ).rejects.toThrow(/startAfter and coalesce/);
    });

    it('builds a delayed batch window from a queue policy instead', async () => {
      // The pattern `JOB_QUEUES.mrCommentDebounce` documents and WP-15 must use: one queued job per
      // key, its timer set on the first event of the burst, everything else coalesced by the
      // policy. Unlike `coalesce` this really does wait before the first execution.
      const queue = uniqueQueue('batch-window');
      const executions: Execution[] = [];
      await context.runtime.jobs.defineQueue({ name: queue, policy: 'stately' });
      await context.runtime.jobs.work({
        queue,
        pollingIntervalSeconds: context.pollingIntervalSeconds,
        handler: async (job) => {
          executions.push({ at: context.now(), data: job.data, id: job.id });
        },
      });

      const windowEnd = new Date(context.now().getTime() + 1_500);
      const sent = await Promise.all(
        Array.from({ length: 5 }, () =>
          context.runtime.jobs.enqueue({
            queue,
            singletonKey: 'mr:7',
            startAfter: windowEnd,
          }),
        ),
      );

      expect(sent.filter((result) => result.status === 'enqueued')).toHaveLength(1);

      await context.elapse(1_500);
      await context.waitFor(() => executions.length > 0, 'the batch window to close');
      expect(executions).toHaveLength(1);
      expect(executions[0]?.at.getTime()).toBeGreaterThanOrEqual(windowEnd.getTime());
    });

    // ── Singleton queue policy ───────────────────────────────────────────────
    it('a stately queue keeps at most one job queued per key', async () => {
      const queue = uniqueQueue('stately');
      await context.runtime.jobs.defineQueue({ name: queue, policy: 'stately' });

      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          context.runtime.jobs.enqueue({ queue, singletonKey: 'task:7' }),
        ),
      );

      expect(results.filter((result) => result.status === 'enqueued')).toHaveLength(1);
      expect(results.filter((result) => result.status === 'coalesced')).toHaveLength(4);

      // A different key is unaffected.
      const other = await context.runtime.jobs.enqueue({ queue, singletonKey: 'task:8' });
      expect(other.status).toBe('enqueued');
    });

    // ── Cron ─────────────────────────────────────────────────────────────────
    it('registers, lists and removes a cron schedule with an explicit time zone', async () => {
      const queue = uniqueQueue('cron-crud');
      await context.runtime.jobs.defineQueue({ name: queue });

      await context.runtime.jobs.scheduleCron({
        queue,
        cron: '20 3 * * *',
        timezone: 'Europe/Prague',
      });

      const listed = await context.runtime.jobs.listCronSchedules(queue);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        queue,
        cron: '20 3 * * *',
        timezone: 'Europe/Prague',
        key: '',
      });

      await context.runtime.jobs.unscheduleCron(queue);
      expect(await context.runtime.jobs.listCronSchedules(queue)).toHaveLength(0);
    });

    it('rejects an unusable cron expression or time zone', async () => {
      const queue = uniqueQueue('cron-bad');
      await context.runtime.jobs.defineQueue({ name: queue });

      await expect(
        context.runtime.jobs.scheduleCron({ queue, cron: 'not a cron', timezone: 'UTC' }),
      ).rejects.toThrow();
      await expect(
        context.runtime.jobs.scheduleCron({
          queue,
          cron: '* * * * *',
          timezone: 'Europe/New_Yrok',
        }),
      ).rejects.toThrow();
    });

    it('fires a cron schedule', async () => {
      const { queue, executions } = await recordingQueue('cron-fire');
      await context.runtime.jobs.scheduleCron({
        queue,
        cron: '* * * * *',
        timezone: 'UTC',
        data: { source: 'cron' },
      });

      await context.waitFor(() => executions.length > 0, 'the cron schedule to fire');
      expect(executions[0]?.data).toEqual({ source: 'cron' });

      await context.runtime.jobs.unscheduleCron(queue);
    });

    // ── Failure handling ─────────────────────────────────────────────────────
    it('retries a failing job and finally routes it to the dead letter queue', async () => {
      const dead = await recordingQueue('dead');
      const failing = await recordingQueue('failing', {
        retryLimit: 1,
        deadLetterQueue: dead.queue,
        fail: true,
      });

      await context.runtime.jobs.enqueue({ queue: failing.queue, data: { attempt: 'first' } });

      await context.waitFor(
        () => failing.executions.length >= 2,
        'the failing job to be retried once',
      );
      await context.waitFor(() => dead.executions.length > 0, 'the dead letter to arrive');
      expect(dead.executions[0]?.data).toEqual({ attempt: 'first' });
    });

    it('stops delivering to a stopped worker', async () => {
      const { queue, executions, stop } = await recordingQueue('stop');
      await stop();

      await context.runtime.jobs.enqueue({ queue });
      await settle();

      expect(executions).toHaveLength(0);
    });
  });
};
