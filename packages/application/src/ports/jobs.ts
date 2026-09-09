/**
 * The `Jobs` port — background work, durable timers, cron schedules and coalesced wake-ups.
 *
 * TD-004 chose pg-boss as the adapter and named the workloads: `stage.execute` (singleton per
 * task), `question.timeout` / `question.reminder` (timers whose `startAfter` is computed on the
 * working-day calendar), `mr.comment.debounce` (coalesced, 2 minutes), `budget.window.reset` and
 * `poll.<provider>` (cron), index rebuilds and maintenance schedules. Dispatching a domain event
 * is **not** one of them: TD-004 was amended at WP-04a, and TD-005's `event_dispatch` table with
 * its per-process sweep stays the only queue events travel on.
 * The decision also says pg-boss is replaceable — graphile-worker is the named alternative — which
 * is only true if the application ring never sees a pg-boss type. Hence this file: interfaces and
 * pure validation, no dependency on any queue library (technical/01 dependency rule).
 *
 * Two implementations ship with the platform and are held to one another by a shared contract
 * suite (technical/10): the pg-boss adapter in `packages/infrastructure`, and the in-memory fake
 * beside it that later work packages use to test scheduling without a database.
 */

/** A job payload. JSON on the wire — snake_case keys, like every other payload in the platform. */
export type JobData = Readonly<Record<string, unknown>>;

/**
 * How a queue treats jobs that are already queued or running.
 *
 * `standard` is the default: everything sent runs. The rest are the coalescing policies TD-004
 * relies on, and they compose with a job's `singleton_key` so the restriction applies per key —
 * per task, per merge request, per project — rather than across the whole queue.
 */
export type JobQueuePolicy =
  /** Every job runs. */
  | 'standard'
  /** At most one job queued per key; unlimited active. */
  | 'short'
  /** At most one job active per key; unlimited queued. */
  | 'singleton'
  /** At most one queued *and* one active per key — TD-004's `stage.execute`. */
  | 'stately'
  /** At most one job per key in any non-terminal state. */
  | 'exclusive';

/**
 * Declares a queue. **Create-if-absent**: declaring one that already exists is a no-op and leaves
 * its stored options alone, so a registrar can run on every boot. Changing a live queue's policy
 * is a deliberate migration, not a side effect of a restart.
 */
export interface JobQueueDefinition {
  readonly name: string;
  /** @default 'standard' */
  readonly policy?: JobQueuePolicy;
  /** Attempts after the first before the job is failed for good. @default 2 */
  readonly retryLimit?: number;
  /** Delay before the first retry. @default 0 */
  readonly retryDelaySeconds?: number;
  /** Exponential backoff from `retryDelaySeconds` instead of a fixed delay. @default false */
  readonly retryBackoff?: boolean;
  /** How long a job may stay active before it is considered lost. @default 900 */
  readonly expireInSeconds?: number;
  /** How long a completed job is kept, for the audit trail. */
  readonly deleteAfterSeconds?: number;
  /** Queue that receives jobs which fail after every retry. Must exist. */
  readonly deadLetterQueue?: string;
}

/**
 * Coalescing: fold a burst of enqueues of the same key into a single execution.
 *
 * The window is a fixed grid, not a sliding one: slot `k` spans
 * `[k · windowSeconds, (k+1) · windowSeconds)` of Unix time **measured at enqueue**, and a
 * `(queue, key, slot)` triple admits exactly one job. That is what makes the guarantee cheap
 * enough to hold in the database (a unique index) instead of in a process's memory, and it is why
 * it survives a restart and a second replica.
 *
 * **This is not a debounce.** Both modes are *leading edge*: the first enqueue of a slot runs
 * immediately, and a later event does not push the run further out. A true debounce — "wait until
 * the events stop, then act once" — cannot be built from a grid, and the platform does not need
 * one: see `JOB_QUEUES.mrCommentDebounce` for the delayed-wake-up pattern that gives BD-007 its
 * two-minute batch window.
 *
 * - `throttle` — the first enqueue of a slot wins; every later one in that slot is dropped and
 *   reported as `coalesced`. Use it when the work is "read the current state and act on it": the
 *   job that already exists will see the later events anyway.
 * - `throttle_with_trailing` — as `throttle`, plus **one** trailing job at the boundary of the
 *   next slot when the current slot is already taken, so an event that arrives while the leading
 *   job is running is still acted on. A burst therefore executes at most twice, not once.
 */
export interface JobCoalescing {
  /** What is being coalesced — a task id, a merge-request ref, a project id. */
  readonly key: string;
  /** Width of one slot, in seconds. Must be a positive integer. */
  readonly windowSeconds: number;
  /** @default 'throttle' */
  readonly mode?: 'throttle' | 'throttle_with_trailing';
}

/** One enqueue. */
export interface EnqueueRequest<TData extends JobData = JobData> {
  readonly queue: string;
  readonly data?: TData;
  /**
   * The instant the job becomes eligible to run — a *timer*. Absolute, never a relative number of
   * seconds, so the caller has to have decided which clock it means. `question.timeout` passes the
   * result of the working-day calendar here.
   *
   * Cannot be combined with `coalesce`: the coalescing slot is chosen from the clock at enqueue,
   * not from `startAfter`, and the trailing job overwrites `startAfter` with a slot boundary — so
   * the pair would mean two different things depending on the adapter. A delayed batch window is
   * built from a queue policy instead (see `JOB_QUEUES.mrCommentDebounce`).
   */
  readonly startAfter?: Date;
  /** Higher runs first. @default 0 */
  readonly priority?: number;
  /** The key the queue's policy applies to. Mutually exclusive with `coalesce`. */
  readonly singletonKey?: string;
  readonly coalesce?: JobCoalescing;
  /** Per-job overrides of the queue defaults. */
  readonly retryLimit?: number;
  readonly expireInSeconds?: number;
  readonly deadLetterQueue?: string;
}

/**
 * Outcome of an enqueue. `coalesced` is a success, not an error: it means an equivalent job is
 * already scheduled for the same key and window, which is exactly what the caller asked for.
 */
export type EnqueueResult =
  | { readonly status: 'enqueued'; readonly jobId: string }
  | { readonly status: 'coalesced'; readonly jobId: null };

/** A cron schedule. */
export interface CronScheduleDefinition {
  readonly queue: string;
  /** Five-field cron expression, evaluated in `timezone`. */
  readonly cron: string;
  /**
   * IANA zone the expression is read in. **Required** — a schedule that means "09:00" has to say
   * whose 09:00, and inheriting the host's zone is how a container migration silently moves it.
   */
  readonly timezone: string;
  /** Distinguishes several schedules on one queue. @default '' */
  readonly key?: string;
  readonly data?: JobData;
}

/** A schedule as the adapter has it stored. */
export interface CronSchedule extends CronScheduleDefinition {
  readonly key: string;
}

/** One unit of work handed to a handler. */
export interface JobContext<TData extends JobData = JobData> {
  readonly id: string;
  readonly queue: string;
  readonly data: TData;
  /** Aborted when the job's lease expires or the worker is stopping. */
  readonly signal: AbortSignal;
}

/** Throwing fails the job and hands it to the retry policy; returning completes it. */
export type JobHandler<TData extends JobData = JobData> = (job: JobContext<TData>) => Promise<void>;

/** Subscribes a handler to a queue. */
export interface WorkRequest<TData extends JobData = JobData> {
  readonly queue: string;
  readonly handler: JobHandler<TData>;
  /** How often the worker looks for work when nothing wakes it. @default 2 */
  readonly pollingIntervalSeconds?: number;
  /** Jobs this worker may run at once. @default 1 */
  readonly concurrency?: number;
}

/** Lets a composition root take a worker down without stopping the whole runtime. */
export interface JobWorker {
  readonly queue: string;
  readonly stop: () => Promise<void>;
}

/**
 * The port. Every method is idempotent in the sense the platform needs: declaring a queue twice,
 * scheduling the same cron twice and enqueuing the same coalesced key twice are all safe.
 *
 * Deliberately absent: any way to *cancel* a timer. TD-004's consequence — "every timer job
 * re-validates state when it fires, so cancellation is optional" — is the platform's rule, and a
 * cancel method would invite handlers that depend on it.
 */
export interface Jobs {
  readonly defineQueue: (definition: JobQueueDefinition) => Promise<void>;
  readonly enqueue: <TData extends JobData = JobData>(
    request: EnqueueRequest<TData>,
  ) => Promise<EnqueueResult>;
  readonly scheduleCron: (definition: CronScheduleDefinition) => Promise<void>;
  readonly unscheduleCron: (queue: string, key?: string) => Promise<void>;
  readonly listCronSchedules: (queue?: string) => Promise<readonly CronSchedule[]>;
  readonly work: <TData extends JobData = JobData>(
    request: WorkRequest<TData>,
  ) => Promise<JobWorker>;
}

/**
 * The lifecycle around a `Jobs` instance. Owned by a composition root (`apps/*`), never by a use
 * case — which is why `start`/`stop` are not on `Jobs` itself.
 */
export interface JobsRuntime {
  readonly jobs: Jobs;
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
}

/** Raised for anything the port itself rejects, before an adapter is involved. */
export class JobsValidationError extends Error {
  override readonly name = 'JobsValidationError';
}

/**
 * Queue, schedule-key and coalescing-key grammar.
 *
 * Stricter than the adapter's: pg-boss interpolates a queue name straight into SQL text, so the
 * port refuses anything but lower-case dotted identifiers rather than relying on the library's
 * own check. Dots because TD-004's names are dotted (`stage.execute`, `question.timeout`).
 */
export const JOB_NAME_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;

/** Longest a queue name or key may be; `pgboss.queue.name` and the NOTIFY channel are bounded. */
export const JOB_NAME_MAX_LENGTH = 63;

export const isValidJobName = (value: string): boolean =>
  value.length > 0 && value.length <= JOB_NAME_MAX_LENGTH && JOB_NAME_PATTERN.test(value);

export const assertJobName = (value: string, what = 'queue name'): void => {
  if (!isValidJobName(value)) {
    throw new JobsValidationError(
      `invalid ${what} ${JSON.stringify(value)}: expected 1-${JOB_NAME_MAX_LENGTH} characters matching ${String(JOB_NAME_PATTERN)}`,
    );
  }
};

/**
 * A coalescing/singleton key. Looser than a queue name — it carries user data such as a ticket key
 * or a merge-request ref — but still bounded and free of anything that could confuse a key
 * comparison.
 */
export const JOB_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;
export const JOB_KEY_MAX_LENGTH = 200;

export const assertJobKey = (value: string, what = 'singleton key'): void => {
  if (value.length === 0 || value.length > JOB_KEY_MAX_LENGTH || !JOB_KEY_PATTERN.test(value)) {
    throw new JobsValidationError(
      `invalid ${what} ${JSON.stringify(value)}: expected 1-${JOB_KEY_MAX_LENGTH} characters matching ${String(JOB_KEY_PATTERN)}`,
    );
  }
};

/** Validates an enqueue request the same way in every adapter. Returns nothing; throws on error. */
export const assertEnqueueRequest = (request: EnqueueRequest): void => {
  assertJobName(request.queue);
  if (request.singletonKey !== undefined) {
    assertJobKey(request.singletonKey);
  }
  if (request.deadLetterQueue !== undefined) {
    assertJobName(request.deadLetterQueue, 'dead letter queue name');
  }
  if (request.startAfter !== undefined && Number.isNaN(request.startAfter.getTime())) {
    throw new JobsValidationError('startAfter must be a valid Date');
  }
  if (request.priority !== undefined && !Number.isSafeInteger(request.priority)) {
    throw new JobsValidationError(`priority must be an integer, got ${request.priority}`);
  }
  if (request.coalesce !== undefined) {
    assertJobKey(request.coalesce.key, 'coalescing key');
    const { windowSeconds } = request.coalesce;
    if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 1) {
      throw new JobsValidationError(
        `coalesce.windowSeconds must be a positive integer number of seconds, got ${windowSeconds}`,
      );
    }
    if (request.singletonKey !== undefined) {
      // A job carries one singleton key, and coalescing needs it. Silently letting one win would
      // make the queue policy or the coalescing window quietly stop applying, so it is an error.
      throw new JobsValidationError(
        'a job cannot set both singletonKey and coalesce: coalescing owns the singleton key',
      );
    }
    if (request.startAfter !== undefined) {
      // The slot is chosen from the clock at enqueue, and a trailing job overwrites `startAfter`
      // with the next slot boundary. Accepting both would make the pair mean one thing in the
      // in-memory fake and another in pg-boss — the divergence a fake exists to prevent.
      throw new JobsValidationError(
        'a job cannot set both startAfter and coalesce: use a queue policy plus singletonKey for a delayed batch window',
      );
    }
  }
};

/**
 * The Unix-second boundary of the coalescing slot `at` falls in. Shared by both adapters so the
 * fake and pg-boss agree on which enqueues collapse; mirrors pg-boss's
 * `singleton_on = floor(epoch / seconds) * seconds`.
 */
export const coalescingSlotStart = (at: Date, windowSeconds: number): number =>
  Math.floor(at.getTime() / 1000 / windowSeconds) * windowSeconds;

/**
 * Queue names TD-004 enumerates. Later work packages own the handlers; the names live here so two
 * packages cannot spell the same queue differently. Not exhaustive — `poll.<provider>` is built
 * per provider by `pollQueueName`.
 *
 * There is deliberately **no `dispatch` queue**, and adding one is a mistake a test guards against.
 * Domain events are dispatched from TD-005's `event_dispatch` table by a sweep each process runs on
 * its own timer (`OUTBOX_SWEEP_LABEL`); enqueueing them here as well would split durability across
 * two queues that disagree after a crash and would lose per-stream ordering, which pg-boss cannot
 * express. WP-15 enqueues *stages*, never events.
 */
export const JOB_QUEUES = {
  /** One agent stage of one task; `stately` per `task:<id>`. */
  stageExecute: 'stage.execute',
  /** Question deadline; `startAfter` from the working-day calendar. */
  questionTimeout: 'question.timeout',
  /** Question reminder; `startAfter` from the working-day calendar. */
  questionReminder: 'question.reminder',
  /**
   * Merge-request comment batching (BD-007, technical/02 § ReviewCommentBatcher: batch for two
   * minutes per merge request, then emit **one** `task.stage.returned`).
   *
   * The name is TD-004's. `coalesce` does **not** implement it — both coalescing modes fire on the
   * leading edge, so a burst would bounce the task back the moment the first comment arrived. The
   * pattern that does, and that WP-15 must use, is a **delayed wake-up plus re-validation**:
   * declare this queue with policy `stately`, and on every `mr.review.comment` enqueue
   * `{ singletonKey: 'mr:<iid>', startAfter: now + 2 min }`. The policy admits one queued job per
   * merge request, so the whole burst collapses onto the first comment's timer; two minutes later
   * the handler re-reads every unresolved thread and emits one event. A comment arriving while the
   * handler runs finds the queued slot free again and starts the next window, so nothing is lost.
   */
  mrCommentDebounce: 'mr.comment.debounce',
  /** Budget window rollover (cron). */
  budgetWindowReset: 'budget.window.reset',
  /** Knowledge-base index rebuild; singleton per project. */
  knowledgeIndex: 'knowledge.index',
  /** Monthly partition creation and transcript retention (cron, technical/03). */
  partitionMaintenance: 'db.partitions.maintain',
} as const;

/** The polling queue of one integration provider (`poll.jira_cloud`, `poll.gitlab`, …). */
export const pollQueueName = (provider: string): string => {
  const name = `poll.${provider}`;
  assertJobName(name, 'poll queue name');
  return name;
};
