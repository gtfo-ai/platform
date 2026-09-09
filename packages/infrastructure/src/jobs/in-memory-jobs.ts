/**
 * In-memory `Jobs` adapter — the fake half of the pair (technical/10: "fixtures and fakes are
 * first-class code").
 *
 * It exists so a work package that schedules something can be tested without PostgreSQL, and so
 * the contract suite has a second implementation to hold pg-boss against. It is therefore written
 * to the *observable* semantics of the port, deliberately reproducing pg-boss's rules rather than
 * inventing kinder ones:
 *
 *  - coalescing collapses on the fixed slot grid `floor(epoch / windowSeconds)` taken from the
 *    clock at enqueue, and a slot stays occupied after the job completes (pg-boss's partial unique
 *    index over `singleton_on` covers every state but `cancelled`), so a burst really does execute
 *    once;
 *  - `throttle_with_trailing` adds the one trailing job pg-boss's second insert attempt produces,
 *    at the instant its `getDebounceStartAfter` computes — see `trailingStartAfterMs`;
 *  - cron fires when the expression's previous occurrence is less than a minute old and no other
 *    tick for that schedule has fired in the same minute — pg-boss's `shouldSendIt` plus its
 *    60-second `singletonSeconds` on the internal send queue.
 *
 * Time is virtual: nothing here reads `Date.now()` unless the caller asks for it. Handlers run
 * only inside `advance`/`drain`, so a test never races a poller.
 *
 * ## Known divergences from pg-boss
 *
 * The register is here, in one place, so the set is written down rather than rediscovered. The
 * rule for adding to it: **the fake must never be kinder than production** — a later work
 * package's unit tier trusts this file, and anything that passes here but fails against pg-boss
 * becomes a bug found only in the integration tier. Being *stricter* is allowed; so is being
 * *simpler in a way the port promises nothing about*. The entries say which they are, because a
 * reader who takes "stricter" on faith will not re-check.
 *
 *  1. **Stricter — retries reuse `created`; pg-boss uses `retry`.** pg-boss's policy indexes treat
 *     `retry` as its own slot, so under `stately` it admits a concurrent send while a job waits to
 *     be retried, where the fake reports `coalesced`. Nothing in the port promises either.
 *  2. **Different — one job at a time.** `WorkRequest.concurrency` is accepted and ignored, so a
 *     test never has to reason about interleaving. Neither stricter nor kinder: the port makes no
 *     promise about parallelism, and a work package that needs to test interleaving must extend
 *     the fake rather than assume it.
 *  3. **Different — the clock is the caller's, not the database's.** pg-boss buckets slots and
 *     evaluates cron against the *server's* `now()` and corrects for skew; the fake has one clock
 *     and no skew. Unobservable through the port, which never exposes a server timestamp.
 *  4. **Stricter — backed-off retries take the top of pg-boss's jitter band.** pg-boss jitters a
 *     backed-off retry uniformly over `[base·2^n/2, base·2^n)`; the fake always waits `base·2^n`
 *     (see `retryDelayMs`), so it is never ready sooner than production. The residual: an
 *     assertion that a retry has *not* happened yet, at an instant inside the jitter band, can
 *     hold here and fail against a pg-boss run that jittered low.
 */
import {
  assertEnqueueRequest,
  assertJobKey,
  assertJobName,
  type CronSchedule,
  type CronScheduleDefinition,
  coalescingSlotStart,
  type EnqueueRequest,
  type EnqueueResult,
  type JobData,
  type JobHandler,
  type JobQueueDefinition,
  type JobQueuePolicy,
  type Jobs,
  type JobsRuntime,
  JobsValidationError,
  type JobWorker,
  type WorkRequest,
} from '@platform/application';
import { CronExpressionParser } from 'cron-parser';

/** Every state a fake job can be in. Mirrors the pg-boss state names that matter to the port. */
type JobState = 'created' | 'active' | 'completed' | 'failed' | 'cancelled';

interface StoredJob {
  readonly id: string;
  readonly queue: string;
  readonly data: JobData;
  startAfterMs: number;
  state: JobState;
  readonly singletonKey: string | null;
  /** Unix *seconds* of the coalescing slot this job occupies, or null when it is not coalesced. */
  readonly singletonOn: number | null;
  readonly priority: number;
  attempts: number;
  readonly retryLimit: number;
  readonly deadLetterQueue: string | null;
}

interface StoredQueue extends JobQueueDefinition {
  readonly policy: JobQueuePolicy;
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
}

/** `concurrency` is deliberately not stored — divergence 2 in the register above. */
interface StoredWorker {
  readonly queue: string;
  readonly handler: JobHandler<never>;
  stopped: boolean;
}

/** Default virtual origin: a Monday, so a test that says "09:00" gets a working day. */
export const IN_MEMORY_JOBS_EPOCH = new Date('2026-06-01T08:00:00.000Z');

export interface InMemoryJobsOptions {
  /** Where the virtual clock starts. @default IN_MEMORY_JOBS_EPOCH */
  readonly startTime?: Date;
  /** Reported to the caller when a job exhausts its retries. */
  readonly onJobFailed?: (queue: string, jobId: string, error: unknown) => void;
  /**
   * How many jobs one `drain` may run before it decides a handler is re-enqueuing itself in a
   * loop. Lower it in a test that means to hit the guard: each pass scans the job list, so proving
   * the guard at the default budget costs a hundred million comparisons.
   * @default MAX_DRAIN_PASSES
   */
  readonly maxDrainPasses?: number;
}

/** A `JobsRuntime` plus the controls a test needs to move the virtual clock. */
export interface InMemoryJobsRuntime extends JobsRuntime {
  /** The current virtual instant. */
  readonly now: () => Date;
  /** Moves the clock forward and runs everything that falls due, including chained work. */
  readonly advance: (milliseconds: number) => Promise<void>;
  /** Runs everything already due without moving the clock. */
  readonly drain: () => Promise<void>;
  /** Every job the store holds, newest last — for assertions. */
  readonly snapshot: () => readonly {
    readonly id: string;
    readonly queue: string;
    readonly state: string;
    readonly startAfter: Date;
    readonly data: JobData;
  }[];
}

const MS_PER_SECOND = 1000;
/** pg-boss dedupes a cron tick for 60 seconds and fires when the last occurrence is that recent. */
const CRON_TICK_SECONDS = 60;
/**
 * How far `advance` moves between drains. Half a cron tick, so a schedule is always evaluated at
 * least once *inside* the minute it is due: `prev()` returns the occurrence strictly before the
 * reference instant, so evaluating exactly on the boundary would look a whole period stale. The
 * real scheduler polls on a timer and never lands exactly on the second, which is why pg-boss's
 * own `prevDiff < 60` is enough there.
 */
const ADVANCE_STEP_MS = (CRON_TICK_SECONDS / 2) * 1000;
/** Stops a handler that re-enqueues itself with no delay from spinning forever inside `drain`. */
const MAX_DRAIN_PASSES = 10_000;

/**
 * Map key for a schedule. The separator is written as the escape `\0`, never as a literal NUL
 * byte: a NUL in the source makes git treat the whole file as binary, so its diffs render as
 * "Bin 15783 -> 16434 bytes", `grep` skips it, and it cannot be three-way merged.
 */
const scheduleId = (queue: string, key: string): string => `${queue}\0${key}`;

/**
 * When the trailing job of `throttle_with_trailing` becomes runnable.
 *
 * A transcription of pg-boss's `getDebounceStartAfter`, kept deliberately literal — including the
 * `|| 1` and the extra second for windows longer than one, both of which push the job *later* than
 * the slot boundary. Rounding the boundary down instead would make the fake up to a second more
 * eager than production, and a fake that is kinder than the real adapter is worse than no fake.
 */
/**
 * How long a failed job waits before its next attempt.
 *
 * pg-boss computes this in SQL (`plans.js`, the `start_after` CASE of the fail statement):
 *
 *     NOT retry_backoff  →  now() + retry_delay
 *     retry_backoff      →  now() + LEAST(retry_delay_max,
 *                                   GREATEST(retry_delay, 1) * (2^n/2 + 2^n/2 * random()))
 *                           with n = LEAST(16, retry_count + 1)
 *
 * so a backed-off retry is jittered uniformly over `[base·2^n/2, base·2^n)` — at least one second
 * even when `retryDelay` is 0. The fake takes the **top** of that band rather than a random point
 * in it, for two reasons: a test double must be reproducible, and of the two ends only the top is
 * safe. A test that waits out the fake's delay and asserts the retry happened then also holds in
 * production, whose delay is never longer. Taking the bottom would let exactly the opposite pass
 * here and fail in the integration tier — which is the trap this whole register exists to close.
 */
const retryDelayMs = (queue: StoredQueue, attempts: number): number => {
  if (queue.retryBackoff !== true) {
    return queue.retryDelaySeconds * MS_PER_SECOND;
  }
  const exponent = Math.min(16, attempts);
  const base = Math.max(queue.retryDelaySeconds, 1);
  return base * 2 ** exponent * MS_PER_SECOND;
};

const trailingStartAfterMs = (nowMs: number, windowSeconds: number): number => {
  const intervalMs = windowSeconds * MS_PER_SECOND;
  const slotMs = Math.floor(nowMs / intervalMs) * intervalMs;
  const elapsedSeconds = Math.floor((nowMs - slotMs) / MS_PER_SECOND);
  let seconds = windowSeconds - elapsedSeconds || 1;
  if (windowSeconds > 1) {
    seconds += 1;
  }
  return nowMs + seconds * MS_PER_SECOND;
};

export const createInMemoryJobs = (options: InMemoryJobsOptions = {}): InMemoryJobsRuntime => {
  let nowMs = (options.startTime ?? IN_MEMORY_JOBS_EPOCH).getTime();
  let sequence = 0;
  let started = false;

  const queues = new Map<string, StoredQueue>();
  const jobs: StoredJob[] = [];
  const workers = new Map<string, StoredWorker[]>();
  const schedules = new Map<string, CronSchedule>();
  /** schedule id -> the minute (unix seconds, floored to 60) its last tick fired in. */
  const cronTicks = new Map<string, number>();

  const nextId = (): string => {
    sequence += 1;
    return `job_${String(sequence).padStart(8, '0')}`;
  };

  /** Handlers only run between `start()` and `stop()`, as they do with the real adapter. */
  const requireStarted = (): void => {
    if (!started) {
      throw new Error('start() the in-memory jobs runtime before running its handlers');
    }
  };

  const requireQueue = (name: string): StoredQueue => {
    const queue = queues.get(name);
    if (queue === undefined) {
      throw new JobsValidationError(
        `queue ${JSON.stringify(name)} is not defined; call defineQueue first`,
      );
    }
    return queue;
  };

  /** pg-boss's partial unique index: one job per (queue, singleton_on, key) in any live state. */
  const slotTaken = (queue: string, key: string | null, slot: number): boolean =>
    jobs.some(
      (job) =>
        job.queue === queue &&
        job.singletonOn === slot &&
        (job.singletonKey ?? '') === (key ?? '') &&
        job.state !== 'cancelled',
    );

  /** Queue-policy admission, applied to a job that is about to be created. */
  const policyBlocksCreation = (queue: StoredQueue, key: string | null): boolean => {
    // `standard` admits everything; `singleton` caps only the active side, and a new job is always
    // queued first, so neither blocks a creation.
    if (queue.policy === 'standard' || queue.policy === 'singleton') {
      return false;
    }
    const sameKey = jobs.filter(
      (job) => job.queue === queue.name && (job.singletonKey ?? '') === (key ?? ''),
    );
    if (queue.policy === 'exclusive') {
      return sameKey.some((job) => job.state === 'created' || job.state === 'active');
    }
    // short and stately both cap the queued side at one.
    return sameKey.some((job) => job.state === 'created');
  };

  /** `singleton`, `stately` and `exclusive` allow only one *active* job per key. */
  const policyBlocksActivation = (queue: StoredQueue, key: string | null): boolean => {
    if (queue.policy === 'standard' || queue.policy === 'short') {
      return false;
    }
    return jobs.some(
      (job) =>
        job.queue === queue.name &&
        (job.singletonKey ?? '') === (key ?? '') &&
        job.state === 'active',
    );
  };

  const insert = (
    queue: StoredQueue,
    request: EnqueueRequest,
    startAfterMs: number,
    singletonKey: string | null,
    singletonOn: number | null,
  ): EnqueueResult => {
    if (singletonOn !== null && slotTaken(queue.name, singletonKey, singletonOn)) {
      return { status: 'coalesced', jobId: null };
    }
    if (policyBlocksCreation(queue, singletonKey)) {
      return { status: 'coalesced', jobId: null };
    }
    const job: StoredJob = {
      id: nextId(),
      queue: queue.name,
      data: request.data ?? {},
      startAfterMs,
      state: 'created',
      singletonKey,
      singletonOn,
      priority: request.priority ?? 0,
      attempts: 0,
      retryLimit: request.retryLimit ?? queue.retryLimit,
      deadLetterQueue: request.deadLetterQueue ?? queue.deadLetterQueue ?? null,
    };
    jobs.push(job);
    return { status: 'enqueued', jobId: job.id };
  };

  const enqueue = async <TData extends JobData>(
    request: EnqueueRequest<TData>,
  ): Promise<EnqueueResult> => {
    assertEnqueueRequest(request);
    const queue = requireQueue(request.queue);
    const startAfterMs = Math.max(nowMs, request.startAfter?.getTime() ?? nowMs);

    if (request.coalesce === undefined) {
      return insert(queue, request, startAfterMs, request.singletonKey ?? null, null);
    }

    const { key, windowSeconds, mode = 'throttle' } = request.coalesce;
    // Bucketed on the clock at enqueue, exactly as pg-boss does it in SQL
    // (`floor((epoch(now()) + singletonOffset) / singletonSeconds)`), never on `startAfter` —
    // which the port refuses to accept alongside `coalesce` for this very reason.
    const currentSlot = coalescingSlotStart(new Date(nowMs), windowSeconds);
    const first = insert(queue, request, nowMs, key, currentSlot);
    if (first.status === 'enqueued' || mode === 'throttle') {
      return first;
    }

    // One trailing job, which is what pg-boss's second insert attempt produces: `singletonOffset`
    // puts it in the next slot, and `startAfter` is overwritten with `getDebounceStartAfter`.
    // Leading edge, not a debounce.
    const nextSlot = currentSlot + windowSeconds;
    return insert(queue, request, trailingStartAfterMs(nowMs, windowSeconds), key, nextSlot);
  };

  const fireDueCronTicks = async (): Promise<void> => {
    const minute = Math.floor(nowMs / MS_PER_SECOND / CRON_TICK_SECONDS) * CRON_TICK_SECONDS;
    for (const [id, schedule] of schedules) {
      if (cronTicks.get(id) === minute) {
        continue;
      }
      const interval = CronExpressionParser.parse(schedule.cron, {
        tz: schedule.timezone,
        strict: false,
        currentDate: new Date(nowMs),
      });
      const previous = interval.prev().getTime();
      if ((nowMs - previous) / MS_PER_SECOND >= CRON_TICK_SECONDS) {
        continue;
      }
      cronTicks.set(id, minute);
      await enqueue({ queue: schedule.queue, ...(schedule.data ? { data: schedule.data } : {}) });
    }
  };

  const claimNext = (): StoredJob | undefined => {
    const candidates = jobs
      .filter((job) => job.state === 'created' && job.startAfterMs <= nowMs)
      .filter((job) => (workers.get(job.queue) ?? []).some((worker) => !worker.stopped))
      .filter((job) => !policyBlocksActivation(requireQueue(job.queue), job.singletonKey));
    candidates.sort((left, right) =>
      left.priority === right.priority
        ? left.id.localeCompare(right.id)
        : right.priority - left.priority,
    );
    return candidates[0];
  };

  const runJob = async (job: StoredJob): Promise<void> => {
    const worker = (workers.get(job.queue) ?? []).find((candidate) => !candidate.stopped);
    if (worker === undefined) {
      return;
    }
    job.state = 'active';
    job.attempts += 1;
    const controller = new AbortController();
    try {
      await (worker.handler as JobHandler)({
        id: job.id,
        queue: job.queue,
        data: job.data,
        signal: controller.signal,
      });
      job.state = 'completed';
    } catch (error) {
      const queue = requireQueue(job.queue);
      if (job.attempts <= job.retryLimit) {
        // Divergence 1 in the register above: pg-boss moves the job to `retry`, which is its own
        // slot in the policy indexes. Reusing `created` makes the fake refuse a concurrent send
        // that pg-boss would admit — stricter, never kinder.
        job.state = 'created';
        job.startAfterMs = nowMs + retryDelayMs(queue, job.attempts);
        return;
      }
      job.state = 'failed';
      options.onJobFailed?.(job.queue, job.id, error);
      if (job.deadLetterQueue !== null && queues.has(job.deadLetterQueue)) {
        await enqueue({ queue: job.deadLetterQueue, data: job.data });
      }
    }
  };

  const maxDrainPasses = options.maxDrainPasses ?? MAX_DRAIN_PASSES;

  const drain = async (): Promise<void> => {
    await fireDueCronTicks();
    for (let pass = 0; pass < maxDrainPasses; pass += 1) {
      const job = claimNext();
      if (job === undefined) {
        return;
      }
      await runJob(job);
    }
    throw new Error(
      `in-memory jobs did not settle after ${maxDrainPasses} passes; a handler is probably re-enqueuing itself with no delay`,
    );
  };

  const advance = async (milliseconds: number): Promise<void> => {
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new Error(`advance expects a non-negative number of milliseconds, got ${milliseconds}`);
    }
    // Step in fractions of a cron tick so a schedule inside the interval fires on its own tick
    // rather than being collapsed into one at the far end.
    const target = nowMs + milliseconds;
    do {
      nowMs = Math.min(target, nowMs + ADVANCE_STEP_MS);
      await drain();
    } while (nowMs < target);
  };

  const jobsPort: Jobs = {
    defineQueue: async (definition) => {
      assertJobName(definition.name);
      if (definition.deadLetterQueue !== undefined) {
        assertJobName(definition.deadLetterQueue, 'dead letter queue name');
      }
      if (queues.has(definition.name)) {
        return;
      }
      queues.set(definition.name, {
        ...definition,
        policy: definition.policy ?? 'standard',
        retryLimit: definition.retryLimit ?? 2,
        retryDelaySeconds: definition.retryDelaySeconds ?? 0,
      });
    },

    enqueue,

    scheduleCron: async (definition: CronScheduleDefinition) => {
      assertJobName(definition.queue);
      requireQueue(definition.queue);
      const key = definition.key ?? '';
      if (key !== '') {
        assertJobKey(key, 'schedule key');
      }
      // Parsing with the schedule's own zone is what rejects both a bad expression and a bad zone;
      // cron-parser only constructs a zoned date when it is given a reference date.
      CronExpressionParser.parse(definition.cron, {
        tz: definition.timezone,
        strict: false,
        currentDate: new Date(nowMs),
      });
      schedules.set(scheduleId(definition.queue, key), { ...definition, key });
    },

    unscheduleCron: async (queue, key = '') => {
      schedules.delete(scheduleId(queue, key));
      cronTicks.delete(scheduleId(queue, key));
    },

    listCronSchedules: async (queue) =>
      [...schedules.values()]
        .filter((schedule) => queue === undefined || schedule.queue === queue)
        .sort((left, right) =>
          `${left.queue}/${left.key}`.localeCompare(`${right.queue}/${right.key}`),
        ),

    work: async <TData extends JobData>(request: WorkRequest<TData>): Promise<JobWorker> => {
      assertJobName(request.queue);
      requireQueue(request.queue);
      const worker: StoredWorker = {
        queue: request.queue,
        handler: request.handler as unknown as JobHandler<never>,
        stopped: false,
      };
      const existing = workers.get(request.queue) ?? [];
      workers.set(request.queue, [...existing, worker]);
      return {
        queue: request.queue,
        stop: async () => {
          worker.stopped = true;
        },
      };
    },
  };

  return {
    jobs: jobsPort,
    start: async () => {
      started = true;
    },
    stop: async () => {
      started = false;
      for (const list of workers.values()) {
        for (const worker of list) {
          worker.stopped = true;
        }
      }
    },
    now: () => new Date(nowMs),
    advance: async (milliseconds) => {
      requireStarted();
      await advance(milliseconds);
    },
    drain: async () => {
      requireStarted();
      await drain();
    },
    snapshot: () =>
      jobs.map((job) => ({
        id: job.id,
        queue: job.queue,
        state: job.state,
        startAfter: new Date(job.startAfterMs),
        data: job.data,
      })),
  };
};
