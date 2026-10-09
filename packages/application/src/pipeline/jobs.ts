/**
 * The pipeline's background jobs (TD-004) — the queue names, the payloads and two of the handlers.
 *
 * `stage.execute` runs one stage of one task — an agent run, or a gate the platform evaluates
 * itself. `mr.comment.debounce` is BD-007's two-minute batch window for human merge-request
 * comments. `pipeline.outbound` is every provider call an event handler decided on (WP-15d); its
 * handler lives in `outbound.ts`, because it routes to duties this file must not depend on.
 *
 * ## Why the batch window is a delayed wake-up and not a coalesced job
 *
 * technical/02 asks for "one `task.stage.returned` after a 2-minute debounce per MR". The `Jobs`
 * port has coalescing, and it is the wrong tool: **both** of its modes are leading-edge, so the
 * first comment of a burst would run immediately and bounce the task back to Implementation while
 * the human was still typing the second one. The port refuses `coalesce` together with
 * `startAfter` for exactly this reason.
 *
 * What does work is a `stately` queue plus a singleton key per merge request and a `startAfter` two
 * minutes out: `stately` admits one *queued* job per key, so a burst of comments collapses onto the
 * first one's timer, and the handler re-reads **every signal** when it fires — since WP-178 the
 * merge request's notes, the ticket's comments and its status; until then every unresolved thread —
 * rather than acting on the comment that scheduled it. If a person wrote inside the last window,
 * the handler schedules another one instead of returning the task — which is what makes it a real
 * debounce ("wait until they stop") built out of a timer that cannot be cancelled.
 *
 * `coalesced` is a success, not an error: it means the window this comment belongs to is already
 * scheduled.
 */
import type { DomainEvent, Id, Slug, TaskStageOutcome, TaskState } from '@platform/contracts';
import {
  domainEventSchemasByType,
  effortSchema,
  lifecycleStatusKey,
  MAX_LIFECYCLE_STATUS_NAME_CHARS,
  type TicketLifecycle,
} from '@platform/contracts';
import {
  compilePipeline,
  type HumanReturnDecision,
  type HumanReturnStage,
  hasIdenticalFailureStreak,
  humanReturnDecision,
  interpret,
  isRunnableTaskState,
  personsWordsSince,
  QA_STAGE_ID,
  READY_FOR_MERGE_STAGE,
  stageOf,
} from '@platform/domain';
import * as z from 'zod';
import { composeSecretRedactors } from '../integrations/redaction.js';
import type { SecretRedactor } from '../ports/integrations/audit.js';
import { IntegrationUnsupportedError } from '../ports/integrations/common.js';
import {
  MAX_LIST_COMMENTS_LIMIT,
  type TicketComment,
} from '../ports/integrations/task-management.js';
import { jobQueueDefinition } from '../ports/job-queues.js';
import type { EnqueueResult, JobHandler, Jobs } from '../ports/jobs.js';
import { JOB_QUEUES } from '../ports/jobs.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { TransactionScope, UnitOfWork } from '../ports/unit-of-work.js';
import { ciWaitBrief, ciWaitReason, decideCiWait } from './ci-wait.js';
import {
  decideGateOutage,
  GATE_OUTAGE_LIMIT_MINUTES,
  type GateOutageBound,
  gateOutageBrief,
  gateOutageReason,
} from './gate-outage.js';
import {
  CI_GATE_STAGE,
  type CiWait,
  createGateEvaluator,
  type GateProviderOutage,
  type GateResult,
  MAX_GATE_CHECKS,
  rebaseAgainstCi,
} from './gates.js';
import { humanReturnStageOf } from './human-stage.js';
import {
  gitReads,
  integrationsForProject,
  noRunScopedSecrets,
  type PipelineIntegrations,
  ticketReads,
} from './integrations.js';
import { type ExhaustedJob, escalatingOnLastTry } from './job-escalation.js';
import { prefetchObservability } from './observability-prefetch.js';
import { REBASE_GATE_STAGE, recordRebaseCheck } from './rebase.js';
import { reviewedMergeRequestPaths } from './review-paths.js';
import {
  humanReturnFeedback,
  mergeRequestWords,
  reviewThreadCounts,
  ticketCommentWords,
  type WindowWord,
} from './review-threads.js';
import type { PipelineSagaOptions } from './saga.js';
import type { StageExecutionJob, StageExecutor } from './stage-executor.js';
import type { StoredTask, TicketStatusChange } from './store.js';
import { confirmExcusedPaths, unconfirmedTamperReturn } from './tamper-confirmation.js';
import { inTaskTransaction, type TaskTransactionOptions } from './task-transaction.js';
import { ensureTicketClaim } from './ticket-claim.js';
import { ensureTicketSnapshot, type RequesterOptions } from './ticket-snapshot.js';
import { applyDecision } from './transitions.js';

/** `stage.execute` payload — snake_case, like every other payload on the wire. */
export interface StageExecuteData {
  readonly task_id: string;
  readonly project_id: string;
  readonly stage: string;
  readonly attempt: number;
  /** How many times a gate has answered "not yet"; absent for an agent stage. */
  readonly gate_checks?: number;
  /**
   * How many times this stage's run failed to **start** for a transport reason (Q59(a), WP-15g).
   *
   * Absent for the ordinary first wake-up. It rides the payload rather than living in the executor
   * because the process that retries may not be the one that failed, and a counter a restart forgets
   * is an unbounded retry — the same reasoning as `gate_checks` two lines up.
   */
  readonly start_attempts?: number;
  /**
   * The model and effort this **one attempt** runs on, when a human chose them (WP-15i).
   *
   * `POST /api/runs/:run_id/retry` is technical/08's "retry (model/effort override)", and the
   * override has to travel on the wake-up because that is the only thing that reaches the process
   * that plans the run. Absent is the ordinary case and means "whatever the project's configuration
   * and the template say" — the override is **not** written to the project, so the next attempt of
   * the same stage is back to the configured model rather than silently inheriting one human's
   * choice.
   */
  readonly model?: string;
  readonly effort?: string;
  /**
   * A gate whose provider did not answer (PROGRESS backlog 490, `gate-outage.ts`): the instant of
   * the **first** failed read in a row, and how many there have been. Absent once the provider
   * answers anything — a `pending` included — so an outage's clock never outlives the outage. On
   * the payload for `gate_checks`' reason: the process that re-asks may not be the one that failed.
   */
  readonly provider_failing_since?: string;
  readonly provider_failures?: number;
  readonly [key: string]: unknown;
}

/**
 * The `stage.execute` payload, parsed at the handler (backlog 490). **Strict**, like every boundary
 * schema: a key this build does not know is refused rather than dropped. The enqueue side is
 * {@link enqueueStage}, the only writer, and every key it writes is here.
 */
export const stageExecuteDataSchema = z.strictObject({
  task_id: z.string().min(1),
  project_id: z.string().min(1),
  stage: z.string().min(1),
  attempt: z.number().int().min(1),
  gate_checks: z.number().int().min(0).optional(),
  start_attempts: z.number().int().min(0).optional(),
  model: z.string().min(1).optional(),
  effort: effortSchema.optional(),
  provider_failing_since: z.iso.datetime().optional(),
  provider_failures: z.number().int().min(1).optional(),
});

export interface ReviewWindowData {
  readonly task_id: string;
  readonly project_id: string;
  readonly iid: number;
  /** The instant the window was opened, so the handler can tell a fresh comment from an old one. */
  readonly opened_at: string;
  readonly [key: string]: unknown;
}

/**
 * One outbound duty: a provider call an event handler decided on and did not make (WP-15d).
 *
 * snake_case, like every other payload on the wire (CLAUDE.md). It carries **ids and the event's
 * own text**, never a resolved binding or a credential: the job re-reads the task and re-resolves
 * the project's bindings when it fires, because a job is a wake-up and not a message
 * (TD-004: "re-validate on fire").
 */
export interface PipelineOutboundData {
  readonly duty:
    | 'intake_check'
    /**
     * Backlog 486 (reversing WP-138 ruling (g)): a merge-request pipeline for the Developer's head
     * when it has none; the merge request marked ready at `ready_for_merge`; and put back to draft
     * when an agent stage changes it again after Ready.
     */
    | 'mr_pipeline'
    | 'mr_ready'
    | 'mr_draft'
    | 'workpad'
    | 'status'
    /** WP-24, review-only mode: consider a human merge request, post a review, observe the outcome. */
    | 'review_only_check'
    | 'review_only_post'
    | 'review_only_observe'
    /** WP-25, the ticket readiness linter: consider a new ticket, post the one comment. */
    | 'ticket_lint_check'
    | 'ticket_lint_post'
    /** WP-26, the rebase gate: tell this task's merge request which peers touch the same files. */
    | 'conflict_warn'
    /**
     * WP-37, the rebase gate again: classify the merge request's changed paths and route its
     * reviewers. A duty of its own rather than a branch of `conflict_warn`, because that one gives
     * up when the project has no peer task — see `risk-routing.ts`.
     */
    | 'risk_route'
    /**
     * WP-39, the coverage delta: what the CI reported for this revision, against the default
     * branch. The one duty that is not woken by a stage transition — `ci.pipeline.finished` arrives
     * when the pipeline finishes, which is whenever the provider says.
     */
    | 'coverage'
    /**
     * WP-38, the dependency policy: read the Developer stage's own diff, apply the project's
     * `allow | ask | block`, and record what it found for the Checks panel.
     */
    | 'dependency_gate'
    /**
     * WP-67, PROGRESS backlog 96: perform the gate's `ask` or `block` that a stop a human owns
     * deferred, now the task has resumed. Calls no provider; the record carries the decision.
     */
    | 'dependency_gate_resume'
    /**
     * WP-34, shadow mode: compare what a shadow task produced with the human merge request the
     * batch resolved for its ticket, and write the one `shadow_reports` row.
     */
    | 'shadow_report'
    /** WP-32, the notify band: say one thing in the project's chat channel. */
    | 'notify'
    /**
     * WP-65, PROGRESS backlog 202: an approval posted with buttons was decided or expired, so the
     * message is edited through `updateMessage` to say so — its buttons are a control that lies
     * once the aggregate has settled. `approval_id` names it; the row holds the rest.
     */
    | 'approval_settled'
    /**
     * WP-88, PROGRESS backlog 233: a question posted through `postQuestion` was answered or
     * expired, so its message is edited to say so and its buttons go. `question_id` names it.
     */
    | 'question_settled'
    /** WP-31, ask-the-task: mirror an answer into the ticket thread (product/10:57). */
    | 'ask_answer'
    /**
     * WP-40, the spike template: attach the research report to the ticket (product/04:117).
     *
     * The knowledge page is **not** this duty's: it is queued by the knowledge ring's own job off
     * `artifact.created`, where the vault path, the byte budget and BD-018's apply policy already
     * live (`knowledge/research.ts`).
     */
    | 'spike_report'
    /**
     * WP-40, the epic split: file the children a human accepted, one `createTicket` each.
     *
     * Woken by `task.breakdown.decided` and **only** by it: nothing is created on the run's own
     * verdict, which is what product/04:117's *"for the PM to accept"* means.
     */
    | 'breakdown_create'
    /**
     * WP-77, PROGRESS backlog 155: revoke, by address, a run credential nothing confirmed revoked.
     *
     * Enqueued by the recovery pass rather than by a handler — `recovery/run-credential.ts` — and
     * re-validated on fire against the audit rows, because that pass may enqueue one address twice.
     */
    | 'revoke_run_credential'
    /**
     * WP-59, PROGRESS backlog 51 (Q92): comment on and close the merge request a `rework` let go
     * of. Enqueued by the rework **command** after its commit rather than by a handler, and the
     * one duty whose subject no row holds any more — the command cleared `tasks.mr_ref` so the
     * close's own `mr.closed` webhook finds no task — so its merge request rides the payload
     * (`iid`, `mr_url`, `mr_project_path`) with the branch the work moved to (`new_branch`).
     */
    | 'close_superseded_mr'
    /**
     * WP-60 review round 2: settle the CI gate from a finished pipeline, **only** if that pipeline
     * ran on the merge request's **live** head — read from the provider here, outside every
     * transaction, because the handler that decided cannot (`ci-settle.ts`).
     */
    | 'ci_settle'
    /**
     * WP-61, PROGRESS backlog 179: read the size of a merge request the platform merged, once, and
     * record it as `task.mr.measured` — the delivery's own `diff_stats` is `null` on GitLab.
     */
    | 'merge_measure'
    /**
     * WP-61, PROGRESS backlog 114 (Q87): for a ticket the project calls a bug, run the link half of
     * WP-34's resolver over its links and record `ticket.bug.traced` — found or not. Since WP-90
     * (backlog 192) also enqueued by a `ticket.updated` for a bug not yet `linked` (`retrace_of`).
     */
    | 'bug_trace'
    /**
     * WP-90, PROGRESS backlog 210: re-read a `ready_for_merge` task's review threads and write
     * **only** the count — enqueued by a signal that a thread was resolved (or re-opened) without a
     * comment that would open BD-007's window. Never the return decision (`review-threads-refresh.ts`).
     */
    | 'review_threads_refresh'
    /**
     * WP-111, PROGRESS backlog 302: on a bug task's merge, resolve the issues its ticket links —
     * only on an errors binding that sets `resolve_on_merge` (`resolve-on-merge.ts`).
     */
    | 'resolve_on_merge'
    /**
     * WP-177 (TD-029 decision 4): move the ticket to the lifecycle slot a stage moment names —
     * `in_review`, `approved`, `qa`, `done`, `in_progress` on a developer stage's entry. The handler
     * decides the slot and the status (`ticketLifecycleHandler`); the duty calls.
     */
    | 'ticket_lifecycle'
    /**
     * WP-177 (TD-029 decision 5): give the ticket back on the task's cancellation or a person's
     * *Rework* — unassign the binding's own account, move it to `pick_up_from` when mapped.
     */
    | 'ticket_release'
    /**
     * WP-179 (TD-029 decision 10): the review conversation on the merge request — the Reviewer's
     * findings and summary after `code_review`, the Developer's `thread_replies` after a developer
     * stage, and the Reviewer's own finding threads resolved after a re-review
     * (`review-conversation.ts`).
     */
    | 'review_findings_post'
    | 'conversation_replies'
    | 'review_threads_resolve';
  readonly project_id: string;
  /** Absent for `intake_check`, which runs before there is a task. */
  readonly task_id?: string;
  /** The event that caused the wake-up: the replay identity of a ticket write, and the cause id. */
  readonly cause_event_id: string;
  /**
   * `intake_check` and `ticket_lint_check` — the event's ticket, which no row holds until the task
   * exists. The lint's task carries a *platform-issued* key, so this is the one place the duty
   * learns the ticket's own (`ticket-lint.ts` § `lintTicketKeyFor`).
   */
  readonly ticket?: {
    readonly provider: string;
    readonly key: string;
    readonly url: string;
  };
  readonly issue_type?: string | null;
  /** `bug_trace` only (WP-61): the `ticket.created` instant the thirty days are measured back from. */
  readonly filed_at?: string;
  /**
   * `bug_trace` only, and only on a **re-trace** (WP-90, PROGRESS backlog 192): the outcome of the
   * trace a `ticket.updated` found — `no_link` or `unreadable`. Absent on the first trace. The duty
   * re-validates it on fire and records nothing when the answer has not changed.
   */
  readonly retrace_of?: 'no_link' | 'unreadable';
  readonly priority?: string | null;
  /** `workpad` only: the brief lives on the event, not on the task row. */
  readonly blocker_brief?: string;
  /**
   * `workpad` after a `task.taken_over`, **written by builds before WP-56 and read by none since**:
   * the branch and the session travelled on the wake-up, so only the render that event caused
   * showed the take-over block (PROGRESS backlog 69). The render now reads the take-over from the
   * task's stream (`TaskRepository.takenOver`). The fields stay declared so a job still queued
   * across an upgrade parses; nothing enqueues them and the render ignores them.
   */
  readonly taken_over_branch?: string;
  readonly taken_over_session?: string | null;
  /**
   * `status` only: the provider's own status name the handler mapped this event to.
   *
   * Decided by the handler rather than re-derived when the job fires, because a transition is a
   * movement and the board owes a human every move in order; see `statusMappingHandler`.
   */
  readonly status?: string;
  /**
   * `ticket_lifecycle` only (WP-177): the lifecycle slot the moment named, carried beside `status`
   * so a failed write's log names the slot (TD-029 decision 4).
   */
  readonly lifecycle_slot?: string;
  /**
   * `ticket_lifecycle` on a stage **entry** only (WP-184): the write's idempotency key —
   * `ticket_lifecycle:<task>:<stage>:<attempt>`, the stage attempt's identity rather than the cause
   * event's, because the `stage.execute` job performs the same move before it plans the stage
   * (`owed-duties.ts`) and has no event id to name. Absent (a completion's `approved`, or a wake-up
   * written before WP-184), the key is the cause event's, as before.
   */
  readonly lifecycle_key?: string;
  /**
   * The three review-conversation duties (WP-179): the artifact whose completion woke them — a
   * `ReviewVerdict` or an `ImplementationNotes` — re-read when the job fires.
   */
  readonly artifact_id?: string;
  /** `ticket_release` only (WP-177): why the ticket is given back. */
  readonly release_cause?: 'cancelled' | 'rework' | 'stopped';
  /** `ask_answer` only (WP-31): which ask was answered. The row holds everything else. */
  readonly ask_id?: string;
  /**
   * `coverage` (WP-39) and `ci_settle` (WP-60): the revision the pipeline that just finished ran on.
   *
   * It rides the payload rather than being re-derived from `tasks.mr_ref` because the two can
   * disagree — a merge request whose head moved while its pipeline ran would otherwise have the old
   * pipeline's number filed under the new revision, and the panel would name a sha the number is
   * not about. It is re-validated on fire the only way it can be: the provider is asked for *that*
   * revision's pipeline, and answers `null` when there is none.
   */
  readonly head_sha?: string;
  /** `ci_settle` only: the finished pipeline's status and its failing jobs, from the event. */
  readonly ci_status?: string;
  readonly failed_jobs?: readonly string[];
  /**
   * `ci_settle` only (WP-81): each failing job's name with the log reference the event carried, so a
   * failed gate can read the first one's log (BD-024 §5). Absent on a payload an older build wrote;
   * the gate then states that no log was named rather than reading one.
   */
  readonly failed_job_logs?: readonly { readonly name: string; readonly log_ref: string | null }[];
  /**
   * `dependency_gate` (WP-38): the stage whose completion caused the check; `ci_settle` (WP-60): the
   * gate the pipeline's event found the task at.
   *
   * It rides the payload because it is the answer to two questions the row cannot give when the
   * job fires: where a `block` sends the task **back to**, and which stage a question belongs to so
   * that answering it resumes the run that added the package. `tasks.current_stage` is already the
   * *next* stage by then — the saga moved it on in the same transaction that completed this one.
   */
  readonly stage?: string;
  /**
   * The three `review_only_*` duties, `close_superseded_mr` (WP-59) and `merge_measure` (WP-61):
   * which merge request, and where it lives.
   */
  readonly iid?: number;
  readonly mr_url?: string;
  /** `close_superseded_mr` and `merge_measure`: the repository path the ref recorded, when it has one. */
  readonly mr_project_path?: string;
  /** `close_superseded_mr` only: the branch the reworked task continues on, named in the comment. */
  readonly new_branch?: string;
  /**
   * `notify` (WP-32): what class of thing happened, and the event's own words about it.
   *
   * They ride the payload for the reason `blocker_brief` does — no row holds them. A return
   * reason, a blocker brief and the text of a question live on the event, and the class is the
   * handler's reading of an event the duty would otherwise have to re-derive from an event store
   * it does not have. Both are re-validated on fire: the class is **parsed** against
   * `notificationClassSchema` and the detail is bounded and redacted before it is stored or sent.
   */
  readonly notification_class?: string;
  readonly notification_detail?: string;
  /** Platform text naming what the notification is about when there is no task — a budget window. */
  readonly notification_subject?: string;
  /**
   * `approval_settled` only (WP-65): how the approval was settled, from the event — the one fact
   * the edited message states that the row, reloaded on fire, must agree with.
   */
  readonly approval_decision?: string;
  /**
   * `notify` with class `approval` (WP-43), and `approval_settled` (WP-65): which approval. The duty reloads the row and
   * posts nothing for one that is no longer pending — a timer and a person may both have got there
   * first, and a button on a decided approval is the dead control WP-32 refused to ship.
   */
  readonly approval_id?: string;
  /**
   * `notify` with class `reminder` (WP-84, `reminders.ts`): which question or approval the reminder
   * is about, so the duty posts nothing for one answered or decided since the timer fired.
   */
  readonly reminder_of?: string;
  /**
   * `notify` with class `question` (WP-84 review round 1): which question, so the duty posts
   * nothing for one answered or expired since — on a retry, and on the recovery pass's re-post.
   * And `question_settled` (WP-88): which question's message to edit.
   */
  readonly question_id?: string;
  readonly reminder_aggregate?: 'question' | 'approval';
  /**
   * `revoke_run_credential` (WP-77): the run whose credential it is, and the address the mint's
   * audit row recorded — `<project>#<token_id>` on GitLab, not a secret. The duty re-reads the rest.
   */
  readonly run_id?: string;
  readonly revoke_id?: string;
  readonly [key: string]: unknown;
}

/**
 * The only way a handler asks for a provider call.
 *
 * Always from `HandlerContext.afterCommit`: `Jobs.enqueue` does not join the handler's transaction
 * (TD-004), so an enqueue written inline would be durable even when the decision that caused it
 * rolled back. The consequence — a crash between the commit and the callback loses the wake-up —
 * is the at-most-once residual `afterCommit` documents, and it is why every duty here re-derives
 * what it should do from committed state rather than trusting the payload.
 */
export const enqueueOutbound = async (jobs: Jobs, data: PipelineOutboundData): Promise<void> => {
  await jobs.enqueue<OutboundJobData>({ queue: JOB_QUEUES.pipelineOutbound, data });
};

/**
 * The one outbound duty with **no project** — an organisation-scoped notification (WP-65, PROGRESS
 * backlog 80).
 *
 * A type of its own rather than a `PipelineOutboundData` with an absent `project_id`, because every
 * other duty reads `project_id` and a field that is optional for one duty is optional for all of
 * them: twenty-odd `data.project_id as Id` casts would then compile over `undefined`. Here the
 * duty name is the discriminant, the queue handler narrows on it before anything reads a project,
 * and this payload has no `project_id` to read.
 *
 * It carries what `notify` carries for a budget window — the class and the event's own two numbers
 * as platform text — and nothing a row could answer.
 */
export interface OrganisationOutboundData {
  readonly duty: 'notify_organisation';
  readonly cause_event_id: string;
  readonly notification_class: string;
  readonly notification_subject?: string;
  readonly notification_detail?: string;
  readonly [key: string]: unknown;
}

/**
 * One wake-up of `ready_head_check` (WP-79, `ready-head.ts`) — its own payload type rather than a member of `PipelineOutboundData`'s
 * duty list, because two of its fields are required and one of the list's is not: a **resume**
 * appends no event, so there is no `cause_event_id` to give it (`OrganisationOutboundData` is the
 * precedent for a duty with a shape of its own).
 */
export interface ReadyHeadCheckData {
  readonly duty: 'ready_head_check';
  readonly project_id: string;
  readonly task_id: string;
  /** Which command asked — for the log line and the `task.resumed` reason. */
  readonly via: 'resume' | 'hand_back' | 'retry_stage' | 'retry_run';
  /** The state and stage the command saw; the duty acts only while the task is still there. */
  readonly expected_state: TaskState;
  readonly expected_stage: string;
  /** The person, so the decision's events name them as their actor, as the command's would have. */
  readonly user_id: string;
  /** A hand-back's `task.handed_back`; `null` for a resume, which appends nothing. */
  readonly cause_event_id: string | null;
  readonly [key: string]: unknown;
}

/**
 * Everything `pipeline.outbound` carries: a project's duty, the organisation's one, or a human's way
 * into Ready waiting to be judged (WP-79).
 */
export type OutboundJobData = PipelineOutboundData | OrganisationOutboundData | ReadyHeadCheckData;

/**
 * {@link enqueueOutbound} for `ready_head_check` — the same queue, and called after the command's
 * commit for the reason every outbound enqueue is.
 */
export const enqueueReadyHeadCheck = async (
  jobs: Jobs,
  data: ReadyHeadCheckData,
): Promise<void> => {
  await jobs.enqueue<OutboundJobData>({ queue: JOB_QUEUES.pipelineOutbound, data });
};

/** {@link enqueueOutbound} for the organisation's duty; the same queue and the same `afterCommit` rule. */
export const enqueueOrganisationOutbound = async (
  jobs: Jobs,
  data: OrganisationOutboundData,
): Promise<void> => {
  await jobs.enqueue<OutboundJobData>({ queue: JOB_QUEUES.pipelineOutbound, data });
};

/** Declares the pipeline's three queues from the one table (WP-86, `ports/job-queues.ts`). */
export const declarePipelineQueues = async (jobs: Jobs): Promise<void> => {
  await jobs.defineQueue(jobQueueDefinition(JOB_QUEUES.stageExecute));
  await jobs.defineQueue(jobQueueDefinition(JOB_QUEUES.mrCommentDebounce));
  await jobs.defineQueue(jobQueueDefinition(JOB_QUEUES.pipelineOutbound));
};

/** The `Jobs` port's default `expireInSeconds`, which `pipeline.outbound` does not override. */
export const DEFAULT_JOB_EXPIRE_SECONDS = 15 * 60;

/**
 * The longest a queue can still be trying a job after it was enqueued — **every** attempt's
 * expiry plus every retry delay, at the worst case of each.
 *
 * The delays are pg-boss's own backoff, read from its source rather than assumed (`pg-boss@12.30.0`,
 * `dist/plans.js`, the `start_after` expression of the fail path): retry *n* (counting from zero)
 * waits `retry_delay × (2^(n+1)/2 + 2^(n+1)/2 × random())`, so at most `retry_delay × 2^(n+1)`;
 * without backoff it waits `retry_delay`. An attempt may also hold the job for its whole expiry
 * before the queue calls it lost and retries it — that term dominates, and it is why the window of
 * `pipeline.outbound` is about 48 minutes rather than the three the delays alone would suggest.
 * An over-estimate is the safe direction: a gauge that waits too long reports a failure late, one
 * that waits too little reports a delivery that is still in flight as a failure.
 */
export const retryWindowMs = (policy: {
  readonly retryLimit: number;
  readonly retryDelaySeconds: number;
  readonly retryBackoff: boolean;
  readonly expireInSeconds?: number;
}): number => {
  const expire = policy.expireInSeconds ?? DEFAULT_JOB_EXPIRE_SECONDS;
  let delays = 0;
  for (let retry = 0; retry < policy.retryLimit; retry += 1) {
    delays += policy.retryBackoff
      ? Math.max(policy.retryDelaySeconds, 1) * 2 ** (retry + 1)
      : policy.retryDelaySeconds;
  }
  return (delays + (policy.retryLimit + 1) * expire) * 1000;
};

/**
 * How long a gate waits before asking again after answering "not yet".
 *
 * It is a `startAfter`, not a sleep, and it is not zero: a gate that re-enqueues itself with no
 * delay spins through {@link MAX_GATE_CHECKS} in a few milliseconds and parks the task for a human
 * before the pipeline it is waiting for has even started. Thirty seconds against a five-check
 * budget gives a CI pipeline two and a half minutes to reach a terminal status before anyone is
 * asked to look at it; the event (`ci.pipeline.finished`) normally arrives long before that and
 * settles the gate without a re-check at all. **Not on a poll-only git binding** (WP-136), which
 * receives no such event: there the CI gate keeps this delay for its first five checks, then asks
 * every minute until `pipeline.limits.ci_timeout_minutes` (`ci-wait.ts`).
 */
export const GATE_RECHECK_MS = 30_000;

/**
 * How long a stage waits before trying to *start* a run again after a transport failure (Q59(a)).
 *
 * The same thirty seconds as {@link GATE_RECHECK_MS}, and for the same reason: a re-enqueue with no
 * delay spins through {@link MAX_RUN_START_ATTEMPTS} in milliseconds and escalates the task before
 * the launcher it is waiting for has finished restarting. Three attempts at this delay is the whole
 * bound — about a minute of flapping absorbed, and a launcher that is down parks the task about a
 * minute later instead of never.
 */
export const RUN_START_RETRY_MS = 30_000;

/**
 * How long a handed-back stage waits before its run is started again (WP-144 ruling (a)).
 *
 * Thirty seconds, {@link RUN_START_RETRY_MS}'s: long enough for the stopped `runner` to have exited
 * and for compose (or the operator) to have started it again, short enough that a restart costs the
 * task half a minute. Any process subscribed to `stage.execute` may take it — the job is durable.
 */
export const SHUTDOWN_HAND_BACK_DELAY_MS = 30_000;

export const enqueueStage = async (
  jobs: Jobs,
  job: StageExecutionJob & {
    readonly gateChecks?: number;
    readonly startAfter?: Date;
    /** Backlog 490: a gate's provider outage, carried from one failed read to the next. */
    readonly providerOutage?: { readonly since: string; readonly failures: number };
  },
): Promise<EnqueueResult> =>
  jobs.enqueue<StageExecuteData>({
    queue: JOB_QUEUES.stageExecute,
    singletonKey: `task:${job.taskId}`,
    ...(job.startAfter === undefined ? {} : { startAfter: job.startAfter }),
    data: {
      task_id: job.taskId,
      project_id: job.projectId,
      stage: job.stage,
      attempt: job.attempt,
      ...(job.gateChecks === undefined ? {} : { gate_checks: job.gateChecks }),
      ...(job.providerOutage === undefined
        ? {}
        : {
            provider_failing_since: job.providerOutage.since,
            provider_failures: job.providerOutage.failures,
          }),
      ...(job.startAttempts === undefined ? {} : { start_attempts: job.startAttempts }),
      ...(job.overrides?.model === undefined ? {} : { model: job.overrides.model }),
      ...(job.overrides?.effort === undefined ? {} : { effort: job.overrides.effort }),
    },
  });

export const enqueueReviewCommentWindow = async (
  jobs: Jobs,
  input: {
    readonly taskId: Id;
    readonly projectId: Id;
    readonly iid: number;
    readonly windowMs: number;
    readonly now: Date;
  },
): Promise<void> => {
  await jobs.enqueue<ReviewWindowData>({
    queue: JOB_QUEUES.mrCommentDebounce,
    // One window per merge request, whatever the task: the human is commenting on the MR.
    singletonKey: `mr:${input.iid}`,
    startAfter: new Date(input.now.getTime() + input.windowMs),
    data: {
      task_id: input.taskId,
      project_id: input.projectId,
      iid: input.iid,
      opened_at: input.now.toISOString(),
    },
  });
};

export interface PipelineJobOptions extends PipelineSagaOptions, RequesterOptions {
  readonly unitOfWork: UnitOfWork;
  readonly executor: StageExecutor;
}

// `inTaskTransaction` and its options live in `./task-transaction.js` since WP-177 (the ticket claim,
// which `stage.execute` calls, needs it, and importing it from here closed a module cycle); they
// are re-exported so every caller keeps its import.
export { inTaskTransaction, type TaskTransactionOptions } from './task-transaction.js';

/**
 * `stage.execute`: an agent stage runs, a platform gate is evaluated, anything else is skipped.
 *
 * Every path re-validates: the task may have moved on, been paused or been cancelled between the
 * enqueue and the fire, and none of those is an error (TD-004 has no cancel).
 */
export const stageExecuteHandler = (
  options: PipelineJobOptions,
  /**
   * The duties the stage being entered is owed, performed before it is planned (WP-184,
   * `owed-duties.ts`'s `performOwedDuties`). A parameter rather than an import because that module
   * imports the review conversation's duties, which import this one (`enqueueOutbound`); the
   * runtime composes it, and it is required, so a composition cannot leave it out.
   */
  performOwedDuties: (
    stored: StoredTask,
    entry: { readonly stage: string; readonly attempt: number },
  ) => Promise<void>,
): JobHandler<StageExecuteData> => {
  const logger: Logger = options.logger ?? silentLogger;
  const gates = createGateEvaluator(options);

  return async (job) => {
    // The payload is a boundary, so it is parsed rather than cast: `effort` reaches the SDK, and a
    // payload written by an older build (or by hand) must not become a spec nobody validated. Since
    // backlog 490 the whole payload is, strictly — the outage clock it carries bounds a wait.
    const data = stageExecuteDataSchema.parse(job.data);
    const overrides = {
      ...(data.model === undefined ? {} : { model: data.model }),
      ...(data.effort === undefined ? {} : { effort: data.effort }),
    };
    const request: StageExecutionJob = {
      taskId: data.task_id,
      projectId: data.project_id,
      stage: data.stage,
      attempt: data.attempt,
      ...(data.start_attempts === undefined ? {} : { startAttempts: data.start_attempts }),
      ...(Object.keys(overrides).length === 0 ? {} : { overrides }),
    };

    // The task travels out of the transaction beside the stage it resolved, because the next step
    // needs it: `ensureTicketSnapshot` asks one question of the row this load already has, and
    // re-loading it would be a second transaction per agent stage for a field in hand (WP-15f,
    // review round 1).
    const admitted = await options.unitOfWork.transaction(async (scope) => {
      const stored = await options.store.tasks.load(scope.tx, request.taskId);
      if (stored === null || stored.task.currentStage !== request.stage) {
        return null;
      }
      return {
        stage: stageOf(
          compilePipeline(
            stored.task.template,
            stored.template,
            stored.pipelineDial,
            stored.qaStage,
          ),
          request.stage,
        ),
        stored,
      };
    });

    const stage = admitted?.stage ?? null;
    if (admitted === null || stage === null) {
      logger.debug(
        { task_id: request.taskId, stage: request.stage },
        'stage job found nothing to do',
      );
      return;
    }

    if (stage.kind === 'agent') {
      /**
       * **The ticket claim, before the run row exists** (WP-177, BD-031 ruling 5, TD-029 decision
       * 5): between the transactions, before the executor creates the run and asks the admission
       * guard. A refusal has already escalated the task (or found it moved on), so this wake-up
       * starts nothing — no run row is created. Gates claim nothing. `ticket-claim.ts` has the rules.
       */
      const claimed = await ensureTicketClaim(options, admitted.stored, {
        taskId: request.taskId,
        stage: request.stage,
        attempt: request.attempt,
      });
      if (claimed.kind === 'refused') {
        logger.info(
          { task_id: request.taskId, stage: request.stage, reason: claimed.reason },
          'the ticket claim was refused; no run is started',
        );
        return;
      }
      /**
       * **The ticket's own words, if this task still has none** (WP-15f).
       *
       * Here, between the transactions and before the executor, because this is the last moment
       * that is ordered with respect to the prompt: `planner.plan` reads `StoredTask` and
       * `assemblePrompt` renders it. It is the self-healing half: a task whose intake fetch failed,
       * one created before migration 0015, or one whose project gained a task-management binding
       * afterwards gets the text here instead.
       *
       * The task is handed in rather than re-loaded, so the ordinary path really is **one
       * already-loaded field** — the sentence used to say that while the function opened a second
       * transaction per agent stage to re-read the row this handler had just discarded.
       *
       * It never throws for a provider failure and never fails the stage: a run without the ticket
       * text is worse than one with it and far better than none (standing rule 20). A
       * `TransactionOpenError` **does** come out, because that is a programming error rather than a
       * provider being down.
       */
      const snapshot = await ensureTicketSnapshot(options, admitted.stored);
      /**
       * **What this stage is owed, before the plan reads it** (WP-184, TD-029 decisions 4 and 11):
       * the entry's lifecycle move and the review conversation's posts for the latest completed
       * agent run — the findings a `code_review` return left, the replies a fix wrote. Here for the
       * snapshot's reason: the planner reads the conversation once, at plan time, and the outbound
       * duties that also post them sit on a queue nothing orders against this one. Never a throw for
       * a provider; a `TransactionOpenError` comes out (`owed-duties.ts`).
       */
      await performOwedDuties(admitted.stored, {
        stage: request.stage,
        attempt: request.attempt,
      });
      // WP-73, backlog 218: a Reviewer is matched on the merge request's files too, read here for
      // the same reason as the ticket — outside every transaction, before the plan. It rethrows
      // `TransactionOpenError` as the ticket read does (WP-105, backlog 303).
      const mergeRequestPaths = await reviewedMergeRequestPaths(options, admitted.stored, stage);
      // WP-89, backlog 143: the Investigator is shown the linked issue's latest event and the log
      // lines around it — the same place and the same reason, after the ticket read because the
      // link is found in the ticket's words. `undefined` for any other stage and for a project with
      // neither binding; never a throw for a provider (`observability-prefetch.ts`).
      const observability = await prefetchObservability(options, admitted.stored, stage, snapshot);
      const outcome = await options.executor.execute({
        ...request,
        ...(mergeRequestPaths === undefined ? {} : { mergeRequestPaths }),
        ...(observability === undefined ? {} : { observability }),
      });
      /**
       * **A run that could not be *started* for a transport reason is re-enqueued here** (Q59(a)).
       *
       * The executor failed the `runs` row and left the task exactly where it was, so this is the
       * wake-up that owes it another attempt. It is an `enqueue` and not a `throw`: throwing would
       * hand the job to pg-boss's own retry policy, whose count this payload cannot see and whose
       * exhaustion is a failed job that tells nobody about the task (only an administrator's list
       * shows it, since WP-108) — which is the failure WP-15c closed. The bound
       * travels in the payload, and the escalation at the end of it is the executor's.
       *
       * `stately` frees the queued slot the moment this job starts, so this enqueue is admitted;
       * the delay is what stops it from becoming a spin.
       */
      if (outcome.kind === 'retry') {
        await enqueueStage(options.jobs, {
          ...request,
          startAttempts: outcome.startAttempts,
          startAfter: new Date(Date.parse(options.clock.now()) + RUN_START_RETRY_MS),
        });
      }
      /**
       * **A run handed back by this process's stop** (WP-144): the same stage entry, again, after
       * {@link SHUTDOWN_HAND_BACK_DELAY_MS}. This handler is still running inside the worker's
       * drain, and pg-boss is stopped after the pipeline's workers (`apps/server/src/runtime.ts`'s
       * order), so the enqueue lands; the bound is the executor's (`MAX_SHUTDOWN_HAND_BACKS`, read
       * off the runs), so nothing rides the payload. The start-attempt count does not carry over:
       * a hand-back is not a start failure.
       */
      if (outcome.kind === 'handed_back') {
        /**
         * **A dropped re-enqueue is stated, not silent** (WP-149, PROGRESS backlog 445): the queue
         * is `stately` per task, so when another job for the task is already queued the enqueue is
         * `coalesced` and this entry's wake-up does not exist. Nothing is lost that the bound needs
         * — it is read off the runs, not a payload — and the queued job re-validates against the
         * task; if it is for something else and the entry is left with an ended run and no job,
         * the stranded-stage recovery (`recovery/stranded-stage.ts`, WP-108) finds it and escalates.
         */
        const requeued = await enqueueStage(options.jobs, {
          taskId: request.taskId,
          projectId: request.projectId,
          stage: request.stage,
          attempt: request.attempt,
          ...(request.overrides === undefined ? {} : { overrides: request.overrides }),
          startAfter: new Date(Date.parse(options.clock.now()) + SHUTDOWN_HAND_BACK_DELAY_MS),
        });
        if (requeued.status === 'coalesced') {
          logger.warn(
            { task_id: request.taskId, stage: request.stage, attempt: request.attempt },
            'a handed-back stage was not re-enqueued: another job for the task is already queued; the stranded-stage recovery escalates the entry if that job does not run it',
          );
        }
      }
      /**
       * **A wake-up for an attempt the task has left is forwarded to the one it is on** (PROGRESS
       * backlog 494). The queue is `stately` per task — one job waiting, one running — so a
       * person's second retry while the first retry's job still waits behind a live run is
       * `coalesced` onto that waiting job, which then fires for an attempt that was superseded
       * and would skip with the newest attempt left with no job at all. This job is running, so the
       * waiting slot is free again and the forward is admitted; when the newer attempt's own job is
       * already waiting it coalesces, which is that job. Bounded: the forwarded job is for the
       * task's current attempt, so it never forwards again unless a person moves the task again.
       */
      if (outcome.kind === 'skipped' && outcome.supersededBy !== undefined) {
        const forwarded = await enqueueStage(options.jobs, {
          taskId: request.taskId,
          projectId: request.projectId,
          stage: request.stage,
          attempt: outcome.supersededBy,
        });
        logger.info(
          {
            task_id: request.taskId,
            stage: request.stage,
            attempt: request.attempt,
            current_attempt: outcome.supersededBy,
            forwarded: forwarded.status,
          },
          'a superseded stage wake-up was forwarded to the attempt the task is on',
        );
      }
      logger.info(
        {
          task_id: request.taskId,
          stage: request.stage,
          outcome: outcome.kind,
          // WP-108 review round 2: a skip says why (a closed attempt row among them, backlog 365).
          ...(outcome.kind === 'skipped' ? { reason: outcome.reason } : {}),
        },
        'stage executed',
      );
      return;
    }

    if (stage.kind !== 'gate') {
      return;
    }

    const stored = await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.load(scope.tx, request.taskId),
    );
    // Not `state === 'active'`: `merged_gate` is entered in the `merged` state, and
    // `ready_for_merge` is its own state too. What disqualifies a gate is the task having stopped
    // — finished, cancelled, paused, parked for a human, or waiting for an answer.
    if (stored === null || !isRunnableTaskState(stored.task.state)) {
      return;
    }
    const result = await gates.evaluate(stage, stored);

    if (result.kind === 'unreachable') {
      await waitForProvider(options, request, data, result);
      return;
    }

    const checks = (data.gate_checks ?? 0) + 1;

    if (result.kind === 'pending') {
      // WP-136: the CI gate on a poll-only binding is bounded by time, not by the five checks —
      // unless its attempt has no row to time it from, which keeps the five checks below.
      if (
        result.ciWait !== undefined &&
        (await waitForPollOnlyCi(options, request, result.detail, result.ciWait, checks))
      ) {
        return;
      }
      if (checks >= MAX_GATE_CHECKS) {
        await settle(options, request, {
          kind: 'escalate',
          outcome: 'undecided',
          reason: `the "${request.stage}" gate could not be decided after ${checks} attempts: ${result.detail}`,
          blockerBrief:
            `The "${request.stage}" gate for this task still has no answer after ${checks} checks (${result.detail}). ` +
            'Look at the merge request or the pipeline yourself, then hand the task back.',
        });
        return;
      }
      // The gate has no answer yet. `stately` frees the queued slot the moment this job starts, so
      // re-enqueuing here is the timer that asks again — delayed, or it is a spin.
      await enqueueStage(options.jobs, {
        ...request,
        gateChecks: checks,
        startAfter: new Date(Date.parse(options.clock.now()) + GATE_RECHECK_MS),
      });
      return;
    }

    if (result.kind === 'unsupported') {
      await settle(options, request, {
        kind: 'escalate',
        outcome: 'unsupported',
        reason: result.detail,
        blockerBrief: `The platform cannot evaluate the "${request.stage}" gate: ${result.detail}. Decide it yourself and hand the task back at the stage that should run next.`,
      });
      return;
    }

    await settle(options, request, gateSettlementOf(request.stage, result));

    /**
     * The rebase gate's own measurement, after the settlement and in a transaction of its own
     * (WP-26, product/16: *"conflicts auto-resolved vs escalated"*).
     *
     * **After**, because `stream_seq` has to be read where the append happens and the settlement
     * has just written the transition's events. **From `stored`**, because the content is the check
     * the gate made on the snapshot it evaluated — a row that agreed with the transition but not
     * with the read would be a measurement of neither.
     */
    if (request.stage === REBASE_GATE_STAGE && stored.mr !== null) {
      await recordRebaseCheck(options, {
        taskId: request.taskId,
        mr: stored.mr,
        conflicts: !result.passed,
        attempts: stored.task.iterationCounters.rebase ?? 0,
        limit: stored.task.limits.rebase,
        causeEventId: null,
      });
    }
  };
};

/**
 * Applies a decision from outside a handler: its own transaction, its own follow-up enqueue.
 *
 * The transaction is this job's, so the retry on a refused write is this job's too (WP-15e):
 * `retryOnTaskConflict` re-runs the whole unit, which re-reads the task and re-interprets the
 * signal against whatever the other writer left. Nothing outside the transaction is repeated — the
 * `enqueueStage` below runs once, after it commits.
 */
export type GateSettlement =
  | {
      readonly kind: 'gate_settled';
      readonly stage: Slug;
      readonly passed: boolean;
      readonly detail: string;
      /**
       * A failed CI gate's stable identity (`ciFailureSignature`). When present the settlement
       * records it and escalates on the third identical one in a row (product/04 S4) — in the
       * settlement's own transaction, so the poll path and the event path (`ci-settle.ts`, WP-60
       * review round 2) share one convergence rule.
       */
      readonly ciSignature?: string;
      /**
       * The head the gate judged (WP-79). Recorded as `tasks.ready_head_sha` when this settlement
       * enters `ready_for_merge` — through `applyDecision`, the column's one writer — and ignored
       * by every other move.
       */
      readonly headSha?: string;
      /**
       * The word the gate's row is closed with instead of the default (WP-81): the CI gate's tamper
       * check — `protected_paths_changed` on its return, `protected_paths_awaiting_review` on a
       * provisional pass. Handed to `applyDecision` as `stageOutcome`.
       */
      readonly outcome?: TaskStageOutcome;
      /**
       * The protected paths a provisional CI pass excused (WP-102), recorded as
       * `tasks.ci_excused_paths` by this settlement and compared with the latest Review Verdict by
       * the rebase gate's.
       */
      readonly excusedPaths?: readonly string[];
      /**
       * The uncut length of `detail` when the gate cut the failing job's log (WP-81), recorded beside
       * the return reason so the next run's `return_feedback` marker announces the cut.
       */
      readonly detailOriginalChars?: number;
    }
  | {
      readonly kind: 'escalate';
      /**
       * The word the gate's row is closed `failed` with (WP-46, backlog 160): `undecided` (still
       * pending after `MAX_GATE_CHECKS`, or — the CI gate on a poll-only binding, WP-136 — after
       * its CI timeout) or `unsupported` (the project's providers cannot answer).
       */
      readonly outcome: TaskStageOutcome;
      readonly reason: string;
      readonly blockerBrief: string;
    };

/**
 * A settled {@link GateResult} as the settlement's signal — one conversion for the poll and for the
 * pipeline's event (`ci-settle.ts`), so a field the gate answers cannot reach one path and not the
 * other (WP-102: `excusedPaths`).
 */
export const gateSettlementOf = (
  stage: Slug,
  result: Extract<GateResult, { kind: 'settled' }>,
): GateSettlement => ({
  kind: 'gate_settled',
  stage,
  passed: result.passed,
  detail: result.detail,
  ...(result.ciSignature === undefined ? {} : { ciSignature: result.ciSignature }),
  ...(result.headSha === undefined ? {} : { headSha: result.headSha }),
  ...(result.outcome === undefined ? {} : { outcome: result.outcome }),
  ...(result.excusedPaths === undefined ? {} : { excusedPaths: result.excusedPaths }),
  ...(result.detailOriginalChars === undefined
    ? {}
    : { detailOriginalChars: result.detailOriginalChars }),
});

/**
 * **A pending CI read on a poll-only binding** (WP-136, `ci-wait.ts`): re-check on the cadence,
 * or park at the CI timeout or the backstop. Answers whether it decided; `false` only for an
 * attempt with no `task_stages` row, which has no instant to time the wait from — the caller then
 * keeps the five-check bound rather than inventing a clock (standing rule 16).
 *
 * The entry is read in a transaction of its own, after the provider reads and before any write.
 * A **closed** row is a job of an attempt somebody left — a hand-back at `ci_gate` opened a new one,
 * whose own job carries its own clock — so this fire does nothing (TD-004: a timer cannot be
 * cancelled, so it re-validates).
 */
const waitForPollOnlyCi = async (
  options: PipelineJobOptions,
  request: StageExecutionJob,
  detail: string,
  wait: CiWait,
  checks: number,
): Promise<boolean> => {
  const logger: Logger = options.logger ?? silentLogger;
  const entry = await options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.stageAttemptEntry(scope.tx, request.taskId, request.stage, request.attempt),
  );
  const fields = { task_id: request.taskId, stage: request.stage, attempt: request.attempt };
  if (entry === null) {
    logger.warn(
      fields,
      'the CI gate has no stage row to time its wait from; it keeps the five-check bound',
    );
    return false;
  }
  if (!entry.open) {
    logger.info(fields, 'a CI gate check of an attempt that is no longer open does nothing');
    return true;
  }
  const now = Date.parse(options.clock.now());
  const decision = decideCiWait({
    enteredAtMs: Date.parse(entry.enteredAt),
    nowMs: now,
    checks,
    timeoutMinutes: wait.timeoutMinutes,
  });
  if (decision.kind === 'recheck') {
    await enqueueStage(options.jobs, {
      ...request,
      gateChecks: checks,
      startAfter: new Date(now + decision.delayMs),
    });
    return true;
  }
  logger.info(
    { ...fields, checks, timeout_minutes: wait.timeoutMinutes, ending: decision.kind, detail },
    'the CI gate on a poll-only binding stopped waiting; the task is parked',
  );
  await settle(options, request, {
    kind: 'escalate',
    outcome: 'undecided',
    reason: `${ciWaitReason(wait, decision, checks)}; the last read: ${detail}`,
    blockerBrief: ciWaitBrief(wait, decision, checks),
  });
  return true;
};

/**
 * **A gate whose provider did not answer** (PROGRESS backlog 490, `gate-outage.ts`): re-ask with a
 * growing delay until the gate's own bound, then park the task with a brief naming the provider and
 * the failure — never a thrown job, whose retries pg-boss spends in minutes and whose exhaustion the
 * stranded-stage recovery could only describe as a stage that *"never started"*.
 *
 * `gate_checks` rides through unchanged: a failed read is not a check. The bound:
 *  - the CI gate on a **poll-only** binding: WP-136's own clock — `ci_timeout_minutes` from the
 *    attempt's `task_stages.entered_at`, read here; a **closed** row is an attempt somebody left,
 *    and this fire does nothing (as in {@link waitForPollOnlyCi}). An attempt with no row is timed
 *    from the first failure instead, the fail-closed direction of the same bound;
 *  - every other gate: {@link GATE_OUTAGE_LIMIT_MINUTES} from the first failure in a row.
 */
const waitForProvider = async (
  options: PipelineJobOptions,
  request: StageExecutionJob,
  data: z.infer<typeof stageExecuteDataSchema>,
  outage: GateProviderOutage,
): Promise<void> => {
  const logger: Logger = options.logger ?? silentLogger;
  const nowIso = options.clock.now();
  const nowMs = Date.parse(nowIso);
  const since = data.provider_failing_since ?? nowIso;
  const sinceMs = Date.parse(since);
  const failures = (data.provider_failures ?? 0) + 1;
  const fields = {
    task_id: request.taskId,
    stage: request.stage,
    attempt: request.attempt,
    provider: outage.provider,
    host: outage.host,
    code: outage.code,
    failures,
    failing_since: since,
  };

  let bound: GateOutageBound;
  let deadlineMs: number;
  if (outage.ciTimeoutMinutes === null) {
    bound = { kind: 'ceiling', minutes: GATE_OUTAGE_LIMIT_MINUTES };
    deadlineMs = sinceMs + GATE_OUTAGE_LIMIT_MINUTES * 60_000;
  } else {
    const entry = await options.unitOfWork.transaction(async (scope) =>
      options.store.tasks.stageAttemptEntry(
        scope.tx,
        request.taskId,
        request.stage,
        request.attempt,
      ),
    );
    if (entry !== null && !entry.open) {
      logger.info(fields, 'a gate read of an attempt that is no longer open does nothing');
      return;
    }
    bound = { kind: 'ci_timeout', minutes: outage.ciTimeoutMinutes };
    deadlineMs =
      (entry === null ? sinceMs : Date.parse(entry.enteredAt)) + outage.ciTimeoutMinutes * 60_000;
  }

  const decision = decideGateOutage({ nowMs, deadlineMs, failures, limitMinutes: bound.minutes });
  if (decision.kind === 'recheck') {
    logger.warn(
      { ...fields, err: outage.error, retry_in_ms: decision.delayMs },
      'the provider did not answer the gate; the gate asks again (PROGRESS backlog 490)',
    );
    await enqueueStage(options.jobs, {
      ...request,
      ...(data.gate_checks === undefined ? {} : { gateChecks: data.gate_checks }),
      providerOutage: { since, failures },
      startAfter: new Date(nowMs + decision.delayMs),
    });
    return;
  }
  const facts = {
    stage: request.stage,
    where: outage.host ?? outage.provider,
    code: outage.code,
    failures,
    minutes: Number.isFinite(sinceMs) ? Math.round((nowMs - sinceMs) / 60_000) : null,
    bound,
  };
  logger.warn(
    { ...fields, err: outage.error, ending: decision.kind },
    'the provider did not answer the gate within its bound; the task is parked (PROGRESS backlog 490)',
  );
  await settle(options, request, {
    kind: 'escalate',
    outcome: 'undecided',
    reason: gateOutageReason(facts, decision),
    blockerBrief: gateOutageBrief(facts),
  });
};

/** {@link settle}, for a duty that settles a gate outside `stage.execute` (`ci-settle.ts`). */
export const settleGate = async (
  options: TaskTransactionOptions,
  request: Pick<StageExecutionJob, 'taskId' | 'stage'>,
  signal: GateSettlement,
): Promise<void> => settle(options, request, signal);

/**
 * **The attempt the settlement is for** (WP-149, backlog 438): every settlement `stage.execute`
 * makes carries its job's attempt, and the transaction below refuses one whose `task_stages` row is
 * **closed** — a hand-back at the same gate between the job's reads and this transaction closed it
 * and opened the next attempt, whose own job carries its own clock and checks. Without it the stage
 * and the state both still matched, so a poll-only wait's timeout read of attempt N parked attempt
 * N + 1. An **absent** row (a task entered before every entry opened one) settles, the fail-open
 * direction `stageAttemptState` documents. `ci-settle.ts` names no attempt: a finished pipeline is
 * judged against whatever attempt is open, which its own head check already re-validates.
 */
type SettlementRequest = Pick<StageExecutionJob, 'taskId' | 'stage'> & {
  readonly attempt?: number;
};

const settle = async (
  options: TaskTransactionOptions,
  request: SettlementRequest,
  signal: GateSettlement,
): Promise<void> => {
  const work = await inTaskTransaction(
    options,
    request.taskId,
    'settling a gate',
    async (scope) => {
      const stored = await options.store.tasks.load(scope.tx, request.taskId);
      /**
       * **The state is re-read here, not only before the gate was evaluated** (WP-38).
       *
       * Evaluating a gate is a provider read, and anything may park the task while it is in flight:
       * a human pauses or takes it over, or — since WP-38 — the dependency gate asks a blocking
       * question from a `pipeline.outbound` job, which is a different queue from this `stately`
       * one. The stage is unchanged in all of those cases, so the old check passed and
       * `applyDecision` was handed a settlement for a task in `waiting_answers`; the state machine
       * refused the move and the generic fallback **escalated the task**, with a blocker brief
       * blaming *"a template that does not match the platform's task states"*.
       *
       * Measured on `dependency-gate.e2e.test.ts` before this line existed: `task.question.asked`
       * followed by `task.escalated` — *"illegal transition waiting_answers -> ready_for_merge"* —
       * on a task whose only fault was being asked a question while the rebase gate was reading.
       * Dropping a settlement for a task that has stopped is the right ending: the gate is
       * re-entered when the task resumes.
       */
      if (
        stored === null ||
        stored.task.currentStage !== request.stage ||
        !isRunnableTaskState(stored.task.state)
      ) {
        return null;
      }
      if (
        request.attempt !== undefined &&
        (await options.store.tasks.stageAttemptState(
          scope.tx,
          request.taskId,
          request.stage,
          request.attempt,
        )) === 'closed'
      ) {
        options.logger?.info(
          { task_id: request.taskId, stage: request.stage, attempt: request.attempt },
          'a gate settlement for an attempt that is no longer open does nothing',
        );
        return null;
      }
      const pipeline = compilePipeline(
        stored.task.template,
        stored.template,
        stored.pipelineDial,
        stored.qaStage,
      );
      const converged =
        signal.kind === 'gate_settled' && !signal.passed && signal.ciSignature !== undefined
          ? await ciConvergence(options, scope, stored, signal.stage, signal.ciSignature)
          : null;
      /**
       * **The head CI judged, and what it excused** (WP-79 review round 2, PROGRESS backlog 275;
       * WP-102): the one write of `tasks.ci_head_sha` — the head a passing CI settlement read,
       * `null` for a failing one — and of `tasks.ci_excused_paths`, the protected paths a
       * provisional pass excused until the Code review confirms them (empty for every other
       * settlement, so a list never outlives the settlement that wrote it). The rebase gate's
       * settlement below reads both before it lets the task into Ready.
       */
      if (signal.kind === 'gate_settled' && signal.stage === CI_GATE_STAGE) {
        await options.store.tasks.saveCiSettlement(scope.tx, stored.task.id, {
          headSha: signal.passed ? (signal.headSha ?? null) : null,
          excusedPaths: signal.passed ? (signal.excusedPaths ?? []) : [],
        });
      }
      /**
       * **Ready only for a head CI passed** (WP-79 review round 2, backlog 275). A passing rebase
       * gate whose head is not the one CI passed re-enters `ci_gate` instead of Ready — a push
       * between the two gates, or a human's hand-back past CI. A **forward** move, like the
       * ready-head duty's: a new head is not a failure, so it is not a return and spends none of
       * BD-008's failure loops. It is **bounded** by the existing `rebase_rechecks` (default 10,
       * `pipeline.limits.rebase_rechecks`), which it shares with the default-branch re-check because
       * both are *the branch moved under a gate that had passed, look again* — so a branch that is
       * pushed after every CI pass cannot loop CI ↔ rebase for ever: the eleventh re-entry escalates
       * the task to `needs_human` with a brief (`spendLoop` in `transitions.ts` checks and spends it
       * together). No new counter.
       */
      const againstCi =
        signal.kind === 'gate_settled' &&
        signal.stage === REBASE_GATE_STAGE &&
        signal.passed &&
        converged === null
          ? rebaseAgainstCi(pipeline, stored.ciHeadSha, signal.headSha)
          : ({ kind: 'agree' } as const);
      /**
       * **The tamper check's second half** (WP-102, Q109 answered (b)): a passing rebase gate that
       * agrees with the head CI passed compares the paths CI excused provisionally with the latest
       * Review Verdict — here, in this transaction, with no provider call
       * (`tamper-confirmation.ts`). Not confirmed returns the task on `ci_fix`, the return `ci_gate`
       * would have made; a head that moved never gets here, it re-enters `ci_gate` above.
       */
      const confirmation =
        signal.kind === 'gate_settled' &&
        signal.stage === REBASE_GATE_STAGE &&
        signal.passed &&
        converged === null &&
        againstCi.kind === 'agree'
          ? await confirmExcusedPaths(options.store, scope.tx, stored)
          : null;
      const settledWord: TaskStageOutcome | undefined =
        confirmation === null
          ? signal.kind === 'gate_settled'
            ? signal.outcome
            : undefined
          : confirmation.kind === 'confirmed'
            ? 'protected_paths_confirmed'
            : 'protected_paths_changed';
      const decision =
        againstCi.kind === 'reenter_ci'
          ? ({ kind: 'enter', stage: CI_GATE_STAGE } as const)
          : confirmation?.kind === 'unconfirmed'
            ? unconfirmedTamperReturn(pipeline, stored, confirmation.paths)
            : signal.kind === 'escalate'
              ? ({
                  kind: 'escalate',
                  reason: signal.reason,
                  blockerBrief: signal.blockerBrief,
                } as const)
              : (converged ?? interpret(pipeline, signal));
      /**
       * A failed CI settlement names what its tamper check found on the row it **returns** from
       * (WP-105). A template whose `ci_gate.fail_to` points forward closes the row `completed`
       * instead, and there a tamper word would read as the pipeline's pass — so that row keeps the
       * gate's `fail` (no shipped template does this).
       */
      const settledOutcome: TaskStageOutcome | undefined =
        signal.kind === 'gate_settled' &&
        !signal.passed &&
        decision.kind !== 'return' &&
        (settledWord === 'protected_paths_clean' ||
          settledWord === 'protected_paths_awaiting_review')
          ? undefined
          : settledWord;
      const applied = await applyDecision({
        store: options.store,
        pipeline,
        tx: scope.tx,
        stored,
        decision,
        ...(signal.kind === 'gate_settled' && converged === null && againstCi.kind === 'agree'
          ? {
              signal,
              // WP-81: the tamper check's word for the gate's row, and the log cut the return's
              // reason carries — both read only by the settlement they came with. WP-102: the
              // rebase gate's row carries the confirmation's word.
              ...(settledOutcome === undefined ? {} : { stageOutcome: settledOutcome }),
              ...(signal.detailOriginalChars === undefined
                ? {}
                : { returnReasonOriginalChars: signal.detailOriginalChars }),
            }
          : {}),
        ...(againstCi.kind === 'reenter_ci'
          ? {
              spendLoop: {
                loop: 'rebase_rechecks' as const,
                reason: againstCi.reason,
                spentBrief: `The branch of ${stored.task.ticket.key} moved under a passed gate as many times as rebase_rechecks allows — the last time because ${againstCi.reason} — so the rebase gate stopped sending it back to CI. Find what moves the branch after CI (a push, or the default branch), then hand the task back at ci_gate.`,
              },
            }
          : {}),
        // WP-79: what a later human way into Ready is compared with, if this settlement enters it.
        ...(signal.kind === 'gate_settled' &&
        signal.headSha !== undefined &&
        againstCi.kind === 'agree'
          ? { readyHeadSha: signal.headSha }
          : {}),
        // What the gate's row is closed with when this settlement parks the task instead of moving
        // it (WP-46, backlog 160) — all three of the gate's escalations come through here.
        ...(signal.kind === 'escalate'
          ? { escalationOutcome: signal.outcome }
          : converged === null
            ? {}
            : { escalationOutcome: 'converged' }),
        context: {
          ids: options.ids,
          actor: { kind: 'system', component: 'pipeline' },
          clock: options.clock as never,
          correlationId: stored.task.id,
          causeEventId: null,
        },
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      await scope.events.append(applied.events);
      return applied.work;
    },
  );
  if (work !== null) {
    await enqueueStage(options.jobs, work);
  }
};

/**
 * product/04 S4: *"Three identical failures in a row stop the loop early."* — moved here from the
 * saga's `ci.pipeline.finished` handler at WP-60 review round 2, so it holds on both settlement
 * paths. Records this failure's signature and answers the escalation when it completes a streak of
 * three, or `null` to settle normally.
 */
const ciConvergence = async (
  options: TaskTransactionOptions,
  scope: TransactionScope,
  stored: StoredTask,
  stage: Slug,
  signature: string,
): Promise<{
  readonly kind: 'escalate';
  readonly reason: string;
  readonly blockerBrief: string;
} | null> => {
  const recent = await options.store.tasks.recentStageSignatures(
    scope.tx,
    stored.task.id,
    stage,
    CONVERGENCE_LOOKBACK,
  );
  await options.store.tasks.recordStageSignature(scope.tx, {
    taskId: stored.task.id,
    stage,
    attempt: stored.task.stageAttempts[stage] ?? 1,
    signature,
  });
  // One pipeline counts once (WP-60 review round 3): consecutive observations of the same pipeline
  // — the poll and its event, or two polls of a head nobody moved — collapse into one failure, so
  // "three in a row" means three pipelines, whichever path settled each.
  const failures = distinctPipelines([...recent, signature]).map((entry) => entry.shape);
  if (!hasIdenticalFailureStreak(failures, 3)) {
    return null;
  }
  const failing = shapeOf(signature).split(':').slice(2).join(':');
  return {
    kind: 'escalate',
    reason: 'the same CI failure three times in a row',
    blockerBrief:
      `The pipeline for ${stored.task.ticket.key} has failed three times with exactly the same jobs (${failing || 'none reported'}). ` +
      'Another Implementation pass is unlikely to change it. Look at the job log, fix what is wrong, and hand the task back.',
  };
};

/** How far back the streak looks: enough attempts that collapsing repeats still leaves three. */
const CONVERGENCE_LOOKBACK = 10;

/** `ci:<status>:<jobs>` — a signature without its pipeline, which is what "identical" compares. */
const shapeOf = (signature: string): string => {
  const at = signature.lastIndexOf('@');
  return at === -1 ? signature : signature.slice(0, at);
};

/**
 * Oldest first, with consecutive entries for the **same pipeline** collapsed into one. A signature
 * written before WP-60's round 3 carries no `@<sha>` and is its own pipeline.
 */
const distinctPipelines = (
  signatures: readonly string[],
): readonly { readonly shape: string; readonly pipeline: string | null }[] => {
  const out: { shape: string; pipeline: string | null }[] = [];
  for (const signature of signatures) {
    const at = signature.lastIndexOf('@');
    const pipeline = at === -1 ? null : signature.slice(at + 1);
    const previous = out.at(-1);
    if (pipeline !== null && previous?.pipeline === pipeline) {
      continue;
    }
    out.push({ shape: shapeOf(signature), pipeline });
  }
  return out;
};

/**
 * `mr.comment.debounce`: the **human-return window** closed — read the four signals and act once
 * (WP-178, TD-029 decisions 6–9, BD-031 ruling 4, the amendment to BD-007).
 *
 * Until WP-178 this window read only the merge request's **resolvable, unresolved** threads, at
 * `ready_for_merge` only, and returned the task on their count: a GitLab general note
 * (`resolvable: false`) armed it and was then dropped, and a ticket comment or a status change never
 * reached it (PROGRESS § "Architect ruling (M10 head, session 15)", measurements 1–3). It now covers
 * both human stages, `qa` and `ready_for_merge` ({@link humanReturnStageOf}), and when it fires it
 * re-reads the ticket's status, every discussion of the merge request and the ticket's comments
 * since the **horizon** — the start of the task's latest `implementation` run — and decides with the
 * domain's `humanReturnDecision`. **Five events arm it** (`reviewCommentHandler`, `saga.ts`): the
 * four signals' own (`mr.review.comment`, `ticket.comment.added`, `ticket.status.changed`,
 * `ticket.updated`) and, since WP-179 (TD-029 decision 7 amendment (g), PROGRESS backlog 544), the
 * task's entry into `qa` or `ready_for_merge` — so a word written while the review stages or the
 * gates ran is decided by the entry's firing rather than waiting for the next signal; WP-178 had the
 * four alone. Four endings, and the first two are the reason this is not a coalesced job:
 *
 *  - nothing returns and nothing passes → nothing (an acknowledgement, a resolved thread, a word
 *    older than the horizon, the platform's own note);
 *  - a person wrote inside the last window → open another window instead of deciding now;
 *  - **return** → one `interpret` with `mr.review.comment` (every form, decision 7) carrying the
 *    redacted feedback, `task.human_return` naming the forms, and the ticket claim marked stale —
 *    all in one transaction;
 *  - **pass** (only at `qa`) → one `interpret` with `ticket.status.changed`, which leads to
 *    `ready_for_merge` (decision 9).
 *
 * Every ending records the thread counts the Checks panel reads, as before (WP-46).
 */
export const reviewWindowHandler = (options: PipelineJobOptions): JobHandler<ReviewWindowData> =>
  /**
   * **Bound and escalate** (WP-124, TD-004's M7 amendment, PROGRESS backlog 366): a window whose
   * every try failed used to leave the task at its human stage with the people's words unanswered
   * and only an administrator's failed-jobs list saying so. Its last try now escalates the task
   * with a brief first (`job-escalation.ts`), and the throw still ends the job.
   */
  escalatingOnLastTry(options, reviewWindowWork(options), (job) =>
    describeExhaustedReviewWindow(job.data),
  );

/**
 * The review window's brief, from its payload alone — shared by the wrapper above and the
 * `expired_job` recovery row (WP-156, PROGRESS backlog 421), which reads an expired window off
 * pg-boss's table.
 */
export const describeExhaustedReviewWindow = (
  data: ReviewWindowData,
): Omit<ExhaustedJob, 'tries'> => ({
  taskId: data.task_id as Id,
  projectId: data.project_id as Id,
  queue: JOB_QUEUES.mrCommentDebounce,
  duty: null,
  causeEventId: null,
  what: `turn the review comments on merge request !${data.iid} into a return`,
  remedy:
    'The comments are on the merge request; read them, then return the task to the stage that should answer them, or hand it back at Ready.',
});

/** The stage whose latest run's start is the window's horizon (TD-029 decision 7). */
const HORIZON_STAGE = 'implementation' as Slug;
/** How many of the ticket's status changes since its entry into the human stage the window reads. */
const MAX_WINDOW_STATUS_CHANGES = 50;

/** What the window read inside its first transaction. */
interface WindowRead {
  readonly stored: StoredTask;
  readonly stage: HumanReturnStage;
  readonly horizon: string | null;
  /** The ticket's status changes since the stage's entry, newest first (`leftQa`). */
  readonly statusChanges: readonly TicketStatusChange[];
  /** The same changes oldest first, bounded from the entry's side — what the entry is read from. */
  readonly earliestChanges: readonly TicketStatusChange[];
}

const reviewWindowWork = (options: PipelineJobOptions): JobHandler<ReviewWindowData> => {
  const logger: Logger = options.logger ?? silentLogger;

  return async (job) => {
    const windowMs = options.reviewCommentWindowMs ?? 2 * 60_000;
    const read = await options.unitOfWork.transaction(async (scope): Promise<WindowRead | null> => {
      const stored = await options.store.tasks.load(scope.tx, job.data.task_id);
      const stage = stored === null ? null : humanReturnStageOf(stored);
      if (stored === null || stage === null || stored.mr === null) {
        return null;
      }
      return {
        stored,
        stage,
        horizon: await options.store.runs.latestStartedAt(scope.tx, {
          taskId: stored.task.id,
          stage: HORIZON_STAGE,
        }),
        statusChanges: await options.store.tasks.ticketStatusChangesSinceEntry(scope.tx, {
          taskId: stored.task.id,
          stage: stage === 'qa' ? QA_STAGE_ID : READY_FOR_MERGE_STAGE,
          limit: MAX_WINDOW_STATUS_CHANGES,
        }),
        // Both stages since the WP-178 review: the entry is read from the earliest changes, so the
        // bound is taken from the entry's side (TD-029 decision 7's amendment (e)).
        earliestChanges: await options.store.tasks.ticketStatusChangesSinceEntry(scope.tx, {
          taskId: stored.task.id,
          stage: stage === 'qa' ? QA_STAGE_ID : READY_FOR_MERGE_STAGE,
          limit: MAX_WINDOW_STATUS_CHANGES,
          order: 'oldest_first',
        }),
      };
    });
    if (read === null || read.stored.mr === null) {
      logger.debug({ task_id: job.data.task_id }, 'review window found nothing to do');
      return;
    }
    const { stored, stage, horizon } = read;
    const mr = read.stored.mr;
    const settings = await options.settings.forProject(stored.task.projectId);
    // The window closes outside any run, so the call's scope holds no minted credential (Q55).
    const integrations = await integrationsForProject(
      options.integrations,
      stored.task.projectId,
      noRunScopedSecrets(),
    );
    const context = { projectId: stored.task.projectId, taskId: stored.task.id };
    const discussions =
      integrations.git === null ? null : await gitReads(integrations).discussions(mr, context);
    if (discussions !== null) {
      /**
       * **The count, kept where it was computed** (WP-46, PROGRESS backlog 95 item 3): the Checks
       * panel's *"review threads open/resolved"*. Written on **every** ending of the window — a
       * window that finds everything resolved is the reading a maintainer most wants to see — in a
       * transaction of its own, through the narrow writer, because this job runs beside the stage
       * executor (standing rule 79). Written before any decision so an ending that does not return
       * still records what it read. A project with no git binding records nothing: `{open: 0}`
       * would say the threads were read.
       */
      await options.unitOfWork.transaction(async (scope) =>
        options.store.tasks.saveReviewThreads(
          scope.tx,
          job.data.task_id,
          reviewThreadCounts(discussions, options.clock.now()),
        ),
      );
    }
    const lifecycle = settings.ticketLifecycle;
    const ticket =
      lifecycle === null
        ? null
        : await ticketReads(integrations).ticket(stored.task.ticket, context);
    const observed =
      ticket === null || lifecycle === null
        ? null
        : await observeEntryStatus(options, read, ticket.status, lifecycle.slots);
    const comments = await windowComments(integrations, stored, horizon, logger);
    if (discussions === null && ticket === null && comments === null) {
      logger.debug({ task_id: job.data.task_id }, 'review window has no binding to read');
      return;
    }
    const words = [...mergeRequestWords(discussions ?? []), ...ticketCommentWords(comments ?? [])];

    const now = new Date(options.clock.now());
    const newest = personsWordsSince(words, horizon)
      .map((word) => Date.parse(word.at))
      .reduce((latest, at) => (Number.isNaN(at) ? latest : Math.max(latest, at)), 0);
    if (newest > 0 && now.getTime() - newest < windowMs) {
      // Somebody is still typing. Open another window rather than deciding now: this is the
      // extending half of the debounce, built from a timer that cannot be cancelled.
      await enqueueReviewCommentWindow(options.jobs, {
        taskId: stored.task.id,
        projectId: stored.task.projectId,
        iid: mr.iid,
        windowMs,
        now,
      });
      return;
    }

    const slots = { lifecycle: lifecycle?.slots ?? {}, pickUpFrom: lifecycle?.pickUpFrom ?? null };
    const decision = humanReturnDecision({
      stage,
      slots,
      status: ticket?.status ?? null,
      words,
      horizon,
      // Criterion (11): the words a project added through the settings write (technical/12). The
      // repository file's value never reaches `config` — it is graded not applied.
      extraAcks: settings.config.human_returns?.acknowledgements ?? [],
      leftQa: leftQaOf(read.statusChanges, slots.lifecycle.qa),
      entryStatus: observed?.entryStatus ?? null,
      seenAtQa: observed?.seenAtQa ?? false,
    });
    if (decision.kind === 'none') {
      logger.debug(
        { task_id: stored.task.id, stage },
        'review window: no person’s word or status returns the task, and nothing passes it',
      );
      return;
    }
    const work =
      decision.kind === 'return'
        ? await returnForHumanWords(options, read, integrations, words, decision)
        : await passQa(options, read);
    if (work !== null) {
      await enqueueStage(options.jobs, work);
    }
  };
};

/**
 * **The ticket's status at the human stage's entry** (WP-178 review, TD-029 decision 7's amendment
 * (a), (b), (e) and (f), migration 0089): recorded on the stage attempt's row the first time the
 * window reads the ticket there, and never moved. Amendment (f)'s order: the `to` of the **latest**
 * change recorded since the entry into **any slot the platform writes** (`in_review`, `approved`,
 * `qa` — the platform's own moves, echoed back by a webhook after the entry); otherwise the `from` of
 * the earliest change recorded since the entry, so a move a person made before the first firing is
 * still a change; otherwise the status this firing read.
 *
 * History: until round 2 of WP-178's review the earliest `from` came first, so the `qa` echo's
 * `from` (`in_progress`) became the entry and a person's move back to `in_progress` equalled it;
 * round 2's (e) put the stage's own slot first, which still left `ready_for_merge` exposed to the
 * `approved` echo; (f) names every slot the platform writes.
 *
 * **Residuals, stated:** a window that first fires before the platform's own move lands freezes the
 * entry at the status it read (one provider round trip); on a binding that only polls (no recorded
 * `from`), a move made before the window's first firing there is the entry, so it returns nothing by
 * status — a comment or note still does. The sighting at `qa` is or-ed in: this firing's status, or a
 * recorded change's `from` or `to`.
 */
const observeEntryStatus = async (
  options: PipelineJobOptions,
  read: WindowRead,
  status: string,
  slots: TicketLifecycle,
): Promise<{ readonly entryStatus: string; readonly seenAtQa: boolean } | null> => {
  const qa = slots.qa;
  const is = (slot: string | undefined, name: string): boolean =>
    slot !== undefined && lifecycleStatusKey(name) === lifecycleStatusKey(slot);
  const atQa = (name: string): boolean => is(qa, name);
  const platformWrites = (name: string): boolean =>
    is(slots.in_review, name) || is(slots.approved, name) || is(qa, name);
  // `statusChanges` is newest first, so `find` is the latest such change.
  const intoPlatformSlot = read.statusChanges.find((change) => platformWrites(change.to));
  const entryStatus = intoPlatformSlot?.to ?? read.earliestChanges[0]?.from ?? status;
  const stageId = read.stage === 'qa' ? QA_STAGE_ID : READY_FOR_MERGE_STAGE;
  const attempt = read.stored.task.stageAttempts[stageId] ?? 0;
  return options.unitOfWork.transaction(async (scope) =>
    options.store.tasks.observeHumanStageStatus(scope.tx, {
      taskId: read.stored.task.id,
      stage: stageId,
      attempt,
      entryStatus: entryStatus.slice(0, MAX_LIFECYCLE_STATUS_NAME_CHARS),
      seenAtQa:
        read.stage === 'qa' &&
        (atQa(status) || read.statusChanges.some((change) => atQa(change.from) || atQa(change.to))),
    }),
  );
};

/**
 * The ticket's comments since the horizon, or `null` when the project reads no ticket. A provider
 * that cannot list comments is **said**, never read as "no comments" (BD-017): the window then
 * decides on the other signals and the log names the member.
 */
const windowComments = async (
  integrations: PipelineIntegrations,
  stored: StoredTask,
  horizon: string | null,
  logger: Logger,
): Promise<readonly TicketComment[] | null> => {
  try {
    const page = await ticketReads(integrations).comments(
      stored.task.ticket,
      { since: horizon, limit: MAX_LIST_COMMENTS_LIMIT },
      { projectId: stored.task.projectId, taskId: stored.task.id },
    );
    return page === null ? null : page.comments;
  } catch (error) {
    if (!(error instanceof IntegrationUnsupportedError)) {
      throw error;
    }
    logger.warn(
      { task_id: stored.task.id, action: error.action },
      'review window: the tracker cannot list a ticket’s comments, so ticket comments cannot return this task',
    );
    return null;
  }
};

/**
 * Where the ticket went when it was last seen leaving the `qa` status (WP-178 criterion (14)): the
 * newest recorded change whose `from` is the `qa` slot. `null` when none was recorded — including on
 * a binding that only polls, whose re-read records `ticket.updated` with no previous status. Until
 * WP-178's review that meant such a ticket never passed `qa` by status; since then the entry record
 * (`observeEntryStatus`) is the second way through (TD-029 decision 7's amendment (b)).
 */
const leftQaOf = (changes: readonly TicketStatusChange[], qa: string | undefined): string | null =>
  qa === undefined
    ? null
    : (changes.find((change) => lifecycleStatusKey(change.from) === lifecycleStatusKey(qa))?.to ??
      null);

/**
 * The return: `task.human_return`, one `interpret` with `mr.review.comment` carrying the feedback,
 * and the claim marked stale — one transaction (WP-178 (c), TD-029 decisions 5 and 7). A task that
 * left its human stage meanwhile is left alone.
 */
const returnForHumanWords = async (
  options: PipelineJobOptions,
  read: WindowRead,
  integrations: PipelineIntegrations,
  words: readonly WindowWord[],
  decision: Extract<HumanReturnDecision, { kind: 'return' }>,
): Promise<StageExecutionJob | null> => {
  const logger: Logger = options.logger ?? silentLogger;
  const redactor = composeSecretRedactors(
    ...[integrations.git?.redactor, integrations.taskManagement?.redactor].filter(
      (redactor): redactor is SecretRedactor => redactor !== undefined,
    ),
  );
  const feedback = humanReturnFeedback({
    stage: read.stage,
    forms: decision.forms,
    status: decision.status,
    words,
    horizon: read.horizon,
    redactor,
  });
  if (feedback.redactions > 0) {
    logger.info(
      { task_id: read.stored.task.id, redactions: feedback.redactions },
      'redacted secrets from the people’s words before storing them as a return reason',
    );
  }
  const taskId = read.stored.task.id;
  return inTaskTransaction(
    options,
    taskId,
    'returning a task for a person’s words',
    async (scope) => {
      const current = await options.store.tasks.load(scope.tx, taskId);
      if (current === null || humanReturnStageOf(current) !== read.stage) {
        return null;
      }
      const pipeline = compilePipeline(
        current.task.template,
        current.template,
        current.pipelineDial,
        current.qaStage,
      );
      const interpreted = interpret(pipeline, {
        kind: 'event',
        stage: current.task.currentStage ?? read.stage,
        event: 'mr.review.comment',
        // The people's own words, not only their number (WP-46, the human half of backlog 159):
        // redacted, one line per word and bounded — `review-threads.ts` has the rules.
        detail: feedback.reason,
      });
      // Criterion (12): parsed through the contracts schema, so a writer that counted an
      // acknowledgement, or named a form it counted none of, fails here rather than in a reader.
      const recorded = domainEventSchemasByType['task.human_return'].parse({
        id: options.ids.next(),
        stream_type: 'task',
        stream_id: taskId,
        stream_seq: current.task.sequence,
        correlation_id: taskId,
        cause_event_id: null,
        actor: { kind: 'system', component: 'pipeline' },
        occurred_at: options.clock.now(),
        type: 'task.human_return',
        payload: {
          project_id: current.task.projectId,
          task_id: taskId,
          from_stage: decision.from,
          forms: [...decision.forms],
          counts: { ...decision.counts },
          status: decision.status === null ? null : redactor.redactText(decision.status).value,
        },
      }) as DomainEvent;
      const applied = await applyDecision({
        store: options.store,
        pipeline,
        tx: scope.tx,
        // The record first on the stream, the return it causes after it.
        stored: { ...current, task: { ...current.task, sequence: current.task.sequence + 1 } },
        decision: interpreted,
        context: {
          ids: options.ids,
          actor: { kind: 'system', component: 'pipeline' },
          clock: options.clock as never,
          correlationId: taskId,
          causeEventId: null,
        },
        causedByEventId: null,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      /**
       * **A return re-claims the ticket** (BD-031 ruling 4, TD-029 decision 5): the claim is marked
       * stale here, in the return's own transaction, with the cause `human_return` — the one cause
       * whose next claim takes the ticket back, because the person who returned it may hold it. No
       * release is enqueued, so backlog 541's window does not open here.
       */
      const claim = await options.store.tasks.ticketClaim(scope.tx, taskId);
      if (claim !== null && claim.released_at === null) {
        await options.store.tasks.saveTicketClaim(scope.tx, taskId, {
          ...claim,
          stale: true,
          stale_cause: 'human_return',
        });
      }
      await scope.events.append([recorded, ...applied.events]);
      return applied.work;
    },
  );
};

/** The pass at `qa`: one `interpret` with `ticket.status.changed`, to `ready_for_merge`. */
const passQa = async (
  options: PipelineJobOptions,
  read: WindowRead,
): Promise<StageExecutionJob | null> => {
  const taskId = read.stored.task.id;
  (options.logger ?? silentLogger).info(
    { task_id: taskId },
    'review window: the ticket left the qa status and nobody asked for anything; QA passed',
  );
  return inTaskTransaction(options, taskId, 'passing the qa stage', async (scope) => {
    const current = await options.store.tasks.load(scope.tx, taskId);
    if (current === null || humanReturnStageOf(current) !== 'qa') {
      return null;
    }
    const pipeline = compilePipeline(
      current.task.template,
      current.template,
      current.pipelineDial,
      current.qaStage,
    );
    const decision = interpret(pipeline, {
      kind: 'event',
      stage: QA_STAGE_ID,
      event: 'ticket.status.changed',
      // Platform text: the status name is provider text and is not needed to say what happened.
      detail: 'the ticket left the qa status',
    });
    const applied = await applyDecision({
      store: options.store,
      pipeline,
      tx: scope.tx,
      stored: current,
      decision,
      context: {
        ids: options.ids,
        actor: { kind: 'system', component: 'pipeline' },
        clock: options.clock as never,
        correlationId: taskId,
        causeEventId: null,
      },
      causedByEventId: null,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    await scope.events.append(applied.events);
    return applied.work;
  });
};
