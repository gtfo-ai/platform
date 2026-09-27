/**
 * The job client of a process that serves the API and runs no worker — `ROLE=api` (WP-72).
 *
 * ## Why `ROLE=api` holds a queue client at all
 *
 * Until WP-72 an API-only process held **no** job runtime (`jobs: null`), and every command whose
 * effect is performed by a worker degraded on it: a maintainer's knowledge approval waited for the
 * nightly hygiene pass instead of being committed in seconds, and every command that must start
 * something — the task commands that move a task to a stage, a discovery start, a shadow batch, a
 * history bootstrap, an ask — **refused by name**. Each refusal was honest, and the sum was a role that
 * could not run the onboarding wizard's discovery step. TD-028 decision 6 names `ROLE=api` beside a
 * runner as a supported topology, and the first two-process tier (WP-72, PROGRESS backlog 38)
 * measured the gap rather than reasoning about it: a command answered on the API process was never
 * performed by the worker next to it, because nothing was ever enqueued.
 *
 * The fix is the smallest thing that crosses the process boundary the way every other crossing in
 * this platform does — through the database. The API process starts a pg-boss client with
 * **supervision and cron evaluation off**, and hands its compositions this wrapper, which lets an
 * enqueue through and **refuses by name** everything a worker does: subscribing a queue, declaring
 * one, scheduling a cron. So the role still performs no job, by construction rather than by
 * convention — a composition that tried to `work()` here would fail at start-up, not take a job it
 * cannot perform (TD-028 decision 5's reasoning, applied to the API role).
 *
 * ## What it costs, stated
 *
 *  - **One more pooled connection on the API floor** (`POOL_RESERVATIONS.jobsSender`): pg-boss's
 *    queue cache is refreshed on an interval even when no worker is running, and that query borrows
 *    from the same pool as the request queries. An enqueue itself is one statement on the request's
 *    own path.
 *  - **A queue no worker has ever declared cannot be sent to.** pg-boss 12 refuses `send` for an
 *    unknown queue (`Queue <name> does not exist`), and queues are declared by the workers that
 *    serve them. On an installation whose worker has **never** started against this database, a
 *    command that enqueues is therefore refused with {@link QueueNotDeclaredError} rather than
 *    silently queued. The window is the first boot of a split deployment before its first worker;
 *    once any worker has started, the declaration persists in `pgboss.queue`.
 */
import type { EnqueueRequest, EnqueueResult, JobData, Jobs } from '@platform/application';

/** Raised when a process with an enqueue-only client is asked to do what only a worker does. */
export class EnqueueOnlyJobsError extends Error {
  readonly operation: string;

  constructor(operation: string, role: string) {
    super(
      `ROLE=${role} holds an enqueue-only job client: it may enqueue work for a worker, and it never ${operation}. A composition that needs to ${operation} belongs to a worker role (worker, runner, indexer or all).`,
    );
    this.name = 'EnqueueOnlyJobsError';
    this.operation = operation;
  }
}

/** Raised when an enqueue names a queue no worker has declared in this database yet. */
export class QueueNotDeclaredError extends Error {
  readonly queue: string;

  constructor(queue: string, cause: unknown) {
    super(
      `the job queue "${queue}" has not been declared in this database: queues are declared by the worker that serves them, and no worker process has started against it yet. Start a worker (ROLE=worker, runner, indexer or all) and retry.`,
      { cause },
    );
    this.name = 'QueueNotDeclaredError';
    this.queue = queue;
  }
}

/** pg-boss's own words for an unknown queue (`manager.js`, `getQueueCache`). */
const UNKNOWN_QUEUE = /^Queue (\S+) does not exist$/;

/**
 * Wraps a `Jobs` so that only `enqueue` works. `listCronSchedules` is refused too: it is a read,
 * but nothing that serves the API has a reason to ask, and a method that answered here would be a
 * method somebody composes against.
 */
export const enqueueOnlyJobs = (jobs: Jobs, role: string): Jobs => {
  const refuse = (operation: string) => async (): Promise<never> => {
    throw new EnqueueOnlyJobsError(operation, role);
  };
  return {
    enqueue: async <TData extends JobData = JobData>(
      request: EnqueueRequest<TData>,
    ): Promise<EnqueueResult> => {
      try {
        return await jobs.enqueue(request);
      } catch (error) {
        if (error instanceof Error && UNKNOWN_QUEUE.test(error.message)) {
          throw new QueueNotDeclaredError(request.queue, error);
        }
        throw error;
      }
    },
    defineQueue: refuse('declares a queue'),
    scheduleCron: refuse('schedules a cron'),
    unscheduleCron: refuse('removes a cron schedule'),
    listCronSchedules: refuse('reads the cron schedules'),
    work: refuse('subscribes a queue'),
  };
};
