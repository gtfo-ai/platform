/**
 * `pipeline.outbound` — every provider call the pipeline makes because of an event (WP-15d).
 *
 * ## Why there is a queue here at all
 *
 * An event handler runs inside two transactions: the dispatcher's, which owns the event's queue row
 * for the whole dispatch, and its own. A provider call made from there holds a pooled connection
 * and the platform's dispatch slot (`APP_DISPATCH_MAX_CONCURRENCY` ships as **1**) for as long as
 * somebody else's HTTP request takes, and makes the executor's audit write — which commits in a
 * transaction of its own, BD-003 — nest inside the caller's. Both were paid for before the cause
 * was named: `integration_actions_task_id_fkey`, which made every e2e fail because the audit row
 * commits before the task row does, and a pool floor that grew a third connection per in-flight
 * dispatch.
 *
 * Measured at the shipped defaults, with one git read held open by a promise the test resolves: an
 * event with nothing to do with that provider was **not dispatched at all** while the call was in
 * flight (`test/e2e/pipeline/outbound-shape.e2e.test.ts`). So the handler decides and this queue
 * calls — CLAUDE.md's *transaction / no transaction / transaction*, which the stage executor and
 * the two older jobs already had.
 *
 * ## What a duty may assume, and what it may not
 *
 * A job is a **wake-up**, not a message. `Jobs.enqueue` cannot join the handler's transaction
 * (TD-004), so every enqueue goes through `HandlerContext.afterCommit` and every duty re-derives
 * what it should do from committed state when it fires. The payload carries ids, the cause event's
 * id, and the two pieces of event text no row holds — the matched ticket and a blocker brief.
 *
 * Three consequences that are the point rather than the price:
 *
 *  - a duplicate wake-up is harmless: intake finds the task already created, the render writes the
 *    same comment through the same marker, the transition asks for a status the ticket is already
 *    in. On top of that the two ticket **writes** carry an `IdempotencyPlan` keyed by the cause
 *    event, so a retry after the provider already answered replays instead of writing twice;
 *  - a **lost** wake-up costs differently per duty, and that is why only one of them needed a job
 *    rather than a bare callback: the workpad and the status are re-derived from the task row by
 *    the next event, while the intake check is the only chance that ticket has;
 *  - nothing here holds a transaction while it calls. `integrations.forProject` and the executor
 *    both refuse if a later change tries (`events/open-transaction.ts`).
 */
import type { Id } from '@platform/contracts';
import { type AskMirrorOptions, runAskMirror } from '../ask/mirror.js';
import { runApprovalSettled } from '../notify/approval-settled.js';
import { runNotification } from '../notify/duty.js';
import type { NotifyOptions } from '../notify/options.js';
import { runOrganisationNotification } from '../notify/organisation.js';
import { runQuestionSettled } from '../notify/question-settled.js';
import { outboundDutyExhaustionOf } from '../ports/job-exhaustion.js';
import type { JobContext, JobHandler } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  type RunCredentialRevocationOptions,
  runRunCredentialRevocation,
} from '../recovery/run-credential.js';
import { runShadowReport, type ShadowReportOptions } from '../shadow/report.js';
import { runCiSettle } from './ci-settle.js';
import { runConflictWarning } from './conflict-warning.js';
import { runCoverage } from './coverage.js';
import { type DeliveryMeasuresOptions, runBugTrace, runMergeMeasure } from './delivery-measures.js';
import {
  type DependencyGateOptions,
  runDependencyGate,
  runDependencyGateResume,
} from './dependency-gate.js';
import { runBreakdownCreate, runSpikeReport } from './epic-split.js';
import { type ExhaustedJob, escalatingOnLastTry } from './job-escalation.js';
import type { OutboundJobData } from './jobs.js';
import {
  runMergeRequestDraft,
  runMergeRequestPipeline,
  runMergeRequestReady,
} from './merge-request-ready.js';
import { underReviewConversationLease } from './owed-duties.js';
import { runReadyHeadCheck } from './ready-head.js';
import { runResolveOnMerge } from './resolve-on-merge.js';
import {
  runConversationReplies,
  runReviewFindingsPost,
  runReviewThreadsResolve,
} from './review-conversation.js';
import { runReviewOnlyCheck, runReviewOnlyObservation, runReviewOnlyPost } from './review-only.js';
import { runReviewThreadsRefresh } from './review-threads-refresh.js';
import { type RiskRoutingOptions, runRiskRouting } from './risk-routing.js';
import { type PipelineSagaOptions, runIntakeCheck } from './saga.js';
import { runSupersededMergeRequestClose } from './superseded-mr.js';
import { runTicketLifecycle, runTicketRelease } from './ticket-lifecycle.js';
import { runTicketLintCheck, runTicketLintPost } from './ticket-lint.js';
import { runStatusTransition, runWorkpadRender } from './workpad.js';

export interface PipelineOutboundOptions
  extends PipelineSagaOptions,
    NotifyOptions,
    Pick<AskMirrorOptions, 'asks'>,
    Pick<DependencyGateOptions, 'dependencyMetadata'>,
    Pick<ShadowReportOptions, 'shadow'>,
    Pick<RiskRoutingOptions, 'identities'>,
    Pick<RunCredentialRevocationOptions, 'runCredentials'>,
    Pick<DeliveryMeasuresOptions, 'eventStore'> {
  readonly unitOfWork: UnitOfWork;
  /** `APP_BASE_URL` — the link an ask's mirrored comment points back at. */
  readonly baseUrl: string;
}

/**
 * What each **bound-and-escalate** duty was for, and what a person can do once it has spent its
 * tries — the two clauses of the brief `job-escalation.ts` writes (WP-124, PROGRESS backlog 366).
 * Platform text only. Keyed by the duties `OUTBOUND_DUTY_EXHAUSTION` declares `bound_and_escalate`,
 * and held to that set by `outbound.test.ts`.
 */
export const OUTBOUND_ESCALATION_TEXT: Readonly<
  Record<string, { readonly what: string; readonly remedy: string }>
> = {
  review_only_post: {
    what: 'post the review on the merge request',
    remedy:
      'The review is stored on this task; read it here, and post what matters on the merge request yourself.',
  },
  ticket_lint_post: {
    what: 'post the readiness lint on the ticket',
    remedy: 'The lint is stored on this task; read it here, and comment on the ticket yourself.',
  },
  spike_report: {
    what: 'attach the research report to the ticket',
    remedy:
      'The report is stored on this task; attach it to the ticket yourself, then hand the task back.',
  },
  breakdown_create: {
    what: 'file the child tickets that were accepted',
    remedy:
      'The accepted children with no ticket yet are listed on this task; file them by hand, or decide the breakdown again once the tracker is reachable.',
  },
  dependency_gate: {
    what: 'check the dependencies this change adds against the project’s policy',
    remedy:
      'Nothing was allowed, asked about or blocked: review the merge request’s manifests yourself, then hand the task back at the stage it should resume from.',
  },
  mr_pipeline: {
    what: 'start a pipeline for this task’s merge request',
    remedy:
      'The merge request’s head may have no pipeline, or one held at a manual job: run its pipeline on the provider, then retry the CI gate.',
  },
  mr_ready: {
    what: 'mark this task’s merge request ready',
    remedy:
      'Every check before Ready passed, but the merge request may still be a draft: mark it ready on the provider, then resume the task.',
  },
  ready_head_check: {
    what: 'judge the branch head for the resume, hand-back or retry a person asked for',
    remedy:
      'The task did not move; check the merge request, then resume or hand the task back again.',
  },
};

/** The brief's description of one outbound job, or `null` when this job does not escalate. */
const exhaustedOutbound = (job: JobContext<OutboundJobData>): Omit<ExhaustedJob, 'tries'> | null =>
  describeExhaustedOutbound(job.data);

/**
 * The same description from the job's **payload** alone — what the `expired_job` recovery row has
 * when it reads a failed job off pg-boss's table (WP-156, PROGRESS backlog 421), so a thrown and an
 * expired last try escalate with one brief. `null` for a duty that does not escalate, and for a
 * payload that names no task.
 */
export const describeExhaustedOutbound = (
  data: OutboundJobData,
): Omit<ExhaustedJob, 'tries'> | null => {
  const declared = outboundDutyExhaustionOf(String(data.duty));
  const text = OUTBOUND_ESCALATION_TEXT[String(data.duty)];
  if (declared?.shape !== 'bound_and_escalate' || text === undefined) {
    return null;
  }
  if (data.duty === 'notify_organisation' || data.task_id === undefined) {
    return null;
  }
  return {
    taskId: data.task_id as Id,
    projectId: data.project_id as Id,
    queue: JOB_QUEUES.pipelineOutbound,
    duty: data.duty,
    causeEventId: (data.cause_event_id ?? null) as Id | null,
    what: text.what,
    remedy: text.remedy,
  };
};

/**
 * One job, one duty.
 *
 * The `default` branch **logs and returns** rather than throwing: a duty name this build does not
 * know can only come from a job enqueued by a newer deployment against the same database during a
 * rolling upgrade, and failing it would retry it twice and then dead-letter a wake-up the other
 * half of the fleet is handling correctly. Standing rule 20 — this is a notification, not a
 * mutation.
 */
export const pipelineOutboundHandler = (
  options: PipelineOutboundOptions,
): JobHandler<OutboundJobData> => {
  const logger: Logger = options.logger ?? silentLogger;
  // WP-124: a duty declared `bound_and_escalate` escalates its task on its last try before the
  // throw ends the job; every other duty's throw reaches the retry policy untouched.
  return escalatingOnLastTry(options, dispatchOutbound(options, logger), exhaustedOutbound);
};

const dispatchOutbound =
  (options: PipelineOutboundOptions, logger: Logger): JobHandler<OutboundJobData> =>
  async (job) => {
    const { data } = job;
    if (data.duty === 'notify_organisation') {
      // The one duty with no project (WP-65): narrowed here, before anything reads `project_id`.
      await runOrganisationNotification(options, data);
      return;
    }
    if (data.duty === 'ready_head_check') {
      // WP-79: a human's way into Ready, judged by the branch head — a payload of its own, narrowed
      // here like the organisation's.
      await runReadyHeadCheck(options, data);
      return;
    }
    switch (data.duty) {
      case 'intake_check':
        await runIntakeCheck(options, data);
        return;
      case 'workpad':
        await runWorkpadRender(options, data);
        return;
      case 'status':
        await runStatusTransition(options, data);
        return;
      case 'review_only_check':
        await runReviewOnlyCheck(options, data);
        return;
      case 'review_only_post':
        await runReviewOnlyPost(options, data);
        return;
      case 'review_only_observe':
        await runReviewOnlyObservation(options, data);
        return;
      case 'ticket_lint_check':
        await runTicketLintCheck(options, data);
        return;
      case 'ticket_lint_post':
        await runTicketLintPost(options, data);
        return;
      case 'conflict_warn':
        await runConflictWarning(options, data);
        return;
      case 'risk_route':
        await runRiskRouting(options, data);
        return;
      case 'coverage':
        await runCoverage(options, data);
        return;
      case 'ci_settle':
        await runCiSettle(options, data);
        return;
      case 'dependency_gate':
        await runDependencyGate(options, data);
        return;
      case 'dependency_gate_resume':
        await runDependencyGateResume(options, data);
        return;
      case 'shadow_report':
        await runShadowReport(options, data);
        return;
      case 'notify':
        await runNotification(options, data);
        return;
      case 'approval_settled':
        await runApprovalSettled(options, data);
        return;
      case 'question_settled':
        await runQuestionSettled(options, data);
        return;
      case 'ask_answer':
        await runAskMirror(options, data);
        return;
      case 'spike_report':
        await runSpikeReport(options, data);
        return;
      case 'breakdown_create':
        await runBreakdownCreate(options, data);
        return;
      case 'revoke_run_credential':
        await runRunCredentialRevocation(options, data);
        return;
      case 'close_superseded_mr':
        await runSupersededMergeRequestClose(options, data);
        return;
      case 'merge_measure':
        await runMergeMeasure(options, data);
        return;
      case 'bug_trace':
        await runBugTrace(options, data);
        return;
      case 'review_threads_refresh':
        await runReviewThreadsRefresh(options, data);
        return;
      case 'resolve_on_merge':
        await runResolveOnMerge(options, data);
        return;
      case 'mr_pipeline':
        await runMergeRequestPipeline(options, data);
        return;
      case 'mr_ready':
        await runMergeRequestReady(options, data);
        return;
      case 'mr_draft':
        await runMergeRequestDraft(options, data);
        return;
      // WP-177 (TD-029 decisions 4 and 5): the ticket lifecycle's moves and the release.
      // WP-184: the entry moves are performed by the stage job too, so they take the task's lease.
      case 'ticket_lifecycle':
        await underReviewConversationLease(options, data, () => runTicketLifecycle(options, data));
        return;
      case 'ticket_release':
        await runTicketRelease(options, data);
        return;
      // WP-179 (TD-029 decision 10): the review conversation on the merge request — under the
      // task's duty lease since WP-184, because the stage job performs the same duties before it
      // plans the next agent stage (`owed-duties.ts`) and the executor's key is recorded only after
      // its call.
      case 'review_findings_post':
        await underReviewConversationLease(options, data, () =>
          runReviewFindingsPost(options, data),
        );
        return;
      case 'conversation_replies':
        await underReviewConversationLease(options, data, () =>
          runConversationReplies(options, data),
        );
        return;
      case 'review_threads_resolve':
        await underReviewConversationLease(options, data, () =>
          runReviewThreadsResolve(options, data),
        );
        return;
      default:
        logger.warn(
          { job_id: job.id, duty: String((data as { duty?: unknown }).duty) },
          'an outbound job named a duty this build does not know; leaving it to whoever does',
        );
    }
  };
