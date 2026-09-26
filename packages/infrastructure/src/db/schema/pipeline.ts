/**
 * Pipeline aggregates (technical/03 § "Pipeline"). Mirrors `migrations/0004_pipeline.sql`.
 *
 * Note for the DTO layer: `records.ts` in `@platform/contracts` exposes `RunRecord.stage`, which is
 * not a column here — technical/03 keeps the stage on `task_stages` and links `runs.task_stage_id`
 * to it, so the API projection joins rather than reads it. **That link was never written until
 * WP-15h**: `RunRepository.insert` took a `stage` and dropped it, so the join it describes had
 * nothing on the other side and the published field had no source at all. The insert now resolves
 * `task_stage_id` from `(task_id, stage, attempt)`, and `apps/server/src/queries/pipeline-queries.ts`
 * is the projection that joins.
 */
import type {
  EstimateBasis,
  ExternalIdentity,
  HistorySample,
  JsonObject,
  JsonValue,
  MergeRequestRef,
  MergeRequestSnapshot,
  TaskCoverage,
  TaskDependencies,
  TaskReviewers,
  TicketSnapshot,
  WorkpadRef,
} from '@platform/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  real,
  smallint,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import {
  agentRoleEnum,
  answerChannelEnum,
  approvalKindEnum,
  approvalStatusEnum,
  artifactTypeEnum,
  contextPackReasonEnum,
  effortEnum,
  providerModeEnum,
  questionStatusEnum,
  runModeEnum,
  runStatusEnum,
  runTerminalReasonEnum,
  taskModeEnum,
  taskSizeEnum,
  taskStateEnum,
  workspaceStatusEnum,
} from './enums.js';

const uuidv7 = sql`uuidv7()`;
const emptyArray = sql`'{}'`;

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().default(uuidv7),
  projectId: uuid('project_id').notNull(),
  ticketProvider: text('ticket_provider').notNull(),
  ticketKey: text('ticket_key').notNull(),
  ticketUrl: text('ticket_url').notNull(),
  template: text('template').notNull(),
  mode: taskModeEnum('mode').notNull().default('normal'),
  state: taskStateEnum('state').notNull().default('queued'),
  currentStage: text('current_stage'),
  size: taskSizeEnum('size'),
  priority: text('priority'),
  requestedByUserId: uuid('requested_by_user_id'),
  requestedByIdentity: jsonb('requested_by_identity').$type<ExternalIdentity>(),
  templateSnapshot: jsonb('template_snapshot').$type<JsonObject>(),
  /** The ticket's own words, bounded and redacted at the write (WP-15f, migration 0015). */
  ticketSnapshot: jsonb('ticket_snapshot').$type<TicketSnapshot>(),
  ticketSnapshotAt: timestamp('ticket_snapshot_at', { withTimezone: true }),
  /** WP-24, migration 0020: the human merge request a review-only task reviews. */
  reviewSubject: jsonb('review_subject').$type<MergeRequestSnapshot>(),
  /** WP-35, migration 0030: the mined history one bootstrap run reads, bounded and redacted. */
  historySample: jsonb('history_sample').$type<HistorySample>(),
  configSnapshotHash: text('config_snapshot_hash'),
  branch: text('branch'),
  mrRef: jsonb('mr_ref').$type<MergeRequestRef>(),
  workpadRef: jsonb('workpad_ref').$type<WorkpadRef>(),
  /** `Task.stageAttempts` (WP-15, migration 0012). */
  stageAttempts: jsonb('stage_attempts').$type<JsonObject>().notNull().default({}),
  /** BD-008's limits, frozen at task start (WP-15, migration 0012). */
  iterationLimits: jsonb('iteration_limits').$type<JsonObject>().notNull().default({}),
  iterationCounters: jsonb('iteration_counters')
    .$type<Record<string, number>>()
    .notNull()
    .default({}),
  costActual: numeric('cost_actual', { precision: 12, scale: 6 }).notNull().default('0'),
  // `cost_estimated` was dropped by migration 0035 (WP-47, backlog 75): a `not null default 0`
  // column with no writer, published as the task's estimated spend. `cost_estimated_usd` is now a
  // projection over `cost_entries where is_estimate` (`apps/server/src/queries/pipeline-queries.ts`).
  estimateUsd: numeric('estimate_usd', { precision: 12, scale: 6 }),
  /**
   * What {@link tasks.estimateUsd} rests on, and how many finished tasks it was averaged over
   * (WP-28, migration 0022).
   *
   * Both nullable and paired by a check constraint: `null` is *"the estimator has not run"*, which
   * is a different answer from `'unknown'` (*"it ran and there was no history"*) and from a count of
   * zero. Written only by `CostStore.saveEstimate`, beside `size` and `estimate_usd`.
   */
  estimateBasis: text('estimate_basis').$type<EstimateBasis>(),
  estimateSamples: integer('estimate_samples'),
  riskClasses: text('risk_classes').array().notNull().default(emptyArray),
  /**
   * What the CI reported for this task's head revision and for the default branch it will merge
   * into (WP-39, migration 0027).
   *
   * Nullable on purpose and in three places at once: the column is `null` until a pipeline has
   * finished on the merge request (or for ever, when the project's `policies.coverage_source` is
   * `'none'`), and `head_pct`/`base_pct`/`delta_pct` inside it are each `null` when that side
   * reported no number. None of the three is ever a zero standing in for a missing number — see
   * `taskCoverageSchema`, which every write is parsed against.
   */
  coverage: jsonb('coverage').$type<TaskCoverage>(),
  /**
   * What the dependency gate found in this task's diff and what it did about it (WP-38, migration
   * 0028).
   *
   * `null` until an implementation stage has completed — the gate has no diff to read before that —
   * which is a different fact from a record whose `added` is empty, and the Checks panel prints a
   * different sentence for each. Every write is parsed against `taskDependenciesSchema`.
   */
  dependencies: jsonb('dependencies').$type<TaskDependencies>(),
  /**
   * Who this merge request needs a review from, as `risk_route` computed it (WP-38, migration
   * 0028) — product/10:38's *"risk classes and required reviewers"*.
   *
   * It is the platform's record of what it **asked for**, including handles no account could be
   * found for: the `set_reviewers` audit row is written only when at least one resolved, so it
   * cannot answer that question.
   */
  requiredReviewers: jsonb('required_reviewers').$type<TaskReviewers>(),
  blockedBy: text('blocked_by').array().notNull().default(emptyArray),
  /**
   * The row's optimistic-concurrency token (WP-15e, migration 0019).
   *
   * Bumped by `TaskRepository.save` and by nothing else: the narrow writes
   * (`saveWorkpad`, `saveTicketSnapshot`, `saveEstimate`) own columns `save` does not name, so
   * bumping it there would refuse an in-flight write over a column that writer does not touch.
   * The disjointness is enforced rather than asserted — see `tasks-column-ownership.test.ts`.
   */
  version: integer('version').notNull().default(1),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const taskStages = pgTable('task_stages', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  stage: text('stage').notNull(),
  attempt: integer('attempt').notNull().default(1),
  /** `taskStageStateSchema`'s six words, held by `task_stages_state_known` (migration 0040). */
  state: text('state').notNull(),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
  exitedAt: timestamp('exited_at', { withTimezone: true }),
  outcome: text('outcome'),
  returnReason: text('return_reason'),
  /**
   * The stage a return sent the task to (WP-55, migration 0040): null on every row that is not a
   * return. What `lastReturnReason` reads by, so a re-run stage is served the finding it was sent
   * back to fix rather than the complaint it last made itself.
   */
  returnedTo: text('returned_to'),
  /** Convergence detection's stable key; nothing else writes it (WP-15, migration 0012). */
  signature: text('signature'),
  causedByEventId: uuid('caused_by_event_id'),
});

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  taskStageId: uuid('task_stage_id'),
  projectId: uuid('project_id').notNull(),
  role: agentRoleEnum('role').notNull(),
  mode: runModeEnum('mode').notNull().default('normal'),
  attempt: integer('attempt').notNull().default(1),
  runKey: text('run_key'),
  sessionId: text('session_id'),
  model: text('model').notNull(),
  effort: effortEnum('effort').notNull().default('high'),
  permissionMode: text('permission_mode'),
  providerMode: providerModeEnum('provider_mode').notNull().default('api'),
  promptVersion: text('prompt_version').notNull(),
  systemPrompt: text('system_prompt'),
  userPrompt: text('user_prompt'),
  settingsSnapshot: jsonb('settings_snapshot').$type<JsonObject>().notNull().default({}),
  settingsHash: text('settings_hash'),
  allowedTools: text('allowed_tools').array().notNull().default(emptyArray),
  disallowedTools: text('disallowed_tools').array().notNull().default(emptyArray),
  mcpServers: jsonb('mcp_servers').$type<JsonObject>().notNull().default({}),
  skills: text('skills').array().notNull().default(emptyArray),
  status: runStatusEnum('status').notNull().default('created'),
  terminalReason: runTerminalReasonEnum('terminal_reason'),
  exitDetail: jsonb('exit_detail').$type<JsonObject>(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  lastOutputAt: timestamp('last_output_at', { withTimezone: true }),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  numTurns: integer('num_turns').notNull().default(0),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  cacheWrite5mTokens: bigint('cache_write_5m_tokens', { mode: 'number' }).notNull().default(0),
  cacheWrite1hTokens: bigint('cache_write_1h_tokens', { mode: 'number' }).notNull().default(0),
  cacheReadTokens: bigint('cache_read_tokens', { mode: 'number' }).notNull().default(0),
  usdReported: numeric('usd_reported', { precision: 12, scale: 6 }),
  /**
   * Nullable and without a default since migration 0035 (WP-47), and **written** since the same
   * work package: `RunRepository.finish` puts the run's own figure here when it is an estimate and
   * in {@link runs.usdReported} when it is not. `null` is *"no figure was reported for this run"*,
   * which `not null default 0` spelled as a free run — the pair is now exactly the one
   * `run_model_usage` has carried since migration 0017.
   */
  usdEstimated: numeric('usd_estimated', { precision: 12, scale: 6 }),
  priceListId: uuid('price_list_id'),
  wallMs: bigint('wall_ms', { mode: 'number' }).notNull().default(0),
  redactionCount: integer('redaction_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const runModelUsage = pgTable(
  'run_model_usage',
  {
    runId: uuid('run_id').notNull(),
    model: text('model').notNull(),
    inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
    outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
    cacheWrite5m: bigint('cache_write_5m', { mode: 'number' }).notNull().default(0),
    cacheWrite1h: bigint('cache_write_1h', { mode: 'number' }).notNull().default(0),
    cacheRead: bigint('cache_read', { mode: 'number' }).notNull().default(0),
    /**
     * Both nullable since migration 0017 (WP-19), and the pair is the one `runs` already carries:
     * `usd_reported` is the provider's per-model number and `usd_estimated` the price table's.
     * `null` is "nobody reported / no price row covered this model", which a `0` would spell the
     * same way as a free run (standing rule 18).
     */
    usdEstimated: numeric('usd_estimated', { precision: 12, scale: 6 }),
    usdReported: numeric('usd_reported', { precision: 12, scale: 6 }),
  },
  (table) => [primaryKey({ columns: [table.runId, table.model] })],
);

export const runContextPack = pgTable(
  'run_context_pack',
  {
    runId: uuid('run_id').notNull(),
    tier: smallint('tier').notNull(),
    sourcePath: text('source_path').notNull(),
    reason: contextPackReasonEnum('reason'),
    score: real('score'),
    tokens: integer('tokens').notNull().default(0),
    validated: boolean('validated').notNull().default(true),
    kbCommitSha: text('kb_commit_sha'),
  },
  (table) => [primaryKey({ columns: [table.runId, table.sourcePath] })],
);

export const artifacts = pgTable('artifacts', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  type: artifactTypeEnum('type').notNull(),
  version: integer('version').notNull().default(1),
  markdown: text('markdown'),
  /**
   * Validated against the artifact schema of `@platform/contracts` before it is written, and
   * **redacted** at the write since migration 0038 (TD-012, WP-52): prose through the run's own
   * injected-secret redactor, an identifier field carrying a secret refused rather than rewritten.
   */
  data: jsonb('data').$type<JsonValue>().notNull(),
  schemaVersion: text('schema_version').notNull(),
  producedByRunId: uuid('produced_by_run_id'),
  /**
   * Nullable and without a default since migration 0038, which is the opposite of
   * `integration_actions.redaction_count` and deliberately so: this table had rows before the
   * column existed and their true count is *unknown*, not zero. `null` = no redactor ran (written
   * before 0038); `0` = it ran and replaced nothing. A writer that omits it is refused by the
   * table's `NOT VALID` check rather than recorded as a null.
   */
  redactionCount: integer('redaction_count'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const questions = pgTable('questions', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  taskStageId: uuid('task_stage_id'),
  /** The stage the question was asked from; the pipeline resumes by stage id (migration 0012). */
  stage: text('stage'),
  runId: uuid('run_id'),
  text: text('text').notNull(),
  options: jsonb('options').$type<string[]>(),
  blocking: boolean('blocking').notNull().default(true),
  status: questionStatusEnum('status').notNull().default('open'),
  askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  remindersSent: integer('reminders_sent').notNull().default(0),
  answer: text('answer'),
  answeredByUserId: uuid('answered_by_user_id'),
  answeredVia: answerChannelEnum('answered_via'),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  escalatedAt: timestamp('escalated_at', { withTimezone: true }),
});

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  kind: approvalKindEnum('kind').notNull(),
  status: approvalStatusEnum('status').notNull().default('pending'),
  requestedAt: timestamp('requested_at', { withTimezone: true }).notNull().defaultNow(),
  deadlineAt: timestamp('deadline_at', { withTimezone: true }),
  decidedByUserId: uuid('decided_by_user_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  reason: text('reason'),
  /** The stage attempt this approval decides; a later plan needs its own (migration 0012). */
  stage: text('stage'),
  attempt: integer('attempt'),
});

export const workspaces = pgTable('workspaces', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  runnerId: text('runner_id'),
  path: text('path').notNull(),
  status: workspaceStatusEnum('status').notNull().default('provisioning'),
  baseCommit: text('base_commit'),
  diskBytes: bigint('disk_bytes', { mode: 'number' }),
  retentionUntil: timestamp('retention_until', { withTimezone: true }),
  exportedBlobId: uuid('exported_blob_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  destroyedAt: timestamp('destroyed_at', { withTimezone: true }),
});

/** Append-only (technical/03, technical/08). */
export const humanActions = pgTable('human_actions', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id'),
  userId: uuid('user_id'),
  action: text('action').notNull(),
  params: jsonb('params').$type<JsonObject>().notNull().default({}),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The notification outbox (WP-32, migration 0023).
 *
 * `digest_day` is a `date` rather than a timestamp on purpose: it is a *day in the organisation's
 * zone*, which is a calendar fact the application computes (`localDayOf`) and the database must not
 * re-derive — `current_date` here would be the server's day, and the two differ for a third of every
 * day in half the world.
 */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().default(uuidv7),
  projectId: uuid('project_id').notNull(),
  taskId: uuid('task_id'),
  class: text('class').notNull(),
  causeEventId: uuid('cause_event_id').notNull(),
  title: text('title').notNull(),
  detail: text('detail'),
  url: text('url'),
  urgent: boolean('urgent').notNull().default(false),
  plannedDelivery: text('planned_delivery').notNull(),
  mode: text('mode').notNull().default('normal'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  deliveredAs: text('delivered_as'),
  digestDay: date('digest_day'),
  redactionCount: integer('redaction_count').notNull().default(0),
});

/**
 * The ask-the-task thread (WP-31, migration 0024).
 *
 * `citations` is the model's own list after the application dropped the entries that name another
 * task or another project (product/11:30), so it is `JsonValue` rather than a typed shape here: the
 * column is written by one module and read by one projection, and both parse it with
 * `askAnswerCitationSchema` rather than trusting this declaration.
 */
export const taskAsks = pgTable('task_asks', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  projectId: uuid('project_id').notNull(),
  source: text('source').notNull(),
  askedByUserId: uuid('asked_by_user_id').notNull(),
  askedByIdentity: jsonb('asked_by_identity').$type<JsonObject | null>(),
  ticketCommentId: text('ticket_comment_id'),
  question: text('question').notNull(),
  runId: uuid('run_id'),
  status: text('status').notNull().default('pending'),
  answer: text('answer'),
  citations: jsonb('citations').$type<JsonValue>().notNull().default([]),
  droppedCitations: integer('dropped_citations').notNull().default(0),
  answerArtifactId: uuid('answer_artifact_id'),
  refusalReason: text('refusal_reason'),
  redactionCount: integer('redaction_count').notNull().default(0),
  mirroredAt: timestamp('mirrored_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  /**
   * When the stranded-work pass re-enqueued this ask's lost wake-up (migration 0032, backlog 105).
   *
   * The recovery's own column: it is the mark that gives the row **one** attempt and then an
   * ending, so a re-enqueue that keeps failing cannot loop once a minute for ever.
   */
  recoveryAttemptedAt: timestamp('recovery_attempted_at', { withTimezone: true }),
});

/**
 * The epic-split queue — one proposed child ticket per row (WP-40, migration 0033).
 *
 * `acceptance_criteria` is `jsonb` and typed as `JsonValue` here for `task_asks.citations`' reason:
 * the column is written by one module and read by one projection, and **both parse it** with
 * `acceptanceCriterionSchema` rather than trusting this declaration.
 */
export const ticketBreakdownItems = pgTable('ticket_breakdown_items', {
  id: uuid('id').primaryKey().default(uuidv7),
  projectId: uuid('project_id').notNull(),
  taskId: uuid('task_id').notNull(),
  runId: uuid('run_id'),
  artifactId: uuid('artifact_id').notNull(),
  position: integer('position').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull(),
  acceptanceCriteria: jsonb('acceptance_criteria').$type<JsonValue>().notNull(),
  size: text('size').notNull(),
  rationale: text('rationale').notNull(),
  status: text('status').notNull().default('queued'),
  decidedByUserId: uuid('decided_by_user_id'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  reason: text('reason'),
  ticketKey: text('ticket_key'),
  ticketUrl: text('ticket_url'),
  redactionCount: integer('redaction_count').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type Task = typeof tasks.$inferSelect;
export type TaskStage = typeof taskStages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type HumanAction = typeof humanActions.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type TaskAsk = typeof taskAsks.$inferSelect;
export type TicketBreakdownItem = typeof ticketBreakdownItems.$inferSelect;
