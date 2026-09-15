/**
 * The domain event catalogue — docs/technical/02-domain-model-and-events.md § "Event catalogue".
 *
 * Everything is an event (BD-003, TD-005): every state change is appended to `events` and
 * dispatched to idempotent handlers in priority order. Names are `<aggregate>.<past-tense>`.
 *
 * Shape: a common envelope (the `events` columns of technical/03) plus a `type`-specific
 * `payload`. `actor` lives in the envelope rather than being repeated inside every payload,
 * because that is where the table keeps it. Task-scoped payloads carry `task_id`; every payload
 * that belongs to a project carries `project_id`.
 *
 * BD-022: any field fed by an integration (ticket text, MR comments, CI logs) is untrusted data.
 * Consumers render and store it; they never treat it as instructions.
 */

import * as z from 'zod';
import { artifactRefSchema } from './artifacts.js';
import {
  actorSchema,
  agentRoleSchema,
  coveragePctSchema,
  effortSchema,
  externalIdentitySchema,
  idSchema,
  isoDateTimeSchema,
  mergeRequestRefSchema,
  modelUsageSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  runCostSchema,
  runModeSchema,
  runStatusSchema,
  runTerminalReasonSchema,
  sequenceSchema,
  shaSchema,
  stageIdSchema,
  taskModeSchema,
  templateIdSchema,
  ticketReadinessGapSchema,
  ticketRefSchema,
  tokenCountSchema,
  tokenUsageSchema,
  urlSchema,
  usdSchema,
} from './common.js';
import {
  approvalRecordSchema,
  budgetScopeSchema,
  budgetWindowSchema,
  ciStatusSchema,
  configSourceSchema,
  contextPackRecordSchema,
  diffStatsSchema,
  feedbackRecordSchema,
  jsonObjectSchema,
  knowledgeProposalRecordSchema,
  questionRecordSchema,
  taskTotalsSchema,
  workspaceRecordSchema,
} from './records.js';

/** Aggregate streams in the event log (`events.stream_type`, technical/03). */
export const streamTypeSchema = z.enum([
  'organisation',
  'user',
  'project',
  'integration',
  'task',
  'run',
  'question',
  'approval',
  'workspace',
  'budget',
  'knowledge_proposal',
  'feedback',
  'scheduled_job',
]);

/**
 * Handler priority bands (TD-005): 0–99 platform core, 100–199 integrations,
 * 200–299 notifications/UI, 300+ custom project handlers.
 */
export const handlerPrioritySchema = z.int().min(0).max(999);

export const HANDLER_PRIORITY_BANDS = {
  core: { from: 0, to: 99 },
  integrations: { from: 100, to: 199 },
  notifications: { from: 200, to: 299 },
  custom: { from: 300, to: 999 },
} as const;

const eventEnvelopeShape = {
  id: idSchema,
  stream_type: streamTypeSchema,
  stream_id: idSchema,
  stream_seq: sequenceSchema,
  /** The task the event belongs to, for cross-stream correlation (technical/03). */
  correlation_id: idSchema.nullish(),
  /** The event that caused this one, for chained handler emissions. */
  cause_event_id: idSchema.nullish(),
  actor: actorSchema,
  occurred_at: isoDateTimeSchema,
} as const;

const defineEvent = <TType extends string, TShape extends z.ZodRawShape>(
  type: TType,
  payload: TShape,
) =>
  z.strictObject({
    ...eventEnvelopeShape,
    type: z.literal(type),
    payload: z.strictObject(payload),
  });

const projectScoped = { project_id: idSchema } as const;
const taskScoped = { project_id: idSchema, task_id: idSchema } as const;

// ── Ticket (task-management adapter) ─────────────────────────────────────────

export const ticketMatchedEvent = defineEvent('ticket.matched', {
  ...projectScoped,
  ticket: ticketRefSchema,
  rule: nonEmptyStringSchema,
  priority: nonEmptyStringSchema.nullish(),
  issue_type: nonEmptyStringSchema.nullish(),
  epic: nonEmptyStringSchema.nullish(),
  links: z.array(
    z.strictObject({
      kind: nonEmptyStringSchema,
      key: nonEmptyStringSchema,
      url: urlSchema.nullish(),
    }),
  ),
});

/**
 * A ticket was **created** in a project the binding reads — whatever the platform then does with it
 * (WP-25).
 *
 * It is a different fact from `ticket.matched`, which says *"this ticket is for the agent"*: a
 * delivery that creates a ticket already carrying the pick-up label produces **both**, and one that
 * creates an ordinary ticket produces only this. That is what the ticket readiness linter needs
 * (product/18: *"new tickets of configured issue types that are **not** labelled for the agent"*),
 * and it is the honest shape — the normaliser reports what the provider said, and whether a project
 * wants it linted is a *settings* question the pipeline answers later.
 *
 * `issue_type` is the provider's own type name, carried for the same reason `ticket.matched` carries
 * it: a consumer can tell a Bug from an Epic without a provider round trip. Everything else the
 * linter needs — the labels, the words — is read from the ticket itself when the duty fires, so it
 * is the ticket as it is *now* rather than as the delivery described it.
 */
export const ticketCreatedEvent = defineEvent('ticket.created', {
  ...projectScoped,
  ticket: ticketRefSchema,
  issue_type: nonEmptyStringSchema.nullish(),
});

export const ticketCommentAddedEvent = defineEvent('ticket.comment.added', {
  ...projectScoped,
  task_id: idSchema.nullish(),
  ticket: ticketRefSchema,
  comment_id: nonEmptyStringSchema,
  author: externalIdentitySchema,
  /** Untrusted (BD-022). */
  text: z.string(),
});

export const ticketStatusChangedEvent = defineEvent('ticket.status.changed', {
  ...projectScoped,
  task_id: idSchema.nullish(),
  ticket: ticketRefSchema,
  from: z.string(),
  to: z.string(),
});

// ── Task lifecycle ───────────────────────────────────────────────────────────

export const taskCreatedEvent = defineEvent('task.created', {
  ...taskScoped,
  ticket: ticketRefSchema,
  template: templateIdSchema,
  mode: taskModeSchema,
  estimate_usd: usdSchema.nullish(),
});

export const taskQueuedEvent = defineEvent('task.queued', {
  ...taskScoped,
  reason: z.enum(['wip', 'budget', 'dependency', 'manual']),
});

export const taskDequeuedEvent = defineEvent('task.dequeued', {
  ...taskScoped,
  reason: z.enum(['wip', 'budget', 'dependency', 'manual']),
});

export const taskStageEnteredEvent = defineEvent('task.stage.entered', {
  ...taskScoped,
  stage: stageIdSchema,
  attempt: z.int().positive(),
});

export const taskStageCompletedEvent = defineEvent('task.stage.completed', {
  ...taskScoped,
  stage: stageIdSchema,
  artifacts: z.array(artifactRefSchema),
  verdict: z.string().nullish(),
});

export const taskStageReturnedEvent = defineEvent('task.stage.returned', {
  ...taskScoped,
  from_stage: stageIdSchema,
  to_stage: stageIdSchema,
  reason: nonEmptyStringSchema,
  feedback_ref: idSchema.nullish(),
  iteration: z.int().positive(),
});

export const taskQuestionAskedEvent = defineEvent('task.question.asked', {
  ...taskScoped,
  question: questionRecordSchema,
});

export const taskQuestionAnsweredEvent = defineEvent('task.question.answered', {
  ...taskScoped,
  question_id: idSchema,
  /** Untrusted (BD-022); only verified identities reach this event at all. */
  answer: z.string(),
  answered_by_user_id: idSchema,
  channel: z.enum(['ui', 'ticket', 'slack', 'api']),
});

export const taskQuestionExpiredEvent = defineEvent('task.question.expired', {
  ...taskScoped,
  question_id: idSchema,
});

export const taskApprovalRequestedEvent = defineEvent('task.approval.requested', {
  ...taskScoped,
  approval: approvalRecordSchema,
});

export const taskApprovalDecidedEvent = defineEvent('task.approval.decided', {
  ...taskScoped,
  approval_id: idSchema,
  decision: z.enum(['approved', 'rejected', 'expired']),
  decided_by_user_id: idSchema.nullish(),
  reason: z.string().nullish(),
});

export const taskEscalatedEvent = defineEvent('task.escalated', {
  ...taskScoped,
  reason: nonEmptyStringSchema,
  blocker_brief: nonEmptyStringSchema,
});

export const taskPausedEvent = defineEvent('task.paused', {
  ...taskScoped,
  reason: z.enum(['budget', 'manual', 'taken_over']),
});

export const taskResumedEvent = defineEvent('task.resumed', {
  ...taskScoped,
  reason: z.string().nullish(),
});

export const taskTakenOverEvent = defineEvent('task.taken_over', {
  ...taskScoped,
  branch: nonEmptyStringSchema,
  session_id: nonEmptyStringSchema.nullish(),
  stage: stageIdSchema,
});

export const taskHandedBackEvent = defineEvent('task.handed_back', {
  ...taskScoped,
  branch: nonEmptyStringSchema,
  stage: stageIdSchema,
  summary: z.string(),
});

/**
 * What became of a review-only task's findings — product/18's metric, *"findings accepted (thread
 * resolved with change) vs dismissed"* (WP-24).
 *
 * It is a `task.*` event and it sits on the **task** stream, although what it describes is a merge
 * request: the aggregate it belongs to is the review task, its producer is the pipeline rather than
 * a git adapter (every `mr.*` event is adapter-produced), and it can only exist for a task. The
 * merge request is named in the payload.
 *
 * **It is an observation, not a conclusion.** `threads_accepted` and `threads_dismissed` are this
 * build's reading of "with a change" — a resolved thread on a merge request whose head moved after
 * the review was posted — and both shas are on the payload precisely so a consumer can compute a
 * different reading without going back to the provider. `packages/application/src/pipeline/review-only.ts`
 * states what that reading cannot distinguish.
 */
export const taskReviewObservedEvent = defineEvent('task.review.observed', {
  ...taskScoped,
  mr: mergeRequestRefSchema,
  /** The revision the platform reviewed. */
  head_sha_reviewed: shaSchema,
  /** The revision the merge request ended on. */
  head_sha_now: shaSchema,
  /**
   * **Finding** threads this review posted that were still on the merge request when it ended.
   *
   * Not the neutral summary: product/18:59 counts findings, and the summary is the platform's own
   * framing rather than one of them (`review-only.ts` § `reviewSummaryMarkerFor`).
   */
  threads_posted: z.int().nonnegative(),
  threads_resolved: z.int().nonnegative(),
  threads_accepted: z.int().nonnegative(),
  threads_dismissed: z.int().nonnegative(),
  threads_unresolved: z.int().nonnegative(),
});

/**
 * The ticket readiness linter posted its one comment — product/18's metric baseline (WP-25).
 *
 * A `task.*` event on the **task** stream for the reason `task.review.observed` is one: the
 * aggregate it belongs to is the lint task, its producer is the pipeline rather than an adapter, and
 * it cannot exist without a task. The ticket it is about is named in the payload.
 *
 * ## What it can and cannot measure, stated here because the payload is the whole evidence
 *
 * product/18:60 asks for *"tickets improved after lint (edited within 48 h), questions avoided
 * downstream"*. Neither is computable from one event, and this one is deliberately the **baseline**
 * rather than the answer:
 *
 *  - *edited within 48 h* needs a later "this ticket changed" signal. **No such event exists in this
 *    build**: Jira's `jira:issue_updated` is normalised only into `ticket.matched` (when the change
 *    is what made the ticket match) and `ticket.status.changed`, so an edited description produces
 *    `unsupported_event` and nothing else. `ticket_updated_at` is carried here so that whoever adds
 *    that signal compares against the ticket as the linter saw it, rather than re-reading the
 *    provider for a number this event already knew.
 *  - *questions avoided downstream* is a correlation across a later task on the same ticket, which
 *    is WP-41's (statistics). `score` and `questions_posted` are what it correlates.
 */
export const taskLintPostedEvent = defineEvent('task.lint.posted', {
  ...taskScoped,
  /** The **real** ticket the comment was posted on, not the lint task's platform-issued reference. */
  ticket: ticketRefSchema,
  /** 0–100, the platform's own reading of the `RefinedSpec` (`policies/ticket-lint.ts`). */
  score: z.int().min(0).max(100),
  /** The gaps the score is made of, most costly first. */
  missing: z.array(ticketReadinessGapSchema),
  /** How many questions the comment carries — at most `MAX_LINT_QUESTIONS`. */
  questions_posted: z.int().nonnegative(),
  /** The provider's `updated_at` when the ticket was read, or `null` when it was unreadable. */
  ticket_updated_at: isoDateTimeSchema.nullish(),
});

/**
 * The rebase gate checked a merge request against its target — product/16's *"conflicts
 * auto-resolved vs escalated"* (WP-26, BD-030).
 *
 * One event per settlement of the `rebase_gate`, so the metric is a count of rows rather than a
 * join across a transition and an escalation reason. `outcome` is the whole of it:
 *
 *  - `clean` — the branch applied to its target on the first check of this pass, and no run was
 *    spent;
 *  - `resolved` — it applies now and it did not before: `attempt` says how many conflict-resolution
 *    runs it took, and this is the numerator of *"resolved automatically"*;
 *  - `conflicted` — it does not apply and the bounded loop has another attempt left;
 *  - `exhausted` — it does not apply and the loop is spent, so the task is escalated. This is the
 *    denominator's other half, *"escalated"*.
 *
 * It reports **the check the gate made on the snapshot it read**, which is what makes it a
 * measurement rather than a prediction: a task another writer moved between the read and the
 * settlement is settled by the gate's own re-validation, and this row still says what was seen.
 */
export const taskRebaseCheckedEvent = defineEvent('task.rebase.checked', {
  ...taskScoped,
  mr: mergeRequestRefSchema,
  /** What the provider said about the branch applying to its target. */
  conflicts: z.boolean(),
  /** Conflict-resolution runs spent on this merge request so far (`iteration_counters.rebase`). */
  attempt: z.int().nonnegative(),
  outcome: z.enum(['clean', 'resolved', 'conflicted', 'exhausted']),
});

/**
 * Two active tasks touch the same files — product/04 S6b's *"The board warns when two active tasks
 * touch the same files"* and product/16's *"concurrent-task overlaps"* (WP-26, BD-030).
 *
 * One event per **ordered pair**: it is appended on the stream of the task whose rebase gate ran,
 * and `other_task_id` names the task it was compared against. The pair is not symmetric, because
 * the comparison is not: the other task's own gate may have run before this task had a merge
 * request at all, in which case it was told nothing.
 *
 * `paths` is **provider text** (BD-022) — the file paths of somebody's repository — so it is
 * bounded and redacted before it is stored, and `path_count` is the number of overlapping paths
 * *found*, which is not the length of `paths` when the list was cut. `truncated` says that one of
 * the two merge requests had more files than the comparison read, so an empty overlap under
 * `truncated: true` is "nothing found in what was compared" rather than "nothing to find".
 */
export const taskConflictWarnedEvent = defineEvent('task.conflict.warned', {
  ...taskScoped,
  mr: mergeRequestRefSchema,
  other_task_id: idSchema,
  /** The other task's ticket key, bounded — it is what the warning names to a human. */
  other_ticket_key: nonEmptyStringSchema.max(256),
  paths: z.array(nonEmptyStringSchema.max(256)).max(20),
  path_count: z.int().nonnegative(),
  truncated: z.boolean(),
});

/**
 * A human decided a proposed ticket breakdown — product/04:117's *"for the PM to accept"* (WP-40).
 *
 * One event per **decision**, not per child, because that is what a person did: a PM who accepts
 * five of seven children makes one decision about seven rows, and two events would make the
 * board's history read as two visits. The counts are the platform's own tally of the rows it moved,
 * so a redelivered command (which the `Idempotency-Key` refuses before anything is written) cannot
 * produce a second one.
 *
 * It is the event the spike's **human stage** subscribes to: `EPIC_SPLIT_TEMPLATE`'s `human_review`
 * names it in its `on` list, so a decided breakdown is what ends the task, and an epic split nobody
 * has looked at stays visibly waiting instead of finishing on the run's own verdict.
 */
export const taskBreakdownDecidedEvent = defineEvent('task.breakdown.decided', {
  ...taskScoped,
  /** How many of the queued children the decision accepted; each becomes one `createTicket` call. */
  accepted: z.int().nonnegative(),
  /** How many it rejected. A rejection leaves the row with its reason, never deletes it (Q85). */
  rejected: z.int().nonnegative(),
  /** How many were still queued afterwards — a decision may name a subset (Q85's *"five of seven"*). */
  remaining: z.int().nonnegative(),
});

export const taskCancelledEvent = defineEvent('task.cancelled', {
  ...taskScoped,
  outcome: nonEmptyStringSchema,
  totals: taskTotalsSchema,
});

export const taskCompletedEvent = defineEvent('task.completed', {
  ...taskScoped,
  outcome: nonEmptyStringSchema,
  totals: taskTotalsSchema,
});

// ── Runs ─────────────────────────────────────────────────────────────────────

/**
 * The run exists and the platform has committed to launching it (`created → starting`). Carries
 * everything needed to rebuild the run row from the log alone, so no state change is silent.
 */
export const runCreatedEvent = defineEvent('run.created', {
  ...taskScoped,
  run_id: idSchema,
  /**
   * `null` for a run that belongs to no pipeline stage — discovery, ask-the-task, librarian
   * (technical/03:40-42). `RunRecord.stage` has been nullable since WP-04 for the same reason; this
   * payload typed it non-nullable until WP-31, which is the work package that created the first
   * such run through the ordinary `createRun` path.
   */
  stage: stageIdSchema.nullable(),
  role: agentRoleSchema,
  mode: runModeSchema,
  attempt: z.int().positive(),
  model: nonEmptyStringSchema,
  effort: effortSchema,
  prompt_version: nonEmptyStringSchema,
});

export const runStartedEvent = defineEvent('run.started', {
  ...taskScoped,
  run_id: idSchema,
  model: nonEmptyStringSchema,
  effort: effortSchema,
  prompt_version: nonEmptyStringSchema,
  context_pack: contextPackRecordSchema,
});

export const runFinishedEvent = defineEvent('run.finished', {
  ...taskScoped,
  run_id: idSchema,
  status: runStatusSchema,
  terminal_reason: runTerminalReasonSchema,
  usage: tokenUsageSchema,
  model_usage: z.array(modelUsageSchema),
  cost: runCostSchema,
  num_turns: z.int().nonnegative(),
  wall_ms: z.int().nonnegative(),
});

export const runFailedEvent = defineEvent('run.failed', {
  ...taskScoped,
  run_id: idSchema,
  status: runStatusSchema,
  terminal_reason: runTerminalReasonSchema,
  error: nonEmptyStringSchema,
  usage: tokenUsageSchema.nullish(),
  cost: runCostSchema.nullish(),
});

export const runSteeredEvent = defineEvent('run.steered', {
  ...taskScoped,
  run_id: idSchema,
  /** Untrusted (BD-022): forwarded to the session with its provenance attached. */
  message: nonEmptyStringSchema,
  author_user_id: idSchema,
});

// ── Artifacts and workspaces ─────────────────────────────────────────────────

export const artifactCreatedEvent = defineEvent('artifact.created', {
  ...taskScoped,
  artifact: artifactRefSchema,
  produced_by_run_id: idSchema,
});

export const workspaceProvisionedEvent = defineEvent('workspace.provisioned', {
  ...taskScoped,
  workspace: workspaceRecordSchema,
});

export const workspaceDestroyedEvent = defineEvent('workspace.destroyed', {
  ...taskScoped,
  workspace_id: idSchema,
  reason: z.string().nullish(),
});

export const workspaceExportedEvent = defineEvent('workspace.exported', {
  ...taskScoped,
  workspace_id: idSchema,
  export_blob_id: idSchema.nullish(),
  branch: nonEmptyStringSchema.nullish(),
});

// ── Git provider ─────────────────────────────────────────────────────────────

const mrPayload = {
  ...projectScoped,
  task_id: idSchema.nullish(),
  mr: mergeRequestRefSchema,
  draft: z.boolean(),
  head_sha: shaSchema,
  diff_stats: diffStatsSchema.nullish(),
} as const;

export const mrOpenedEvent = defineEvent('mr.opened', mrPayload);
export const mrUpdatedEvent = defineEvent('mr.updated', mrPayload);
export const mrMergedEvent = defineEvent('mr.merged', {
  ...mrPayload,
  merge_commit_sha: shaSchema.nullish(),
});
export const mrClosedEvent = defineEvent('mr.closed', mrPayload);

export const mrReviewCommentEvent = defineEvent('mr.review.comment', {
  ...projectScoped,
  task_id: idSchema.nullish(),
  mr: mergeRequestRefSchema,
  thread_id: nonEmptyStringSchema,
  author: externalIdentitySchema,
  /** Untrusted (BD-022). */
  text: z.string(),
  resolved: z.boolean(),
});

export const ciPipelineFinishedEvent = defineEvent('ci.pipeline.finished', {
  ...projectScoped,
  task_id: idSchema.nullish(),
  mr: mergeRequestRefSchema.nullish(),
  head_sha: shaSchema,
  status: ciStatusSchema,
  failed_jobs: z.array(
    z.strictObject({
      name: nonEmptyStringSchema,
      /** Untrusted (BD-022): a log excerpt, truncated and redacted before storage. */
      log_ref: nonEmptyStringSchema.nullish(),
    }),
  ),
  coverage_pct: coveragePctSchema.nullish(),
});

export const defaultBranchMovedEvent = defineEvent('default_branch.moved', {
  ...projectScoped,
  branch: nonEmptyStringSchema,
  new_head: shaSchema,
});

// ── Budgets ──────────────────────────────────────────────────────────────────

const budgetPayload = {
  project_id: idSchema.nullish(),
  budget_id: idSchema,
  scope: budgetScopeSchema,
  scope_id: idSchema.nullish(),
  window: budgetWindowSchema,
  limit_usd: usdSchema,
  spent_usd: usdSchema,
} as const;

export const budgetThresholdReachedEvent = defineEvent('budget.threshold.reached', {
  ...budgetPayload,
  pct: z.int().min(1).max(100),
});
export const budgetExhaustedEvent = defineEvent('budget.exhausted', budgetPayload);
export const budgetResetEvent = defineEvent('budget.reset', {
  ...budgetPayload,
  window_start: isoDateTimeSchema,
});

// ── Feedback and knowledge ───────────────────────────────────────────────────

export const feedbackReceivedEvent = defineEvent('feedback.received', {
  ...projectScoped,
  task_id: idSchema.nullish(),
  feedback: feedbackRecordSchema,
});

export const knowledgeProposalCreatedEvent = defineEvent('knowledge.proposal.created', {
  ...projectScoped,
  proposal: knowledgeProposalRecordSchema,
});

export const knowledgeProposalAppliedEvent = defineEvent('knowledge.proposal.applied', {
  ...projectScoped,
  proposal_id: idSchema,
  commit_sha: shaSchema,
  decided_by_user_id: idSchema.nullish(),
});

export const knowledgeProposalRejectedEvent = defineEvent('knowledge.proposal.rejected', {
  ...projectScoped,
  proposal_id: idSchema,
  reason: z.string().nullish(),
  decided_by_user_id: idSchema.nullish(),
});

export const knowledgeIndexRebuiltEvent = defineEvent('knowledge.index.rebuilt', {
  ...projectScoped,
  commit_sha: shaSchema,
  documents: z.int().nonnegative(),
  chunks: z.int().nonnegative(),
  tokens: tokenCountSchema,
});

export const readinessEvaluatedEvent = defineEvent('readiness.evaluated', {
  ...projectScoped,
  level: z.int().min(0).max(5),
  criteria: z.array(
    z.strictObject({
      id: nonEmptyStringSchema,
      passed: z.boolean(),
      evidence: z.string(),
    }),
  ),
  source: z.enum(['discovery', 'ci_gate', 'maintenance', 'manual']),
});

// ── Configuration and integrations ───────────────────────────────────────────

export const configChangedEvent = defineEvent('config.changed', {
  project_id: idSchema.nullish(),
  scope: configSourceSchema,
  scope_id: idSchema.nullish(),
  /** Secret values appear as `"changed"`, never as the value itself (technical/03). */
  diff: z.array(
    z.strictObject({
      key: pathPatternSchema,
      from: z.string().nullish(),
      to: z.string().nullish(),
    }),
  ),
});

export const integrationActionPerformedEvent = defineEvent('integration.action.performed', {
  project_id: idSchema.nullish(),
  task_id: idSchema.nullish(),
  integration_id: idSchema,
  action: nonEmptyStringSchema,
  /** Redacted at write (TD-012). */
  payload_redacted: jsonObjectSchema,
  result: jsonObjectSchema,
  duration_ms: z.int().nonnegative(),
});

export const integrationActionFailedEvent = defineEvent('integration.action.failed', {
  project_id: idSchema.nullish(),
  task_id: idSchema.nullish(),
  integration_id: idSchema,
  action: nonEmptyStringSchema,
  payload_redacted: jsonObjectSchema,
  error: nonEmptyStringSchema,
  duration_ms: z.int().nonnegative(),
});

export const shadowReportCreatedEvent = defineEvent('shadow.report.created', {
  ...taskScoped,
  artifact: artifactRefSchema,
});

// ── The catalogue ────────────────────────────────────────────────────────────

/**
 * Every event in the catalogue, discriminated on `type`. `parse` therefore rejects an unknown
 * event type as well as an unknown key in the envelope or in any payload.
 */
export const domainEventSchema = z.discriminatedUnion('type', [
  ticketMatchedEvent,
  ticketCreatedEvent,
  ticketCommentAddedEvent,
  ticketStatusChangedEvent,
  taskCreatedEvent,
  taskQueuedEvent,
  taskDequeuedEvent,
  taskStageEnteredEvent,
  taskStageCompletedEvent,
  taskStageReturnedEvent,
  taskQuestionAskedEvent,
  taskQuestionAnsweredEvent,
  taskQuestionExpiredEvent,
  taskApprovalRequestedEvent,
  taskApprovalDecidedEvent,
  taskEscalatedEvent,
  taskPausedEvent,
  taskResumedEvent,
  taskTakenOverEvent,
  taskHandedBackEvent,
  taskCancelledEvent,
  taskCompletedEvent,
  taskReviewObservedEvent,
  taskLintPostedEvent,
  taskRebaseCheckedEvent,
  taskConflictWarnedEvent,
  taskBreakdownDecidedEvent,
  runCreatedEvent,
  runStartedEvent,
  runFinishedEvent,
  runFailedEvent,
  runSteeredEvent,
  artifactCreatedEvent,
  workspaceProvisionedEvent,
  workspaceDestroyedEvent,
  workspaceExportedEvent,
  mrOpenedEvent,
  mrUpdatedEvent,
  mrMergedEvent,
  mrClosedEvent,
  mrReviewCommentEvent,
  ciPipelineFinishedEvent,
  defaultBranchMovedEvent,
  budgetThresholdReachedEvent,
  budgetExhaustedEvent,
  budgetResetEvent,
  feedbackReceivedEvent,
  knowledgeProposalCreatedEvent,
  knowledgeProposalAppliedEvent,
  knowledgeProposalRejectedEvent,
  knowledgeIndexRebuiltEvent,
  readinessEvaluatedEvent,
  configChangedEvent,
  integrationActionPerformedEvent,
  integrationActionFailedEvent,
  shadowReportCreatedEvent,
]);

export type DomainEvent = z.infer<typeof domainEventSchema>;
export type DomainEventType = DomainEvent['type'];

type DomainEventMember = (typeof domainEventSchema.options)[number];

/** Every event type name, in catalogue order. */
export const DOMAIN_EVENT_TYPES = domainEventSchema.options.map(
  (option) => option.shape.type.value,
) as [DomainEventType, ...DomainEventType[]];

/** The set of catalogue names on its own, for routing tables and SSE `event:` validation. */
export const domainEventTypeSchema = z.enum(DOMAIN_EVENT_TYPES);

/** Schema lookup by event type — for handlers that only ever parse one event. */
export const domainEventSchemasByType = Object.fromEntries(
  domainEventSchema.options.map((option) => [option.shape.type.value, option]),
) as Record<DomainEventType, DomainEventMember>;
export type StreamType = z.infer<typeof streamTypeSchema>;
export type EventOfType<T extends DomainEventType> = Extract<DomainEvent, { type: T }>;
export type EventPayload<T extends DomainEventType> = EventOfType<T>['payload'];
