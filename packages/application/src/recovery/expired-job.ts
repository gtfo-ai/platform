/**
 * The last try that **expired** instead of throwing — a row of `./stranded.ts`'s table (WP-156
 * ruling (c), TD-004's M7 amendment, PROGRESS backlog **421**).
 *
 * ## What is lost
 *
 * A bound-and-escalate job — `mr.comment.debounce`, and the `pipeline.outbound` duties a person
 * waits on (`ports/job-exhaustion.ts`) — escalates its task from **inside** its handler when its
 * last try throws (`pipeline/job-escalation.ts`'s `escalatingOnLastTry`). A last try that runs past
 * its queue's `expireInSeconds` never throws. Measured at WP-156 against pg-boss 12.30.0
 * (`test/integration/jobs/job-expiry.integration.test.ts`), it is failed by one of two writers:
 *
 *  - **the worker's own timer**, which races the handler: pg-boss fails the job with a serialised
 *    `Error` whose message is `handler execution exceeded <n>s` **while the handler is still
 *    running** — the wrapper sits inside the race and sees nothing;
 *  - **the supervisor**, for a job whose process stopped: `failJobsByTimeout` writes the fixed
 *    output `{"value": {"message": "job timed out"}}` (and `job heartbeat timeout` for a heartbeat,
 *    which no platform queue sets).
 *
 * Either way the row is the `failed` row a thrown last try leaves — listed on the failed-jobs read
 * since WP-108 — and **only `output` tells the two apart**. So the task a person waits on was never
 * escalated: a policy gate that never ran, a resume that did nothing, a review never posted.
 *
 * ## The predicate (the store's)
 *
 *  - a pg-boss job of a {@link expiredJobTargets} queue (and, for `pipeline.outbound`, one of its
 *    bound-and-escalate duties, read off the payload's `duty`), in state `failed` with every retry
 *    spent (`retry_count >= retry_limit`);
 *  - whose `output` is one of the two expiry signatures above — never a thrown error's, which the
 *    wrapper already escalated (rule 42: the store's test holds both sides);
 *  - failed after `notBefore` ({@link EXPIRED_JOB_HORIZON_MS} back) and before the pass's grace;
 *  - with **no mark** in `expired_job_escalations` (migration 0087).
 *
 * ## What it does: once per job id, and no retry
 *
 * The **mark** — one `expired_job_escalations` row for the job id, `on conflict do nothing` — is
 * committed first, in a transaction of its own, and only a pass that inserted it escalates (the
 * table's safe order, `runAttemptOrEndSite`: a crash between the two costs the escalation, never
 * repeats it, and two processes running the pass cannot both win). The escalation is
 * `escalateExhaustedJob`'s — the wrapper's own three endings (escalate, amend a task already in
 * `needs_human`, or tell a finished task's people, Q113) — with a brief that says the job ran past
 * its limit rather than that it failed. It does **not** re-enqueue the job: an expired provider
 * call may have landed (the measured live case keeps running after pg-boss gave up on it), and a
 * second post is worse than a person reading a brief.
 *
 * ## What it does not reach
 *
 *  - **`stage.execute`** is bound-and-escalate too, and its expiry is recovered elsewhere: the run
 *    the stage started is ended by the `run_lease` row once nothing renews its lease, and a stage
 *    left with no job and no run is the `stranded_stage` row's ({@link EXPIRY_RECOVERED_ELSEWHERE}).
 *  - **A handler that outlives pg-boss's timer and then throws** escalates a second time from the
 *    wrapper, which is unchanged for a thrown last try (ruling (c)); the task is then already in
 *    `needs_human`, so that second escalation **amends** the brief and moves nothing.
 *  - A job that failed more than a day before the pass ran (a fleet that was down, or the first
 *    pass after an upgrade) is left on the failed-jobs list: escalating a task about a job from last
 *    week would be about a state the task has long left.
 */
import { type Id, type IsoDateTime, idSchema } from '@platform/contracts';
import {
  type ExhaustedJob,
  type ExhaustedJobEnding,
  type ExhaustedJobEscalationOptions,
  escalateExhaustedJob,
} from '../pipeline/job-escalation.js';
import type { OutboundJobData, ReviewWindowData } from '../pipeline/jobs.js';
import { describeExhaustedReviewWindow } from '../pipeline/jobs.js';
import { describeExhaustedOutbound } from '../pipeline/outbound.js';
import { type BoundAndEscalateTarget, boundAndEscalateTargets } from '../ports/job-exhaustion.js';
import type { Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';

/**
 * How far back the pass reads, from its own clock. A pass runs every interval (a minute on the
 * shipped defaults), so a job that expired is read within minutes; the day only matters after an
 * outage or an upgrade, where it keeps a week-old failure from escalating a task that has moved on.
 */
export const EXPIRED_JOB_HORIZON_MS = 24 * 60 * 60_000;

/**
 * Bound-and-escalate queues whose expiry another row of the table already recovers, and which.
 * Held to {@link boundAndEscalateTargets} by `expired-job.test.ts`, so a new bound-and-escalate
 * queue is either read here or named here.
 */
export const EXPIRY_RECOVERED_ELSEWHERE: Readonly<Record<string, string>> = {
  [JOB_QUEUES.stageExecute]: 'run_lease, stranded_stage',
};

/** The queues and duties this row reads: every bound-and-escalate target not recovered elsewhere. */
export const expiredJobTargets = (): readonly BoundAndEscalateTarget[] =>
  boundAndEscalateTargets().filter(
    (target) => !Object.hasOwn(EXPIRY_RECOVERED_ELSEWHERE, target.queue),
  );

/** Which of pg-boss's two writers failed the job — measured at WP-156. */
export type ExpiryWriter = 'worker_timer' | 'supervisor';

/** A bound-and-escalate job whose last try expired, as the store reads it off pg-boss's table. */
export interface ExpiredJob {
  readonly jobId: Id;
  readonly queue: string;
  /** The job's payload, unparsed: {@link describeExpiredJob} reads what it needs and refuses the rest. */
  readonly data: unknown;
  /** `retry_count + 1`: the first try and every retry. */
  readonly tries: number;
  readonly expireSeconds: number;
  readonly failedAt: IsoDateTime;
  readonly writer: ExpiryWriter;
}

export interface ExpiredJobQuery {
  /** A job failed after this is still inside the pass's grace and is left for the next pass. */
  readonly olderThan: IsoDateTime;
  /** A job failed before this is past {@link EXPIRED_JOB_HORIZON_MS} and is never read. */
  readonly notBefore: IsoDateTime;
  readonly targets: readonly BoundAndEscalateTarget[];
  readonly limit: number;
}

export interface ExpiredJobRecoveryStore {
  /** The module docblock's predicate, oldest failure first, at most `limit`. */
  expiredJobs(tx: Transaction, query: ExpiredJobQuery): Promise<readonly ExpiredJob[]>;
  /**
   * Inserts the job's mark; answers whether **this** call inserted it. `false` is a job another
   * pass already took, and nothing is escalated for it.
   */
  markExpiredJob(
    tx: Transaction,
    input: {
      readonly jobId: Id;
      readonly queue: string;
      readonly taskId: Id | null;
      readonly at: IsoDateTime;
    },
  ): Promise<boolean>;
}

export interface ExpiredJobRecoverySite {
  readonly store: ExpiredJobRecoveryStore;
  /** What the ending escalates through (`pipeline/job-escalation.ts`). */
  readonly escalation: Omit<ExhaustedJobEscalationOptions, 'jobs' | 'unitOfWork' | 'logger'>;
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * The brief's description of an expired job, from its payload — the same words its wrapper would
 * have used for a thrown last try, or `null` for a payload that names no task (or a queue this row
 * does not read). The payload is the platform's own, but it is read back from a table, so it is
 * checked rather than cast.
 */
export const describeExpiredJob = (job: ExpiredJob): Omit<ExhaustedJob, 'tries'> | null => {
  const { data } = job;
  if (
    !isRecord(data) ||
    !idSchema.safeParse(data.task_id).success ||
    !idSchema.safeParse(data.project_id).success
  ) {
    return null;
  }
  if (job.queue === JOB_QUEUES.pipelineOutbound) {
    return typeof data.duty === 'string'
      ? describeExhaustedOutbound(data as unknown as OutboundJobData)
      : null;
  }
  if (job.queue === JOB_QUEUES.mrCommentDebounce) {
    return Number.isSafeInteger(data.iid)
      ? describeExhaustedReviewWindow(data as unknown as ReviewWindowData)
      : null;
  }
  return null;
};

export interface ExpiredJobRecoveryReport {
  readonly site: 'expired_job';
  readonly found: number;
  /** Always 0: an expired call may have landed, so nothing is re-enqueued. */
  readonly reEnqueued: number;
  /** Jobs whose task this pass escalated, amended or notified. */
  readonly ended: number;
}

/** Marks, then escalates, once per job id. */
export const recoverExpiredJobs = async (
  options: { readonly unitOfWork: UnitOfWork; readonly jobs: Jobs; readonly logger?: Logger },
  site: ExpiredJobRecoverySite,
  rows: readonly ExpiredJob[],
  now: IsoDateTime,
): Promise<ExpiredJobRecoveryReport> => {
  const logger = options.logger ?? silentLogger;
  let ended = 0;
  for (const row of rows) {
    const described = describeExpiredJob(row);
    const fields = {
      job_id: row.jobId,
      queue: row.queue,
      writer: row.writer,
      tries: row.tries,
      expire_seconds: row.expireSeconds,
      task_id: described?.taskId ?? null,
    };
    // The mark first, in its own transaction; only the pass that inserted it acts.
    const marked = await options.unitOfWork.transaction(async (scope) =>
      site.store.markExpiredJob(scope.tx, {
        jobId: row.jobId,
        queue: row.queue,
        taskId: described?.taskId ?? null,
        at: now,
      }),
    );
    if (!marked) continue;
    if (described === null) {
      // Marked anyway, so a malformed payload is read once rather than at every pass.
      logger.error(
        fields,
        'a bound-and-escalate job’s last try expired, but its payload names no task this build can escalate; only the failed-jobs list shows it (PROGRESS backlog 421)',
      );
      continue;
    }
    let ending: ExhaustedJobEnding;
    try {
      ending = await escalateExhaustedJob(
        {
          ...site.escalation,
          unitOfWork: options.unitOfWork,
          jobs: options.jobs,
          ...(options.logger === undefined ? {} : { logger: options.logger }),
        },
        { ...described, tries: row.tries, expiredAfterSeconds: row.expireSeconds },
      );
    } catch (error) {
      // The mark is committed, so this job is not tried again: the table's one-attempt bound.
      logger.error(
        { ...fields, err: error },
        'a bound-and-escalate job’s last try expired and escalating its task failed; the failed job is still listed, and the pass does not try it again (PROGRESS backlog 421)',
      );
      continue;
    }
    ended += 1;
    logger.warn(
      { ...fields, ending },
      'a job a person waits on ran past its expiry on its last try, which pg-boss fails without the handler throwing, so the recovery pass escalated its task with a brief (TD-004’s M7 amendment, PROGRESS backlog 421)',
    );
  }
  return { site: 'expired_job', found: rows.length, reEnqueued: 0, ended };
};
