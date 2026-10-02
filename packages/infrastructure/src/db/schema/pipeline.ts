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
  TaskPipelineDial,
  TaskReviewers,
  TaskReviewThreads,
  TicketSnapshot,
  WorkpadRef,
} from '@platform/contracts';
import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
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
  /** WP-60, migration 0044: the newest `ticket.updated`'s receipt time — Q61 (b)'s signal. */
  ticketSignalAt: timestamp('ticket_signal_at', { withTimezone: true }),
  /** WP-60 review round 1, migration 0044: the provider's instant of the recorded `mr_ref.head_sha`. */
  mrHeadAt: timestamp('mr_head_at', { withTimezone: true }),
  /**
   * WP-79, migration 0056: the head the gates judged on the way into `ready_for_merge`, written
   * only by `saveReadyHead` from the Ready entry; `null` when no gate judged one.
   */
  readyHeadSha: text('ready_head_sha'),
  /**
   * WP-79 round 2, migration 0056: the head the CI gate last passed; only `saveCiSettlement` writes
   * it (named `saveCiHead` until WP-102).
   */
  ciHeadSha: text('ci_head_sha'),
  /**
   * WP-102, migration 0065 (Q109 (b)): the protected paths the CI gate's last settlement excused
   * provisionally, redacted; written only by `saveCiSettlement`, in the statement that writes
   * `ci_head_sha`, and read by the rebase gate's settlement.
   */
  ciExcusedPaths: text('ci_excused_paths').array().notNull().default(emptyArray),
  /**
   * WP-84, migration 0059 (backlog 240): the deferred-dependency recovery's one attempt per resume;
   * only the recovery store writes it.
   */
  dependencyRecoveryAttemptedAt: timestamp('dependency_recovery_attempted_at', {
    withTimezone: true,
  }),
  /**
   * WP-108, migration 0067 (backlog 320): the stranded-stage recovery's one attempt per stage entry;
   * only the recovery store writes it.
   */
  stageRecoveryAttemptedAt: timestamp('stage_recovery_attempted_at', { withTimezone: true }),
  /** WP-24, migration 0020: the human merge request a review-only task reviews. */
  reviewSubject: jsonb('review_subject').$type<MergeRequestSnapshot>(),
  /** WP-35, migration 0030: the mined history one bootstrap run reads, bounded and redacted. */
  historySample: jsonb('history_sample').$type<HistorySample>(),
  /**
   * WP-62, migration 0049: the dial's two pipeline policies, frozen at task start — by the insert,
   * and once more by `refreezeSettings` when the task was created under a `configRefusal` (WP-106).
   */
  pipelineDial: jsonb('pipeline_dial').$type<TaskPipelineDial>(),
  /**
   * WP-106, migration 0066: the task's frozen limits and dial were taken under a `configRefusal`, and
   * are taken again from the parsed document before its first admitted run (`refreezeSettings`).
   */
  settingsRefreezePending: boolean('settings_refreeze_pending').notNull().default(false),
  /**
   * WP-106 review round 2, migration 0066: what intake routed the ticket on (`issue_type`,
   * `can_create_tickets`), kept while the re-take is pending so the template is routed again.
   */
  refreezeRouting: jsonb('refreeze_routing').$type<JsonObject>(),
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
  /**
   * The task's own cap, when a maintainer raised it (migration 0072, WP-131 review round 1); `null`
   * is "the default applies". One writer, `TaskRepository.raiseBudgetCap`, and never `save`.
   */
  budgetCapUsd: numeric('budget_cap_usd', { precision: 12, scale: 6 }),
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
  /**
   * The merge request's human review threads, open and resolved, as BD-007's review window last
   * read them (WP-46, migration 0048) — product/10:38's *"review threads open/resolved"*.
   *
   * `null` until the window has read them (no human has commented while the task waited at
   * `ready_for_merge`), which is a different fact from a record whose `open` is zero. Every write is
   * parsed against `taskReviewThreadsSchema`.
   */
  reviewThreads: jsonb('review_threads').$type<TaskReviewThreads>(),
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
  /**
   * The length `return_reason` would have had uncut, or null when nothing cut it (WP-81, migration
   * 0058): the CI gate's log excerpt is bounded before it is stored, and the next run's
   * `return_feedback` marker announces that cut. Positive and only beside a reason
   * (`task_stages_return_reason_original_chars_positive`).
   */
  returnReasonOriginalChars: integer('return_reason_original_chars'),
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
  /**
   * The reservation the run was admitted at — the per-run cap — written by both inserts since
   * migration 0072 (WP-131, PROGRESS backlog 402). A terminal run with both cost columns null is
   * **held** at it by every cap; `null` is *"no reservation was recorded"* (every earlier run), which
   * the caps read at the admitting stage's reserve. Never spend: no ledger row is written from it.
   */
  reserveUsd: numeric('reserve_usd', { precision: 12, scale: 6 }),
  /**
   * The cost columns hold the runner's **floor**, not a measurement — a `cost_unreported` stop
   * (migration 0072, WP-131 pre-review round, backlog 407). The caps hold such a run at
   * {@link runs.reserveUsd} and the task totals count it as unmeasured.
   */
  figureIsFloor: boolean('figure_is_floor').notNull().default(false),
  /**
   * Why the project's prompt files were withheld from this run's prompt — the repository reading's
   * record, frozen at the run's insert (migration 0073, WP-121, backlog 363). `null` is *"nothing
   * was withheld"*, and every run created before 0073.
   */
  promptsWithheld: jsonb('prompts_withheld').$type<JsonObject>(),
  priceListId: uuid('price_list_id'),
  wallMs: bigint('wall_ms', { mode: 'number' }).notNull().default(0),
  redactionCount: integer('redaction_count').notNull().default(0),
  /**
   * The context pack's header — `ContextPackRecord.budget_tokens`, `total_tokens` and `kb_commit`
   * — written by `RunRepository.insert` since migration 0041 (WP-57, PROGRESS backlog 31).
   * `contextBudgetTokens` null is *"no pack was recorded for this run"*; non-null with no
   * {@link runContextPack} rows is an **empty** pack.
   */
  contextBudgetTokens: integer('context_budget_tokens'),
  contextTotalTokens: integer('context_total_tokens'),
  contextKbCommit: text('context_kb_commit'),
  /**
   * `ContextPackRecord.text_search` — what the pack's text step did (migration 0047, WP-44). Null
   * on a run written before it, which is "not recorded" rather than any of the five outcomes.
   */
  contextTextSearch: jsonb('context_text_search').$type<JsonObject>(),
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
    /** Filled on every tier-1 row since migration 0041; a tier-0 row has none. */
    reason: contextPackReasonEnum('reason'),
    /** `double precision` since migration 0041: a `real` rounded the planner's score. */
    score: doublePrecision('score'),
    tokens: integer('tokens').notNull().default(0),
    validated: boolean('validated').notNull().default(true),
    kbCommitSha: text('kb_commit_sha'),
    /** The entry's position within its tier — the record is ordered (migration 0041). */
    ordinal: integer('ordinal'),
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
  /** WP-84, migration 0059: BD-006's reminder, counted as the question's is. */
  remindersSent: integer('reminders_sent').notNull().default(0),
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
 * The command idempotency record — one row per `(user, action, Idempotency-Key)` (migration 0053,
 * WP-67, PROGRESS backlog 47). `completed_at` null is a **claim** taken before a command performs;
 * set, it names the `human_actions` row that recorded the performed command. The migration's header
 * carries the reasoning (why not a unique index on `human_actions`, the retention, the backfill).
 */
export const commandIdempotency = pgTable(
  'command_idempotency',
  {
    userId: uuid('user_id').notNull(),
    action: text('action').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    bodyDigest: text('body_digest'),
    claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    humanActionId: uuid('human_action_id'),
  },
  (table) => [primaryKey({ columns: [table.userId, table.action, table.idempotencyKey] })],
);

/**
 * A human command for a live run, on its way to the process holding it (migration 0060, WP-85,
 * TD-028 decision 9). Pending until the lease holder stamps `appliedAt` or a refusal; a row still
 * pending when the run ends is closed `run_ended` by `RunRepository.finish`, in its transaction.
 * The migration's header carries who writes which state; `cancel` was admitted by migration 0064
 * (WP-101, TD-028 decision 11), whose index also serves the steer window.
 */
export const runCommands = pgTable('run_commands', {
  id: uuid('id').primaryKey(),
  runId: uuid('run_id').notNull(),
  taskId: uuid('task_id').notNull(),
  kind: text('kind').$type<'steer' | 'take_over' | 'cancel'>().notNull(),
  payload: jsonb('payload').$type<JsonObject>().notNull(),
  actorUserId: uuid('actor_user_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
  refusedAt: timestamp('refused_at', { withTimezone: true }),
  refusedReason: text('refused_reason').$type<
    'run_ended' | 'register_miss' | 'delivery_failed' | 'undecodable'
  >(),
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
  // Null for an organisation-scoped notification (migration 0051, WP-65).
  projectId: uuid('project_id'),
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
  // Migration 0051 (WP-65, backlog 202): which approval a posted message asked about, and where it is.
  approvalId: uuid('approval_id'),
  messageRef: jsonb('message_ref').$type<JsonObject | null>(),
  // Migration 0059 (WP-84, backlog 236): the re-post sweep's one attempt.
  repostAttemptedAt: timestamp('repost_attempted_at', { withTimezone: true }),
  // Migration 0059 (WP-84 review round 1): the question a `question` or `reminder` row is about.
  questionId: uuid('question_id'),
});

/**
 * Which task a chat thread belongs to (WP-88, migration 0062, PROGRESS backlog 195) — written by the
 * notify duty when it opens the thread, read by the webhook ingress to resolve a threaded reply.
 */
export const chatThreads = pgTable(
  'chat_threads',
  {
    projectId: uuid('project_id').notNull(),
    integrationId: uuid('integration_id').notNull(),
    taskId: uuid('task_id').notNull(),
    channel: text('channel').notNull(),
    threadId: text('thread_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.integrationId, table.channel, table.threadId] })],
);

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

/**
 * The merge requests a rework let go of, until a duty settles them (migration 0043, WP-59 review
 * round 1, PROGRESS backlog 178). The migration's header carries the argument; this is the typed
 * mirror the parity test holds to it.
 */
export const supersededMergeRequests = pgTable(
  'superseded_merge_requests',
  {
    taskId: uuid('task_id').notNull(),
    iid: integer('iid').notNull(),
    projectId: uuid('project_id').notNull(),
    mrRef: jsonb('mr_ref').$type<MergeRequestRef>().notNull(),
    newBranch: text('new_branch'),
    causeEventId: uuid('cause_event_id').notNull(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }).notNull(),
    settledAt: timestamp('settled_at', { withTimezone: true }),
    outcome: text('outcome'),
    detail: text('detail'),
    recoveryAttemptedAt: timestamp('recovery_attempted_at', { withTimezone: true }),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.iid] })],
);

export type Task = typeof tasks.$inferSelect;
export type SupersededMergeRequestRow = typeof supersededMergeRequests.$inferSelect;
export type TaskStage = typeof taskStages.$inferSelect;
export type Run = typeof runs.$inferSelect;
export type Artifact = typeof artifacts.$inferSelect;
export type Question = typeof questions.$inferSelect;
export type Approval = typeof approvals.$inferSelect;
export type Workspace = typeof workspaces.$inferSelect;
export type HumanAction = typeof humanActions.$inferSelect;
export type CommandIdempotencyRow = typeof commandIdempotency.$inferSelect;
export type RunCommandRow = typeof runCommands.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type TaskAsk = typeof taskAsks.$inferSelect;
export type TicketBreakdownItem = typeof ticketBreakdownItems.$inferSelect;
