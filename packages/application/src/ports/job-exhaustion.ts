/**
 * **What a job that spent its retries leaves behind, per queue** — the census PROGRESS backlog
 * **325** asked for (WP-108).
 *
 * A job whose handler throws is retried by pg-boss up to its queue's `retryLimit`
 * (`./job-queues.ts`), and then moves to pg-boss's `failed` state, where until WP-108 no screen, no
 * count and no audit row showed it. Three pipeline sites already said so of themselves
 * (`pipeline/jobs.ts`, `pipeline/stage-executor.ts`: *"a dead letter no screen shows"*) and bound
 * their own failures instead; nobody had enumerated the rest. This table is that enumeration: every
 * declared queue, which of the two kinds it is, and what its exhaustion costs.
 *
 *  - **`bounds_itself`** — the handler ends its own failures (escalates the task, records the row's
 *    ending, or re-arms itself), so pg-boss's retry exhaustion is not how a failure ends. A throw it
 *    did not anticipate still reaches pg-boss, and `residual` says what that leaves.
 *  - **`relies_on_retries`** — the handler throws into pg-boss's retry policy, and the policy's
 *    exhaustion is the ending. `loss` says what a failed job drops; `recoveredBy` names the row of
 *    `recovery/stranded.ts`'s table (or the next tick) that finds what it left, or `null` when
 *    nothing does.
 *
 * **The decision this census made** (WP-108, criterion 3): the second kind is the majority, and its
 * largest member — `pipeline.outbound`, twenty-six duties, most of them provider writes — cannot
 * take `stage.execute`'s bound-and-escalate shape one duty at a time without rewriting the band. So
 * an **admin read of pg-boss's failed jobs** sits beside the dead-letter list
 * (`GET /api/org/failed-jobs`): queue, attempts, the last error redacted and bounded, and this
 * table's row, **never the payload**. It has no re-queue: TD-004 says every job re-validates on fire,
 * but nobody has shown it for all of them (backlog 325's condition for one), so a retry is the
 * recovery row's or the human's.
 *
 * **What keeps this table whole**: `./job-exhaustion.test.ts` compares its keys with
 * `JOB_QUEUE_DEFINITIONS`' names in both directions (standing rule 7 — the registered set, not a
 * list carried beside it), so a new queue fails the build until somebody classifies it.
 */
import { JOB_QUEUES } from './jobs.js';

export type JobExhaustionKind = 'bounds_itself' | 'relies_on_retries';

export interface JobExhaustion {
  readonly kind: JobExhaustionKind;
  /** What a job of this queue that spent every retry drops. */
  readonly loss: string;
  /**
   * The recovery that finds what it left: a `recovery/stranded.ts` site name, `next_tick` for a
   * schedule whose next run redoes the work, or `null` when nothing does.
   */
  readonly recoveredBy: string | null;
  /** For `bounds_itself`: what an unanticipated throw still leaves. */
  readonly residual?: string;
}

/** Keyed by queue name; held equal to `JOB_QUEUE_DEFINITIONS` by the census test. */
export const JOB_EXHAUSTION: Readonly<Record<string, JobExhaustion>> = {
  [JOB_QUEUES.stageExecute]: {
    kind: 'bounds_itself',
    loss: 'a stage run: a transport failure to start is re-enqueued on its own bound (MAX_RUN_START_ATTEMPTS) and a write that loses every race escalates the task',
    recoveredBy: 'stranded_stage',
    residual:
      'an unanticipated throw is retried by pg-boss; a job that spends its retries leaves the task at its stage with no job, which the stranded_stage row re-enqueues once and then escalates (WP-108)',
  },
  [JOB_QUEUES.mrCommentDebounce]: {
    kind: 'relies_on_retries',
    loss: 'one review-comment window: the merge request’s comments are not turned into a return, and the task stays ready_for_merge until the next comment opens a window',
    recoveredBy: null,
  },
  [JOB_QUEUES.pipelineOutbound]: {
    kind: 'relies_on_retries',
    loss: 'one provider call the pipeline decided on — a ticket status, a workpad, a comment, a notification, a merge request close, a credential revoke',
    recoveredBy:
      'notification_repost (notify), superseded_mr (close_superseded_mr), run_credential (revoke_run_credential), deferred_dependency (dependency_gate_resume), intake reconcile (intake_check); the other duties are not recovered',
  },
  [JOB_QUEUES.deadlineSweep]: {
    kind: 'relies_on_retries',
    loss: 'one expiry or reminder of a question, approval or take-over',
    recoveredBy: 'deadline, deadline_reminder',
  },
  [JOB_QUEUES.intakeReconcile]: {
    kind: 'bounds_itself',
    loss: 'one recovery pass',
    recoveredBy: 'next_tick',
    residual:
      'the next pass is enqueued in a finally before the throw reaches pg-boss, and every process start re-establishes the chain',
  },
  [JOB_QUEUES.ticketPoll]: {
    kind: 'bounds_itself',
    loss: 'one poll of one binding',
    recoveredBy: 'next_tick',
    residual:
      'retryLimit 0: a poll that throws has already re-armed itself, and the sweep re-arms a chain that was lost',
  },
  [JOB_QUEUES.taskAsk]: {
    kind: 'relies_on_retries',
    loss: 'one ask-the-task question’s run',
    recoveredBy: 'task_ask, task_ask_run',
  },
  [JOB_QUEUES.knowledgeIndex]: {
    kind: 'relies_on_retries',
    loss: 'one index rebuild of a project’s vault (an unreadable vault is reported, not thrown)',
    recoveredBy: 'next_tick',
  },
  [JOB_QUEUES.knowledgeProposals]: {
    kind: 'relies_on_retries',
    loss: 'one artifact’s knowledge proposals',
    recoveredBy: 'knowledge_curation',
  },
  [JOB_QUEUES.knowledgeApply]: {
    kind: 'relies_on_retries',
    loss: 'one knowledge commit and its merge request (a provider write); the approved proposals stay approved and unapplied until another apply is enqueued',
    recoveredBy: null,
  },
  [JOB_QUEUES.knowledgeHygiene]: {
    kind: 'relies_on_retries',
    loss: 'one nightly hygiene pass',
    recoveredBy: 'next_tick',
  },
  [JOB_QUEUES.discoveryRecord]: {
    kind: 'relies_on_retries',
    loss: 'one discovery run’s readiness evaluation and drafted pages, or one readiness re-check',
    recoveredBy: null,
  },
  [JOB_QUEUES.historyBootstrap]: {
    kind: 'relies_on_retries',
    loss: 'one bootstrap collection or one mining run’s findings',
    recoveredBy: 'history_bootstrap, history_record',
  },
  [JOB_QUEUES.notifyDigest]: {
    kind: 'relies_on_retries',
    loss: 'one day’s digest post (a provider write); its rows stay undelivered and counted by the gauge',
    recoveredBy: null,
  },
  [JOB_QUEUES.maintenanceSchedule]: {
    kind: 'relies_on_retries',
    loss: 'one daily maintenance pass',
    recoveredBy: 'next_tick',
  },
  [JOB_QUEUES.priceListMaintenance]: {
    kind: 'relies_on_retries',
    loss: 'one pass over the price table',
    recoveredBy: 'next_tick',
  },
  [JOB_QUEUES.partitionMaintenance]: {
    kind: 'relies_on_retries',
    loss: 'one partition creation and retention pass (partitions are created months ahead)',
    recoveredBy: 'next_tick',
  },
};

/** The census row of a queue, or `null` for a queue this build does not declare. */
export const jobExhaustionOf = (queue: string): JobExhaustion | null =>
  Object.hasOwn(JOB_EXHAUSTION, queue) ? (JOB_EXHAUSTION[queue] as JobExhaustion) : null;
