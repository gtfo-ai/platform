/**
 * The fake's *own* surface — the virtual clock and the inspection helpers a later work package
 * will use. Its behaviour as a `Jobs` implementation is covered by the shared contract suite in
 * `test/contract/jobs.contract.test.ts`, which runs the same assertions against pg-boss.
 */
import { coalescingSlotStart, JobsValidationError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createInMemoryJobs, IN_MEMORY_JOBS_EPOCH } from './in-memory-jobs.js';

describe('the virtual clock', () => {
  it('starts at a fixed instant so a test never depends on today', async () => {
    expect(createInMemoryJobs().now()).toEqual(IN_MEMORY_JOBS_EPOCH);
    const custom = new Date('2030-01-02T03:04:05Z');
    expect(createInMemoryJobs({ startTime: custom }).now()).toEqual(custom);
  });

  it('moves only when asked', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await runtime.advance(90_000);
    expect(runtime.now().getTime()).toBe(IN_MEMORY_JOBS_EPOCH.getTime() + 90_000);
  });

  it('rejects a negative or non-finite step', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await expect(runtime.advance(-1)).rejects.toThrow(/non-negative/);
    await expect(runtime.advance(Number.POSITIVE_INFINITY)).rejects.toThrow(/non-negative/);
  });

  it('refuses to run handlers before start() or after stop()', async () => {
    const runtime = createInMemoryJobs();
    await expect(runtime.drain()).rejects.toThrow(/start\(\)/);
    await expect(runtime.advance(1)).rejects.toThrow(/start\(\)/);

    await runtime.start();
    await expect(runtime.drain()).resolves.toBeUndefined();

    await runtime.stop();
    await expect(runtime.drain()).rejects.toThrow(/start\(\)/);
  });
});

describe('inspection', () => {
  it('reports every job with its state and deadline', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await runtime.jobs.defineQueue({ name: 'dispatch' });

    const startAfter = new Date(IN_MEMORY_JOBS_EPOCH.getTime() + 60_000);
    await runtime.jobs.enqueue({ queue: 'dispatch', data: { event_id: 'e1' }, startAfter });

    expect(runtime.snapshot()).toEqual([
      {
        id: 'job_00000001',
        queue: 'dispatch',
        state: 'created',
        startAfter,
        data: { event_id: 'e1' },
      },
    ]);

    const ran: string[] = [];
    await runtime.jobs.work({
      queue: 'dispatch',
      handler: async (job) => {
        ran.push(job.id);
      },
    });
    await runtime.advance(60_000);

    expect(ran).toEqual(['job_00000001']);
    expect(runtime.snapshot()[0]?.state).toBe('completed');
  });
});

describe('coalescing is leading-edge', () => {
  it('does not delay the leading job, and puts the trailing one on the next slot boundary', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await runtime.jobs.defineQueue({ name: 'mr.comment.debounce' });
    const coalesce = { key: 'mr:1', windowSeconds: 120, mode: 'throttle_with_trailing' } as const;

    await runtime.jobs.enqueue({ queue: 'mr.comment.debounce', coalesce });
    await runtime.jobs.enqueue({ queue: 'mr.comment.debounce', coalesce });

    const [leading, trailing] = runtime.snapshot();
    // The whole point of the review finding: this is a throttle, not a debounce. The first job is
    // runnable immediately, so it can never implement technical/02's "batch for two minutes, then
    // emit one task.stage.returned".
    expect(leading?.startAfter).toEqual(runtime.now());

    // The trailing job lands where pg-boss's `getDebounceStartAfter` puts it: at or after the next
    // slot boundary, never before it. Being early here would make the fake kinder than production.
    const boundaryMs =
      (coalescingSlotStart(runtime.now(), coalesce.windowSeconds) + coalesce.windowSeconds) * 1000;
    const trailingMs = trailing?.startAfter.getTime() ?? 0;
    expect(trailingMs).toBeGreaterThanOrEqual(boundaryMs);
    // …and by pg-boss's own margin: the whole seconds left in the slot, plus one because the
    // window is longer than a second. Never more than that.
    expect(trailingMs).toBeLessThanOrEqual(boundaryMs + 2_000);
  });

  it('never schedules the trailing job earlier than pg-boss would, at any offset in the slot', async () => {
    // pg-boss counts *whole* seconds elapsed in the slot and adds one for a window longer than a
    // second, so its answer is always at or after the boundary. Sweeping the slot catches a
    // rounding change that would only bite at particular sub-second offsets.
    for (const windowSeconds of [1, 2, 5, 120]) {
      for (const offsetMs of [0, 1, 499, 500, 999, 1_000, 1_500]) {
        const slotMs = windowSeconds * 1_000;
        const startTime = new Date(
          Math.floor(IN_MEMORY_JOBS_EPOCH.getTime() / slotMs) * slotMs + offsetMs,
        );
        const runtime = createInMemoryJobs({ startTime });
        await runtime.start();
        await runtime.jobs.defineQueue({ name: 'sweep' });
        const coalesce = { key: 'k', windowSeconds, mode: 'throttle_with_trailing' } as const;
        await runtime.jobs.enqueue({ queue: 'sweep', coalesce });
        await runtime.jobs.enqueue({ queue: 'sweep', coalesce });

        const boundaryMs =
          (coalescingSlotStart(runtime.now(), windowSeconds) + windowSeconds) * 1_000;
        expect(runtime.snapshot()[1]?.startAfter.getTime()).toBeGreaterThanOrEqual(boundaryMs);
      }
    }
  });

  it('buckets on the clock at enqueue, so a later burst lands in a later slot', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await runtime.jobs.defineQueue({ name: 'coalesce' });
    const coalesce = { key: 'mr:1', windowSeconds: 60 } as const;

    expect((await runtime.jobs.enqueue({ queue: 'coalesce', coalesce })).status).toBe('enqueued');
    expect((await runtime.jobs.enqueue({ queue: 'coalesce', coalesce })).status).toBe('coalesced');

    await runtime.advance(120_000);
    expect((await runtime.jobs.enqueue({ queue: 'coalesce', coalesce })).status).toBe('enqueued');
  });
});

describe('guard rails', () => {
  it('refuses to work or schedule on a queue that was never declared', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();

    await expect(runtime.jobs.work({ queue: 'nope', handler: async () => {} })).rejects.toThrow(
      JobsValidationError,
    );
    await expect(
      runtime.jobs.scheduleCron({ queue: 'nope', cron: '* * * * *', timezone: 'UTC' }),
    ).rejects.toThrow(/not defined/);
  });

  it('stops rather than spinning when a handler re-enqueues itself with no delay', async () => {
    // A small budget on purpose: each pass scans the job list, so proving the guard at the default
    // 10 000 costs a hundred million comparisons and turns a unit test into a stopwatch.
    const runtime = createInMemoryJobs({ maxDrainPasses: 50 });
    await runtime.start();
    await runtime.jobs.defineQueue({ name: 'loop' });
    await runtime.jobs.work({
      queue: 'loop',
      handler: async () => {
        await runtime.jobs.enqueue({ queue: 'loop' });
      },
    });

    await runtime.jobs.enqueue({ queue: 'loop' });
    await expect(runtime.drain()).rejects.toThrow(/did not settle/);
  });

  it('applies the queue retry backoff instead of ignoring it', async () => {
    // Divergence 4 in the register: pg-boss jitters a backed-off retry over
    // `[base·2^n/2, base·2^n)` — at least one second even at `retryDelay: 0` — and the fake takes
    // the top of that band. Ignoring `retryBackoff`, as it used to, made the fake retry sooner
    // than production, which is the one direction a fake must never take.
    const runtime = createInMemoryJobs();
    await runtime.start();
    await runtime.jobs.defineQueue({
      name: 'backoff',
      retryLimit: 3,
      retryDelaySeconds: 0,
      retryBackoff: true,
    });
    const attempts: Date[] = [];
    await runtime.jobs.work({
      queue: 'backoff',
      handler: async () => {
        attempts.push(runtime.now());
        throw new Error('deliberate failure');
      },
    });

    await runtime.jobs.enqueue({ queue: 'backoff' });
    await runtime.drain();
    expect(attempts).toHaveLength(1);

    // base = max(0, 1) = 1, n = 1 → 2 s. A second earlier and nothing has happened yet.
    await runtime.advance(1_999);
    expect(attempts).toHaveLength(1);
    await runtime.advance(1);
    expect(attempts).toHaveLength(2);

    // n = 2 → 4 s.
    await runtime.advance(3_999);
    expect(attempts).toHaveLength(2);
    await runtime.advance(1);
    expect(attempts).toHaveLength(3);
  });

  it('keeps a flat delay when the queue does not ask for backoff', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await runtime.jobs.defineQueue({ name: 'flat', retryLimit: 1, retryDelaySeconds: 5 });
    const attempts: Date[] = [];
    await runtime.jobs.work({
      queue: 'flat',
      handler: async () => {
        attempts.push(runtime.now());
        throw new Error('deliberate failure');
      },
    });

    await runtime.jobs.enqueue({ queue: 'flat' });
    await runtime.drain();
    await runtime.advance(4_999);
    expect(attempts).toHaveLength(1);
    await runtime.advance(1);
    expect(attempts).toHaveLength(2);
  });

  it('runs the higher priority job first', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await runtime.jobs.defineQueue({ name: 'priority' });
    const order: unknown[] = [];
    await runtime.jobs.work({
      queue: 'priority',
      handler: async (job) => {
        order.push(job.data.label);
      },
    });

    await runtime.jobs.enqueue({ queue: 'priority', data: { label: 'low' }, priority: 0 });
    await runtime.jobs.enqueue({ queue: 'priority', data: { label: 'high' }, priority: 10 });
    await runtime.drain();

    expect(order).toEqual(['high', 'low']);
  });

  it('drops a dead letter with no declared queue rather than failing the job again', async () => {
    const runtime = createInMemoryJobs();
    await runtime.start();
    await runtime.jobs.defineQueue({ name: 'failing', retryLimit: 0, deadLetterQueue: 'nowhere' });
    await runtime.jobs.work({
      queue: 'failing',
      handler: async () => {
        throw new Error('nope');
      },
    });

    await runtime.jobs.enqueue({ queue: 'failing' });
    await expect(runtime.drain()).resolves.toBeUndefined();
    expect(runtime.snapshot()[0]?.state).toBe('failed');
  });

  it('reports a job that exhausted its retries', async () => {
    const failures: string[] = [];
    const runtime = createInMemoryJobs({
      onJobFailed: (queue, id) => failures.push(`${queue}/${id}`),
    });
    await runtime.start();
    await runtime.jobs.defineQueue({ name: 'failing', retryLimit: 0 });
    await runtime.jobs.work({
      queue: 'failing',
      handler: async () => {
        throw new Error('nope');
      },
    });

    await runtime.jobs.enqueue({ queue: 'failing' });
    await runtime.drain();
    expect(failures).toEqual(['failing/job_00000001']);
  });
});
