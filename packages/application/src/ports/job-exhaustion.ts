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
 * **The decision this census made at WP-108** (criterion 3) was an **admin read of pg-boss's failed
 * jobs** beside the dead-letter list (`GET /api/org/failed-jobs`): queue, attempts, the last error
 * redacted and bounded, and this table's row, **never the payload**. It has no re-queue, and still
 * has none in 0.1 (TD-004's M7 amendment): TD-004 says every job re-validates on fire, but nobody
 * has shown it for all of them (backlog 325's condition for one). WP-108 judged that
 * `pipeline.outbound`'s duties could not take `stage.execute`'s bound-and-escalate shape one at a
 * time without rewriting the band; WP-124 gave it to the duties a human waits on through one
 * wrapper around the band's dispatch rather than a rewrite, and declared the rest.
 *
 * **Every queue declares a shape since WP-124** (TD-004's M7 amendment, PROGRESS backlog **366**),
 * and the shape is the column a reader acts on:
 *
 *  - **`recovery_row`** — the lost effect has a database trace, and a row of `recovery/stranded.ts`'s
 *    table finds it, re-enqueues it once under a mark and then makes it visible (`recoveredBy`
 *    names the row). `knowledge.apply` and `onboarding.discovery` gained theirs at WP-124.
 *  - **`bound_and_escalate`** — `stage.execute`'s shape: the job carries a task and a human waits
 *    on its effect, so its **last** try escalates the task with a brief before the throw ends the
 *    job (`pipeline/job-escalation.ts`). `mr.comment.debounce` and six `pipeline.outbound` duties
 *    gained it at WP-124. **A last try that expires is the other ending** (WP-156, PROGRESS backlog
 *    421): pg-boss fails it without the handler throwing — from the worker's own timer or from the
 *    supervisor, measured in `test/integration/jobs/job-expiry.integration.test.ts` — so the
 *    wrapper never runs, and the `expired_job` row of `recovery/stranded.ts`'s table escalates
 *    the task instead, once per job id ({@link boundAndEscalateTargets} is what it reads). Every
 *    such queue declares its `expireInSeconds` (`./job-queues.ts`), held by the census test.
 *  - **`notification_shaped`** — listed only: the next transition (or the next tick) re-derives the
 *    effect, or what is lost is a notification (rule 20). The workpad, the status and
 *    `notify.digest` are the ruling's examples.
 *
 * `pipeline.outbound` carries thirty-seven duties of all three shapes since WP-179 (this sentence said
 * thirty-two through three additions), so it is the one queue whose
 * shape is **`per_duty`**: {@link OUTBOUND_DUTY_EXHAUSTION} declares each, and it is typed as a
 * record over the duty union, so a duty added to `OutboundJobData` without a row fails the build.
 *
 * **What keeps this table whole**: `./job-exhaustion.test.ts` compares its keys with
 * `JOB_QUEUE_DEFINITIONS`' names in both directions (standing rule 7 — the registered set, not a
 * list carried beside it), so a new queue fails the build until somebody classifies it.
 */
import type { OutboundJobData } from '../pipeline/jobs.js';
import { JOB_QUEUES } from './jobs.js';

export type JobExhaustionKind = 'bounds_itself' | 'relies_on_retries';

/** TD-004's M7 amendment: what a queue's exhaustion does about the effect it lost. */
export type JobExhaustionShape = 'recovery_row' | 'bound_and_escalate' | 'notification_shaped';

/** One `pipeline.outbound` duty's declared shape, and the measurement that decided it. */
export interface OutboundDutyExhaustion {
  readonly shape: JobExhaustionShape;
  /**
   * Why this shape — the WP-124 measurement's answer to *"does the next transition re-derive its
   * effect, and does a human wait on it?"* (pasted under PROGRESS backlog 366).
   */
  readonly why: string;
  /** For `recovery_row`: the `recovery/stranded.ts` row (or the reconciler) that finds it. */
  readonly recoveredBy?: string;
}

export interface JobExhaustion {
  readonly kind: JobExhaustionKind;
  /** `per_duty` only for `pipeline.outbound`, whose duties declare their own. */
  readonly shape: JobExhaustionShape | 'per_duty';
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
    shape: 'bound_and_escalate',
    loss: 'a stage run: a transport failure to start is re-enqueued on its own bound (MAX_RUN_START_ATTEMPTS), a gate whose provider does not answer re-asks on its own time bound (backlog 490), and a write that loses every race escalates the task',
    recoveredBy: 'stranded_stage',
    residual:
      'an unanticipated throw is retried by pg-boss; a job that spends its retries leaves the task at its stage with no job, which the stranded_stage row re-enqueues once and then escalates, naming the failed job’s error class and code (WP-108, backlog 490)',
  },
  [JOB_QUEUES.mrCommentDebounce]: {
    kind: 'relies_on_retries',
    shape: 'bound_and_escalate',
    loss: 'one review-comment window: the merge request’s comments are not turned into a return, and the task stays ready_for_merge until the next comment opens a window',
    recoveredBy: null,
    residual:
      'its last try escalates the ready_for_merge task with a brief naming the unanswered review comments (WP-124), so the reviewer’s comments reach a person rather than a log; a last try that expires instead of throwing is escalated by the expired_job recovery row, once per job id (WP-156)',
  },
  [JOB_QUEUES.pipelineOutbound]: {
    kind: 'relies_on_retries',
    shape: 'per_duty',
    loss: 'one provider call the pipeline decided on — a ticket status, a workpad, a comment, a notification, a merge request close, a credential revoke, a Sentry issue resolved on merge',
    recoveredBy:
      'per duty (WP-124): notification_repost (notify, notify_organisation), superseded_mr (close_superseded_mr), run_credential (revoke_run_credential), deferred_dependency (dependency_gate_resume) and the intake reconciler (intake_check) recover theirs; the last try of breakdown_create, review_only_post, ticket_lint_post, spike_report, dependency_gate, mr_pipeline, mr_ready and ready_head_check escalates the task with a brief — from the handler when it throws (WP-124), and from the expired_job recovery row when it expires (WP-156); the rest are re-derived by the next transition or are notifications, and are listed only',
  },
  [JOB_QUEUES.deadlineSweep]: {
    kind: 'relies_on_retries',
    shape: 'recovery_row',
    loss: 'one expiry or reminder of a question, approval or take-over',
    recoveredBy: 'deadline, deadline_reminder',
  },
  [JOB_QUEUES.intakeReconcile]: {
    kind: 'bounds_itself',
    shape: 'notification_shaped',
    loss: 'one recovery pass',
    recoveredBy: 'next_tick',
    residual:
      'the next pass is enqueued in a finally before the throw reaches pg-boss, and every process start re-establishes the chain',
  },
  [JOB_QUEUES.ticketPoll]: {
    kind: 'bounds_itself',
    shape: 'notification_shaped',
    loss: 'one poll of one binding',
    recoveredBy: 'next_tick',
    residual:
      'retryLimit 0: a poll that throws has already re-armed itself, and the sweep re-arms a chain that was lost',
  },
  [JOB_QUEUES.mrPoll]: {
    kind: 'bounds_itself',
    shape: 'notification_shaped',
    loss: 'one merge-request poll of one git binding',
    recoveredBy: 'next_tick',
    residual:
      'retryLimit 0: a poll that throws has already re-armed itself, and the sweep re-arms a chain that was lost (WP-110)',
  },
  [JOB_QUEUES.taskAsk]: {
    kind: 'relies_on_retries',
    shape: 'recovery_row',
    loss: 'one ask-the-task question’s run',
    recoveredBy: 'task_ask, task_ask_run',
  },
  [JOB_QUEUES.knowledgeIndex]: {
    kind: 'relies_on_retries',
    shape: 'notification_shaped',
    loss: 'one index rebuild of a project’s vault (an unreadable vault is reported, not thrown)',
    recoveredBy: 'next_tick',
  },
  [JOB_QUEUES.knowledgeProposals]: {
    kind: 'relies_on_retries',
    shape: 'recovery_row',
    loss: 'one artifact’s knowledge proposals',
    recoveredBy: 'knowledge_curation',
  },
  [JOB_QUEUES.knowledgeApply]: {
    kind: 'relies_on_retries',
    shape: 'recovery_row',
    loss: 'one knowledge commit and its merge request (a provider write); the approved proposals stay approved and unapplied',
    recoveredBy: 'knowledge_apply',
  },
  [JOB_QUEUES.knowledgeHygiene]: {
    kind: 'relies_on_retries',
    shape: 'notification_shaped',
    loss: 'one nightly hygiene pass',
    recoveredBy: 'next_tick',
  },
  [JOB_QUEUES.discoveryRecord]: {
    kind: 'relies_on_retries',
    shape: 'recovery_row',
    loss: 'one discovery run’s readiness evaluation and drafted pages, or one readiness re-check (which the next default-branch commit re-derives)',
    recoveredBy: 'discovery_record',
  },
  [JOB_QUEUES.historyBootstrap]: {
    kind: 'relies_on_retries',
    shape: 'recovery_row',
    loss: 'one bootstrap collection or one mining run’s findings',
    recoveredBy: 'history_bootstrap, history_record',
  },
  [JOB_QUEUES.notifyDigest]: {
    kind: 'relies_on_retries',
    shape: 'notification_shaped',
    loss: 'one day’s digest post (a provider write); its rows stay undelivered and counted by the gauge',
    recoveredBy: null,
  },
  [JOB_QUEUES.maintenanceSchedule]: {
    kind: 'relies_on_retries',
    shape: 'notification_shaped',
    loss: 'one daily maintenance pass',
    recoveredBy: 'next_tick',
  },
  [JOB_QUEUES.priceListMaintenance]: {
    kind: 'relies_on_retries',
    shape: 'notification_shaped',
    loss: 'one pass over the price table',
    recoveredBy: 'next_tick',
  },
  [JOB_QUEUES.partitionMaintenance]: {
    kind: 'relies_on_retries',
    shape: 'notification_shaped',
    loss: 'one partition creation and retention pass (partitions are created months ahead)',
    recoveredBy: 'next_tick',
  },
};

/**
 * Every `pipeline.outbound` duty's shape — the WP-124 measurement (PROGRESS backlog 366), one row
 * per duty of `OutboundJobData`. A `Record` over the duty union, so the compiler holds it to the
 * set: a new duty without a row does not build (standing rule 7 by the type system rather than a
 * list beside it).
 */
export const OUTBOUND_DUTY_EXHAUSTION: Readonly<
  Record<OutboundJobData['duty'], OutboundDutyExhaustion>
> = {
  intake_check: {
    shape: 'recovery_row',
    why: 'a matched ticket with no task row is re-emitted by the intake reconciler (backlog 20), once per ticket',
    recoveredBy: 'intake reconcile',
  },
  workpad: {
    shape: 'notification_shaped',
    why: 'the next transition’s render rebuilds the whole comment from the task row and its stream, so a lost render is replaced by the next one',
  },
  status: {
    shape: 'notification_shaped',
    why: 'the next transition maps its own status; a lost intermediate move leaves the board one step behind until then, and the task itself moves on',
  },
  review_only_check: {
    shape: 'notification_shaped',
    why: 'an advisory review of a human merge request that never blocks it: the merge request is not reviewed, and nobody is waiting on a task that was never created',
  },
  review_only_post: {
    shape: 'bound_and_escalate',
    why: 'the review a person asked for by label or path was paid for and is not on the merge request; nothing re-posts it, and the task is already done',
  },
  review_only_observe: {
    shape: 'notification_shaped',
    why: 'one product/18 metric observation of a merge request’s ending; nobody waits on it',
  },
  ticket_lint_check: {
    shape: 'notification_shaped',
    why: 'an advisory lint of a new ticket: the ticket is not linted, and nobody waits on a task that was never created',
  },
  ticket_lint_post: {
    shape: 'bound_and_escalate',
    why: 'the lint was paid for and its one comment is not on the ticket; nothing re-posts it, and the lint task is already done',
  },
  conflict_warn: {
    shape: 'notification_shaped',
    why: 're-derived at the next rebase-gate entry (every default-branch move re-enters it); the warning is advice, not a gate',
  },
  risk_route: {
    shape: 'notification_shaped',
    why: 're-derived at the next rebase-gate entry; until then the Checks panel shows the previous routing or none',
  },
  coverage: {
    shape: 'notification_shaped',
    why: 'the next finished pipeline measures the delta again; a lost one is a missing Checks item, not a gate',
  },
  ci_settle: {
    shape: 'notification_shaped',
    why: 'the CI gate’s own stage.execute poll reads the same live head and settles it (gates.ts), so the settlement is re-derived',
  },
  dependency_gate: {
    shape: 'bound_and_escalate',
    why: 'a policy gate: nothing runs it again for this push, so a lost check lets a package the policy would ask about or block through with no record',
  },
  dependency_gate_resume: {
    shape: 'recovery_row',
    why: 'the deferral stays on the record and the deferred_dependency row re-enqueues it once per resume',
    recoveredBy: 'deferred_dependency',
  },
  shadow_report: {
    shape: 'notification_shaped',
    why: 'a shadow comparison report: a measurement of a task that changed nothing, which nobody waits on',
  },
  notify: {
    shape: 'recovery_row',
    why: 'a planned-immediate notification that spent its job is re-posted once under the same key',
    recoveredBy: 'notification_repost',
  },
  approval_settled: {
    shape: 'notification_shaped',
    why: 'edits a chat message to say a decided approval is settled; the approval itself is decided',
  },
  question_settled: {
    shape: 'notification_shaped',
    why: 'edits a chat message to say an answered question is settled; the question itself is answered',
  },
  ask_answer: {
    shape: 'notification_shaped',
    why: 'mirrors an answer into the ticket thread; the answer is on the task page whatever happens to the mirror',
  },
  spike_report: {
    shape: 'bound_and_escalate',
    why: 'the report a person waits on at human_review is not attached to the ticket; nothing re-attaches it',
  },
  breakdown_create: {
    shape: 'bound_and_escalate',
    why: 'the children a person accepted are not filed; nothing files them until another decision is made',
  },
  revoke_run_credential: {
    shape: 'recovery_row',
    why: 'a terminal run’s unrevoked credential is found again by its audit rows',
    recoveredBy: 'run_credential',
  },
  close_superseded_mr: {
    shape: 'recovery_row',
    why: 'a rework’s unclosed merge request is found again and closed once, then abandoned loudly',
    recoveredBy: 'superseded_mr',
  },
  merge_measure: {
    shape: 'notification_shaped',
    why: 'one delivery-metric measurement of a merge; nobody waits on it',
  },
  bug_trace: {
    shape: 'notification_shaped',
    why: 'one defect-trace measurement; a later ticket.updated of a bug re-traces it (WP-90)',
  },
  review_threads_refresh: {
    shape: 'notification_shaped',
    why: 'the open-thread count is re-read by the next review window or refresh',
  },
  resolve_on_merge: {
    shape: 'notification_shaped',
    why: 'resolves linked Sentry issues after a merge; the merge is done, and an issue left open is resolved by hand',
  },
  notify_organisation: {
    shape: 'recovery_row',
    why: 'an organisation notification that spent its job is re-posted once under the same key',
    recoveredBy: 'notification_repost',
  },
  mr_pipeline: {
    shape: 'bound_and_escalate',
    why: 'a head with no pipeline, or one held at a manual job, is a CI gate waiting for a pipeline nobody asked for; nothing re-runs the duty for this completion',
  },
  mr_ready: {
    shape: 'bound_and_escalate',
    why: 'a task at ready_for_merge whose merge request is still a draft cannot be merged by the person it waits for; nothing re-runs the duty for this entry',
  },
  mr_draft: {
    shape: 'notification_shaped',
    why: 'a merge request left ready while an agent changes it again; the next entry into ready_for_merge marks it ready anyway, and nobody waits on the draft',
  },
  ticket_lifecycle: {
    shape: 'notification_shaped',
    why: 'one move of the ticket to a lifecycle slot (TD-029 decision 4): a failed write never blocks the stage, leaves its audit row and a warn naming the slot, and the next moment moves the ticket on',
  },
  ticket_release: {
    shape: 'notification_shaped',
    why: 'gives the ticket of a cancelled task, or of a task that stopped between its assign and its record (cause `stopped`), back (TD-029 decision 5); a lost release leaves the binding’s own account assigned until a person moves it. Until WP-178 a lost `stopped` release also left the claim stale, so the next claim was a re-claim that took the ticket back from a person who took it meanwhile (PROGRESS backlog 543); since then the claim records `stale_cause: stopped` and that claim is a first claim whether or not the release ran. A Rework no longer enqueues this duty: its release runs in the next agent admission, before the claim (backlog 541)',
  },
  review_findings_post: {
    shape: 'notification_shaped',
    why: 'the Reviewer’s findings and summary as merge-request threads (TD-029 decision 10): the verdict already moved the task and is on the task page, and the next run reads the findings from the artifact; a lost post is a conversation a person reads elsewhere',
  },
  conversation_replies: {
    shape: 'notification_shaped',
    why: 'the Developer’s answers on the threads it addressed: the change itself is pushed and the answers are on the task page in the ImplementationNotes; a lost post leaves a thread unanswered, which the next review or a person reads',
  },
  review_threads_resolve: {
    shape: 'notification_shaped',
    why: 'resolves the Reviewer’s own finding threads a re-review confirmed fixed: nothing waits on it, and a thread left open is one a person resolves by hand',
  },
  ready_head_check: {
    shape: 'bound_and_escalate',
    why: 'a person’s resume, hand-back or retry waits on it, and the task stays where the command found it with nothing saying why',
  },
};

/** The shape of one outbound duty, or `null` for a duty this build does not know. */
export const outboundDutyExhaustionOf = (duty: string): OutboundDutyExhaustion | null =>
  Object.hasOwn(OUTBOUND_DUTY_EXHAUSTION, duty)
    ? (OUTBOUND_DUTY_EXHAUSTION[duty as OutboundJobData['duty']] as OutboundDutyExhaustion)
    : null;

/** The census row of a queue, or `null` for a queue this build does not declare. */
export const jobExhaustionOf = (queue: string): JobExhaustion | null =>
  Object.hasOwn(JOB_EXHAUSTION, queue) ? (JOB_EXHAUSTION[queue] as JobExhaustion) : null;

/**
 * One queue whose last try escalates its task, and — for `pipeline.outbound`, whose duties differ —
 * the duties that do (WP-156, PROGRESS backlog 421). `duties: null` is the whole queue.
 */
export interface BoundAndEscalateTarget {
  readonly queue: string;
  readonly duties: readonly string[] | null;
}

/**
 * Every bound-and-escalate queue and duty, read off the two tables above rather than listed beside
 * them (standing rule 7): a queue declared `bound_and_escalate`, and a `per_duty` queue with its
 * `bound_and_escalate` duties. The census holds each to a declared `expireInSeconds`, and the
 * `expired_job` recovery row reads the expired last tries of these (all but the ones it names as
 * recovered elsewhere).
 */
export const boundAndEscalateTargets = (): readonly BoundAndEscalateTarget[] =>
  Object.entries(JOB_EXHAUSTION).flatMap(([queue, row]): BoundAndEscalateTarget[] => {
    if (row.shape === 'bound_and_escalate') return [{ queue, duties: null }];
    if (row.shape !== 'per_duty') return [];
    const duties = Object.entries(OUTBOUND_DUTY_EXHAUSTION)
      .filter(([, duty]) => duty.shape === 'bound_and_escalate')
      .map(([duty]) => duty)
      .sort();
    return duties.length === 0 ? [] : [{ queue, duties }];
  });
