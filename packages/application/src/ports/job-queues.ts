/**
 * **Every job queue the platform declares, in one table** (WP-86, PROGRESS backlog 262).
 *
 * Until WP-86 a queue was declared by the worker composition that served it — fifteen `defineQueue`
 * calls across ten modules and two rings — so a database that no worker had ever started against
 * had **no** queues, and pg-boss 12 refuses `send` to an unknown queue. On the documented split
 * (`ROLE=api` beside `ROLE=worker`) every command that enqueues was therefore refused with a 500
 * from the first boot until the worker's first successful start, which is indefinite when the worker
 * is refused at its own pool floor.
 *
 * This table is read by **two** kinds of reader, and it is the only place a queue's options are
 * written:
 *
 *  - **`migrate`** (`packages/infrastructure/src/db/migrator.ts`) declares every row after it has
 *    installed pg-boss's schema, under the migration advisory lock. `migrate` runs before every
 *    product process, so a first-boot enqueue cannot meet an undeclared queue.
 *  - **the workers' compositions** still declare the queues they serve on every boot, through
 *    {@link jobQueueDefinition}. That is idempotent (pg-boss's `create_queue` is
 *    `insert … on conflict do nothing` under its own advisory lock), and it keeps a database
 *    migrated by an older build — one whose `migrate` declared nothing — working the way it did.
 *
 * The rejected alternative, from the backlog entry: the API's sender calling `createQueue` with
 * default options on a miss. A queue's options (retry, expiry, policy) would then depend on which
 * process booted first, and `create_queue` never updates an existing row.
 *
 * **What keeps it the only place**: `packages/application/src/ports/job-queues.test.ts` reads every
 * source file git knows about and fails on a `defineQueue(` call whose argument is not
 * `jobQueueDefinition(…)` outside the adapters that implement the port (criterion 2).
 *
 * Declaration is **create-if-absent** (the port's contract): editing a row here does not change a
 * queue that already exists in a database. Changing a live queue's options is a deliberate migration.
 */
import { JOB_QUEUES, type JobQueueDefinition, type Jobs } from './jobs.js';

/**
 * `pipeline.outbound`'s retry policy, named so that the one number derived from it cannot drift
 * from it (WP-65): `retryWindowMs` is what the `notifications_undelivered` gauge waits before it
 * counts an immediate notification nobody was told about.
 */
export const PIPELINE_OUTBOUND_RETRY = {
  retryLimit: 2,
  retryDelaySeconds: 30,
  retryBackoff: true,
} as const;

/**
 * How often a `pipeline.outbound` worker looks for its next job — **its own interval, shorter than
 * every other queue's** (WP-124, PROGRESS backlog **392**, TD-004's M7 amendment).
 *
 * A worker registered with `batchSize: 1` takes one job per polling interval even with a backlog,
 * and `pipeline.outbound` is the queue a burst lands on: every intake, status, workpad and
 * notification of every project, at one worker per process. Measured at the shipped 2 s on one
 * `ROLE=all` process: 20 intakes for one project took 38.9 s to admit and 50 took 98.9 s, a second
 * project's one intake waited behind them (40.9 s, 101.0 s), and at 50 the intake reconciler,
 * whose grace is its 60 s interval, re-emitted 21 matches whose intake jobs were still queued
 * (load 3.4–5.3; the table is under backlog 392). pg-boss's burst trigger was tried first, as the
 * ruling asked, and changed nothing (`pgBossWorkOptions` in the pg-boss adapter says why).
 *
 * `0.5` is pg-boss 12.30.0's floor (`pollingIntervalSeconds` must be ≥ 0.5, `JobPollingOptions`).
 * What it costs: an idle process fetches this queue twice a second rather than once every two
 * seconds — one indexed `update … returning` on the queue's job partition, **not measured on a
 * large job table**. Every other queue keeps `APP_JOBS_POLL_INTERVAL_SECONDS`.
 */
export const PIPELINE_OUTBOUND_POLLING_INTERVAL_SECONDS = 0.5;

/**
 * `notify.digest`'s retry policy, named for the reason {@link PIPELINE_OUTBOUND_RETRY} is: the
 * undelivered gauge derives how long a digest row may legitimately wait from it (WP-65).
 */
export const DIGEST_RETRY = {
  retryLimit: 2,
  retryDelaySeconds: 60,
  retryBackoff: true,
} as const;

/**
 * The table. Order matters only for a dead-letter queue, which must exist before the queue that
 * names it; no row names one today, and `job-queues.test.ts` refuses a row whose dead-letter queue
 * is not declared above it.
 */
export const JOB_QUEUE_DEFINITIONS: readonly JobQueueDefinition[] = [
  {
    name: JOB_QUEUES.stageExecute,
    // TD-004: `stately` per task — at most one queued and one active, so a task never runs two
    // stages at once and a burst of wake-ups collapses.
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
    // A stage is a whole agent run: minutes, not the 15-minute default.
    expireInSeconds: 2 * 60 * 60,
  },
  { name: JOB_QUEUES.mrCommentDebounce, policy: 'stately', retryLimit: 2, retryDelaySeconds: 30 },
  {
    name: JOB_QUEUES.pipelineOutbound,
    // `standard`, not `stately`: see `JOB_QUEUES.pipelineOutbound`. A dropped wake-up would take
    // the event's blocker brief with it, and that is the one thing a render cannot re-derive.
    policy: 'standard',
    ...PIPELINE_OUTBOUND_RETRY,
  },
  {
    name: JOB_QUEUES.deadlineSweep,
    // `stately` per key: see `JOB_QUEUES.deadlineSweep`.
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
  },
  {
    name: JOB_QUEUES.intakeReconcile,
    // `stately`, so the pass that is running may enqueue the next one — the reasoning is at
    // `declareIntakeReconcileQueue` (`pipeline/intake-reconcile.ts`).
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
  },
  {
    name: JOB_QUEUES.ticketPoll,
    // `stately` per `binding:<project>:<integration>` (and one `sweep` key): see `JOB_QUEUES.ticketPoll`.
    policy: 'stately',
    // No retry: a poll that threw has already armed the next one (`pipeline/ticket-poll.ts` re-arms
    // in a `finally`), so a pg-boss retry would be a second poll of the same window.
    retryLimit: 0,
    // One provider read and a handful of one-row transactions; five minutes is generous.
    expireInSeconds: 5 * 60,
  },
  {
    name: JOB_QUEUES.mrPoll,
    // WP-110: `ticket.poll`'s policy, for its reasons (`pipeline/mr-poll.ts` re-arms in a `finally`).
    policy: 'stately',
    retryLimit: 0,
    expireInSeconds: 5 * 60,
  },
  {
    name: JOB_QUEUES.taskAsk,
    // `stately` per `ask:<id>` — see the queue's own docblock for why the key is the ask and not
    // the task.
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
    // An ask is a run: minutes, not the 15-minute default. Shorter than `stage.execute`'s two hours
    // because its turn limit is 12 and its cap is half a dollar.
    expireInSeconds: 30 * 60,
  },
  {
    name: JOB_QUEUES.knowledgeIndex,
    // `stately` is the only policy that both collapses a burst and keeps the trailing wake-up a
    // re-read needs (`knowledge/index-job.ts`'s header).
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: true,
    // A first index clones the repository, which is a network operation against a monorepo in the
    // worst case; the 15-minute default would declare that job lost while git was still working.
    expireInSeconds: 60 * 60,
  },
  {
    name: JOB_QUEUES.knowledgeProposals,
    // `stately` per **artifact** since WP-48 — see `enqueueCuration` for why the key is what makes
    // that safe, and `JOB_QUEUES.knowledgeProposals` for what it used to be.
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
  },
  {
    name: JOB_QUEUES.knowledgeApply,
    policy: 'stately',
    retryLimit: 2,
    retryDelaySeconds: 60,
    retryBackoff: true,
    // Two provider round trips against somebody else's instance; the 15-minute default is enough,
    // and this states it rather than inheriting it silently.
    expireInSeconds: 15 * 60,
  },
  {
    name: JOB_QUEUES.knowledgeHygiene,
    // `stately`: one pass at a time for the whole deployment, and a second schedule tick while one
    // is running folds onto a single trailing job rather than queueing N nightly passes.
    policy: 'stately',
    retryLimit: 1,
    retryDelaySeconds: 300,
    expireInSeconds: 30 * 60,
  },
  {
    name: JOB_QUEUES.discoveryRecord,
    // `standard`: every wake-up carries a different artifact (see `JOB_QUEUES.discoveryRecord`).
    policy: 'standard',
    retryLimit: 2,
    retryDelaySeconds: 30,
    retryBackoff: true,
  },
  {
    name: JOB_QUEUES.historyBootstrap,
    // `standard`: every wake-up carries a different batch or a different artifact.
    policy: 'standard',
    retryLimit: 2,
    // Longer than the knowledge jobs' 30 s: a retry of `collect` re-reads the provider, and a
    // failure there is usually a rate limit or an outage that a few seconds will not have cleared.
    retryDelaySeconds: 60,
    retryBackoff: true,
  },
  {
    name: JOB_QUEUES.notifyDigest,
    // `exclusive` because two overlapping ticks would both claim rows for the same day; the claim
    // and the idempotency key are the second and third lines of defence, not the first.
    policy: 'exclusive',
    ...DIGEST_RETRY,
  },
  {
    name: JOB_QUEUES.maintenanceSchedule,
    policy: 'exclusive',
    retryLimit: 1,
    retryDelaySeconds: 300,
    expireInSeconds: 15 * 60,
  },
  {
    name: JOB_QUEUES.priceListMaintenance,
    // `exclusive` keeps two replicas from running one pass twice.
    policy: 'exclusive',
    retryLimit: 2,
    retryDelaySeconds: 300,
  },
  {
    name: JOB_QUEUES.partitionMaintenance,
    policy: 'exclusive',
    retryLimit: 2,
    retryDelaySeconds: 300,
    // Creating a year of partitions on a large instance is slow; the default 15 minutes is plenty
    // but the retention drop is the part that must never be interrupted half-way.
    expireInSeconds: 900,
  },
];

/** Raised for a queue name the table does not carry — a programming error, never a runtime state. */
export class UnknownJobQueueError extends Error {
  override readonly name = 'UnknownJobQueueError';
  readonly queue: string;

  constructor(queue: string) {
    super(
      `the job queue ${JSON.stringify(queue)} is not in JOB_QUEUE_DEFINITIONS (packages/application/src/ports/job-queues.ts): every queue is declared from that table, so migrate can declare it before any worker starts`,
    );
    this.queue = queue;
  }
}

/** The table's row for `name`. Throws {@link UnknownJobQueueError} for a queue it does not carry. */
export const jobQueueDefinition = (name: string): JobQueueDefinition => {
  const definition = JOB_QUEUE_DEFINITIONS.find((row) => row.name === name);
  if (definition === undefined) {
    throw new UnknownJobQueueError(name);
  }
  return definition;
};

/**
 * Declares every row, in order. What `migrate` runs; idempotent, so a second `migrate` — or two at
 * once, which the migration advisory lock serialises anyway — declares nothing new.
 */
export const declareJobQueues = async (
  jobs: Pick<Jobs, 'defineQueue'>,
  definitions: readonly JobQueueDefinition[] = JOB_QUEUE_DEFINITIONS,
): Promise<readonly string[]> => {
  for (const definition of definitions) {
    await jobs.defineQueue(definition);
  }
  return definitions.map((definition) => definition.name);
};
