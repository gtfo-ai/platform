/**
 * **Bound and escalate** — the last try of a job a person waits on escalates its task before the
 * throw ends the job (WP-124, TD-004's M7 amendment, PROGRESS backlog **366**).
 *
 * `stage.execute` has had this shape since WP-15g: a run that could not start is retried on its own
 * bound and the task is escalated at the end of it. The jobs below had no bound of their own: they
 * threw into pg-boss's retry policy, and the policy's exhaustion was a `failed` row an administrator
 * could list (WP-108) and nobody on the task was told about. For the queues and duties
 * `ports/job-exhaustion.ts` declares **`bound_and_escalate`** — `mr.comment.debounce` and the
 * `pipeline.outbound` duties a person waits on — the handler is wrapped so that a throw on the
 * **last** try (`isLastTry`, pg-boss's own `retry_count` against `retry_limit`) first escalates the
 * task with a brief, and is **then** rethrown, so the job still ends `failed` and stays on the
 * administrator's list with the census row beside it.
 *
 * ## The three endings, by the task's state
 *
 *  - **a task that can still escalate** (active, waiting, returned, paused, `ready_for_merge`,
 *    merged, retro) is escalated to `needs_human`, its open stage row closed with the outcome
 *    `escalated`, through `retryOnTaskConflict` like every job-side task write (WP-15e);
 *  - **a task already in `needs_human`** gets the brief **added** (`amendEscalation`): the state
 *    does not move, and every reader of the brief sees it;
 *  - **a finished task** (`done`, `cancelled`) cannot escalate: `TASK_TRANSITIONS.done` is empty,
 *    and a review-only, lint or last-child breakdown task is usually `done` by the time its duty
 *    runs. So its people are told the brief through the notification band instead — one `notify`
 *    duty of class `escalation`, keyed by the failed job's own cause event — which is
 *    OPEN-QUESTIONS **Q113**'s recommendation, implemented. A project with no chat binding hears
 *    nothing more than the log line and the failed-jobs list, and that residual is the question's.
 *
 * ## What the brief says, and what it never says
 *
 * Platform text only: what the job was for, how many tries it had, and what a person can do. The
 * failure's **message is not in it** — it can quote a provider, a URL or a credential, it is
 * already on the administrator's list redacted and bounded, and a brief is posted into chat and
 * rendered on the task page. The ticket key is the one piece of provider text, as in every other
 * brief the pipeline writes.
 *
 * ## What it does not do
 *
 * It does not retry: the job's own retries are spent, and the escalation is the ending. An
 * escalation that itself fails (a database outage) is logged and the original failure is rethrown
 * unchanged, so the failed job is still listed — the same "one ending left" `escalateTaskAfterConflict`
 * accepts. A job with no task (`intake_check`, the organisation's notification) cannot take this
 * shape at all, which is why none of them is declared with it.
 */
import type { Id } from '@platform/contracts';
import type { CommandContext } from '@platform/domain';
import { amendEscalation, escalateTask, IllegalTransitionError } from '@platform/domain';
import type { JobContext, Jobs } from '../ports/jobs.js';
import { isLastTry, JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import type { PipelineOutboundData } from './jobs.js';
import { PIPELINE_ACTOR, type PipelineStore } from './store.js';
import { retryOnTaskConflict } from './task-conflict.js';
import { closeParkedStageRow } from './transitions.js';

export interface ExhaustedJobEscalationOptions {
  readonly unitOfWork: UnitOfWork;
  readonly store: PipelineStore;
  readonly jobs: Jobs;
  readonly ids: CommandContext['ids'];
  readonly clock: { now(): string };
  readonly logger?: Logger;
}

/** What failed, for the brief: platform words for the job, and what a person can do about it. */
export interface ExhaustedJob {
  readonly taskId: Id;
  readonly projectId: Id;
  readonly queue: string;
  /** The `pipeline.outbound` duty, or `null` for a queue whose jobs have one purpose. */
  readonly duty: string | null;
  /** The first try plus every retry. */
  readonly tries: number;
  /** The event that caused the job, which keys the notification for a finished task. */
  readonly causeEventId: Id | null;
  /** Platform text: what the job was for, as a clause ("post the review on merge request !12"). */
  readonly what: string;
  /** Platform text: what a person can do now. */
  readonly remedy: string;
}

export type ExhaustedJobEnding = 'escalated' | 'amended' | 'notified' | 'unreachable' | 'absent';

const reasonFor = (job: ExhaustedJob): string =>
  `${job.duty ?? job.queue} failed on all ${job.tries} tries`;

const briefFor = (job: ExhaustedJob, ticketKey: string): string =>
  `The platform could not ${job.what} for ${ticketKey}: the ${job.duty === null ? job.queue : `"${job.duty}"`} ` +
  `job failed on all ${job.tries} of its tries, and nothing tries it again. ${job.remedy} ` +
  'The failure itself is on the organisation’s failed-jobs list (Settings), for an administrator.';

/**
 * Escalates the task of a job whose last try failed; answers which of the endings it took. Never
 * throws for the task's state; a database failure escapes to the caller, which logs it and rethrows
 * the job's own error.
 */
export const escalateExhaustedJob = async (
  options: ExhaustedJobEscalationOptions,
  job: ExhaustedJob,
): Promise<ExhaustedJobEnding> =>
  escalateTaskWithBrief(options, {
    taskId: job.taskId,
    projectId: job.projectId,
    causeEventId: job.causeEventId,
    reason: reasonFor(job),
    brief: (ticketKey) => briefFor(job, ticketKey),
    what: job.duty ?? job.queue,
  });

/**
 * The ending itself, for any caller with a brief to give — the bound-and-escalate jobs above and
 * the recovery rows whose ending is an escalation (`recovery/discovery-record.ts`). `brief` is
 * handed the task's ticket key, the one piece of provider text a brief carries.
 */
export const escalateTaskWithBrief = async (
  options: ExhaustedJobEscalationOptions,
  input: {
    readonly taskId: Id;
    readonly projectId: Id;
    readonly causeEventId: Id | null;
    /** Platform text: the escalation's one-line reason. */
    readonly reason: string;
    readonly brief: (ticketKey: string) => string;
    /** For the log lines: which job or row is escalating. */
    readonly what?: string;
  },
): Promise<ExhaustedJobEnding> => {
  const logger = options.logger ?? silentLogger;
  const context = (): CommandContext => ({
    ids: options.ids,
    actor: PIPELINE_ACTOR,
    clock: options.clock as CommandContext['clock'],
    correlationId: input.taskId,
    causeEventId: input.causeEventId,
  });
  const outcome = await retryOnTaskConflict(
    {
      taskId: input.taskId,
      what: `escalating: ${input.reason}`,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    },
    async () =>
      options.unitOfWork.transaction(
        async (scope): Promise<{ ending: ExhaustedJobEnding; brief: string | null }> => {
          const stored = await options.store.tasks.load(scope.tx, input.taskId);
          if (stored === null) {
            return { ending: 'absent', brief: null };
          }
          const brief = input.brief(stored.task.ticket.key);
          const escalation = { reason: input.reason, blockerBrief: brief };
          if (stored.task.state === 'needs_human') {
            const amended = amendEscalation(stored.task, escalation, context());
            await options.store.tasks.save(scope.tx, { ...stored, task: amended.aggregate });
            await scope.events.append(amended.events);
            return { ending: 'amended', brief };
          }
          try {
            const escalated = escalateTask(stored.task, escalation, context());
            await options.store.tasks.save(scope.tx, { ...stored, task: escalated.aggregate });
            await closeParkedStageRow(options.store, scope.tx, escalated, 'escalated');
            await scope.events.append(escalated.events);
            return { ending: 'escalated', brief };
          } catch (error) {
            if (error instanceof IllegalTransitionError) {
              return { ending: 'unreachable', brief };
            }
            throw error;
          }
        },
      ),
  );
  if (outcome.ending !== 'unreachable' || outcome.brief === null) {
    return outcome.ending;
  }
  // A finished task: no edge to `needs_human` (Q113). Tell its people instead, after the read
  // committed — the notify duty calls a provider, so never from inside a transaction (WP-15d).
  if (input.causeEventId === null) {
    logger.error(
      { task_id: input.taskId, what: input.what ?? null },
      'a task a person waits on has finished and cannot be escalated, and nothing names an event to notify by; only the log and the failed-jobs list say so',
    );
    return 'unreachable';
  }
  // `enqueueOutbound`'s request, spelled here so this module and `jobs.ts` do not import each other.
  const notify: PipelineOutboundData = {
    duty: 'notify',
    project_id: input.projectId,
    task_id: input.taskId,
    cause_event_id: input.causeEventId,
    notification_class: 'escalation',
    notification_detail: outcome.brief,
  };
  await options.jobs.enqueue({ queue: JOB_QUEUES.pipelineOutbound, data: notify });
  return 'notified';
};

/**
 * Wraps a handler so its **last** try escalates before the throw ends the job; every earlier try's
 * throw goes to the retry policy untouched. `describe` answers `null` for a job that carries no
 * task or is not of a bound-and-escalate shape, and the throw then passes through unchanged.
 */
export const escalatingOnLastTry =
  <TData extends JobContext['data']>(
    options: ExhaustedJobEscalationOptions,
    handler: (job: JobContext<TData>) => Promise<void>,
    describe: (job: JobContext<TData>) => Omit<ExhaustedJob, 'tries'> | null,
  ) =>
  async (job: JobContext<TData>): Promise<void> => {
    try {
      await handler(job);
    } catch (error) {
      const exhausted = isLastTry(job) ? describe(job) : null;
      if (exhausted !== null) {
        const tries = (job.retries?.count ?? 0) + 1;
        try {
          const ending = await escalateExhaustedJob(options, { ...exhausted, tries });
          (options.logger ?? silentLogger).warn(
            {
              task_id: exhausted.taskId,
              queue: exhausted.queue,
              duty: exhausted.duty,
              tries,
              ending,
            },
            'a job a person waits on failed on its last try, so its task was escalated with a brief (TD-004’s M7 amendment, PROGRESS backlog 366)',
          );
        } catch (escalationError) {
          (options.logger ?? silentLogger).error(
            { task_id: exhausted.taskId, queue: exhausted.queue, err: escalationError },
            'a job failed on its last try and escalating its task failed too; the failed job is still listed',
          );
        }
      }
      throw error;
    }
  };
