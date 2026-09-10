/**
 * Pipeline aggregates (technical/03 § "Pipeline"). Mirrors `migrations/0004_pipeline.sql`.
 *
 * Note for the DTO layer: `records.ts` in `@platform/contracts` exposes `RunRecord.stage`, which is
 * not a column here — technical/03 keeps the stage on `task_stages` and links `runs.task_stage_id`
 * to it, so the API projection joins rather than reads it.
 */
import type {
  ExternalIdentity,
  JsonObject,
  JsonValue,
  MergeRequestRef,
  WorkpadRef,
} from '@platform/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
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
  costEstimated: numeric('cost_estimated', { precision: 12, scale: 6 }).notNull().default('0'),
  estimateUsd: numeric('estimate_usd', { precision: 12, scale: 6 }),
  riskClasses: text('risk_classes').array().notNull().default(emptyArray),
  blockedBy: text('blocked_by').array().notNull().default(emptyArray),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp('completed_at', { withTimezone: true }),
});

export const taskStages = pgTable('task_stages', {
  id: uuid('id').primaryKey().default(uuidv7),
  taskId: uuid('task_id').notNull(),
  stage: text('stage').notNull(),
  attempt: integer('attempt').notNull().default(1),
  state: text('state').notNull(),
  enteredAt: timestamp('entered_at', { withTimezone: true }).notNull().defaultNow(),
  exitedAt: timestamp('exited_at', { withTimezone: true }),
  outcome: text('outcome'),
  returnReason: text('return_reason'),
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
  usdEstimated: numeric('usd_estimated', { precision: 12, scale: 6 }).notNull().default('0'),
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
    usdEstimated: numeric('usd_estimated', { precision: 12, scale: 6 }).notNull().default('0'),
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
  /** Validated against the artifact schema of `@platform/contracts` before it is written. */
  data: jsonb('data').$type<JsonValue>().notNull(),
  schemaVersion: text('schema_version').notNull(),
  producedByRunId: uuid('produced_by_run_id'),
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

export type Task = typeof tasks.$inferSelect;
export type TaskStage = typeof taskStages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type HumanAction = typeof humanActions.$inferSelect;
