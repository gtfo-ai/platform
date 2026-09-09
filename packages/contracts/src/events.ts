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
  effortSchema,
  externalIdentitySchema,
  idSchema,
  isoDateTimeSchema,
  mergeRequestRefSchema,
  modelUsageSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  runCostSchema,
  runStatusSchema,
  runTerminalReasonSchema,
  sequenceSchema,
  shaSchema,
  stageIdSchema,
  taskModeSchema,
  templateIdSchema,
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
  coverage_pct: z.number().min(0).max(100).nullish(),
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
