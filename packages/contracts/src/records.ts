/**
 * Record shapes that appear both inside event payloads and in API responses.
 *
 * They mirror the persisted rows of docs/technical/03-data-model.md, minus the columns the wire
 * never carries (lease bookkeeping, tsvectors, blob locators).
 */
import * as z from 'zod';
import {
  actorSchema,
  agentRoleSchema,
  approvalKindSchema,
  approvalStatusSchema,
  autonomyLevelSchema,
  coveragePctSchema,
  effortSchema,
  externalIdentitySchema,
  idSchema,
  isoDateTimeSchema,
  knowledgeProposalKindSchema,
  knowledgeProposalSourceSchema,
  knowledgeProposalStatusSchema,
  knowledgeProposalTypeSchema,
  mergeRequestRefSchema,
  modelUsageSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  providerModeSchema,
  questionStatusSchema,
  runCostSchema,
  runModeSchema,
  runStatusSchema,
  runTerminalReasonSchema,
  shaSchema,
  sizeSchema,
  slugSchema,
  stageIdSchema,
  taskModeSchema,
  taskStateSchema,
  templateIdSchema,
  ticketRefSchema,
  tokenCountSchema,
  tokenUsageSchema,
  unitIntervalSchema,
  urlSchema,
  usdSchema,
  workpadRefSchema,
  workspaceStatusSchema,
} from './common.js';

/**
 * Opaque JSON, used only where the platform stores a payload it does not own: redacted
 * integration request/response bodies and webhook envelopes. Everything the platform itself
 * defines gets a strict schema instead.
 */
export const jsonValueSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const jsonObjectSchema = z.record(z.string(), jsonValueSchema);

/** How a human answered — `questions.answered_via` (technical/03). */
export const answerChannelSchema = z.enum(['ui', 'ticket', 'slack', 'api']);

export const questionRecordSchema = z.strictObject({
  id: idSchema,
  task_id: idSchema,
  stage: stageIdSchema,
  run_id: idSchema.nullish(),
  /** Written by an agent; rendered, never executed. */
  text: nonEmptyStringSchema,
  options: z.array(nonEmptyStringSchema).nullish(),
  blocking: z.boolean(),
  status: questionStatusSchema,
  asked_at: isoDateTimeSchema,
  deadline_at: isoDateTimeSchema.nullish(),
  reminders_sent: z.int().nonnegative(),
  answer: z.string().nullish(),
  answered_by_user_id: idSchema.nullish(),
  answered_via: answerChannelSchema.nullish(),
  answered_at: isoDateTimeSchema.nullish(),
});

export const approvalRecordSchema = z.strictObject({
  id: idSchema,
  task_id: idSchema,
  kind: approvalKindSchema,
  status: approvalStatusSchema,
  requested_at: isoDateTimeSchema,
  deadline_at: isoDateTimeSchema.nullish(),
  decided_by_user_id: idSchema.nullish(),
  decided_at: isoDateTimeSchema.nullish(),
  reason: z.string().nullish(),
});

export const workspaceRecordSchema = z.strictObject({
  id: idSchema,
  task_id: idSchema,
  runner_id: nonEmptyStringSchema.nullish(),
  path: nonEmptyStringSchema,
  status: workspaceStatusSchema,
  base_commit: shaSchema.nullish(),
  disk_bytes: z.int().nonnegative().nullish(),
  retention_until: isoDateTimeSchema.nullish(),
});

/**
 * Feedback aggregate (technical/02). Unverified authors are recorded, never acted on (BD-022).
 *
 * `stage` and `artifact_id` were added at WP-15i, when `POST /api/tasks/:id/feedback` became the
 * first writer: `submitFeedbackRequestSchema` has carried both since WP-20 and this record had
 * nowhere to put them, so feedback scoped to a stage would have been stored as feedback about the
 * task. Both are nullish because three of the four scopes have no stage and none but `artifact` has
 * an artifact — the scope says which of them is meaningful, and neither is enforced here.
 */
export const feedbackRecordSchema = z.strictObject({
  id: idSchema,
  project_id: idSchema,
  task_id: idSchema.nullish(),
  author_user_id: idSchema.nullish(),
  author_identity: externalIdentitySchema.nullish(),
  scope: z.enum(['task', 'stage', 'artifact', 'project']),
  stage: stageIdSchema.nullish(),
  artifact_id: idSchema.nullish(),
  text: nonEmptyStringSchema,
  rating: z.int().min(1).max(5).nullish(),
  source_channel: answerChannelSchema,
  created_at: isoDateTimeSchema,
});

export const knowledgeProposalRecordSchema = z.strictObject({
  id: idSchema,
  project_id: idSchema,
  task_id: idSchema.nullish(),
  run_id: idSchema.nullish(),
  source: knowledgeProposalSourceSchema,
  kind: knowledgeProposalKindSchema,
  type: knowledgeProposalTypeSchema,
  target_path: pathPatternSchema,
  delta: nonEmptyStringSchema,
  evidence: z.array(nonEmptyStringSchema),
  significance: unitIntervalSchema,
  status: knowledgeProposalStatusSchema,
  decided_by_user_id: idSchema.nullish(),
  decided_at: isoDateTimeSchema.nullish(),
  applied_commit_sha: shaSchema.nullish(),
  created_at: isoDateTimeSchema,
});

/**
 * Context pack record stored per run (technical/12). `validated` is false for a tier-1 item the
 * validator dropped before the prompt was assembled.
 */
export const contextPackRecordSchema = z.strictObject({
  tier0: z.array(z.strictObject({ path: pathPatternSchema, tokens: tokenCountSchema })),
  tier1: z.array(
    z.strictObject({
      path: pathPatternSchema,
      reason: z.enum(['paths', 'trigger', 'artifact']),
      score: unitIntervalSchema,
      tokens: tokenCountSchema,
      validated: z.boolean(),
    }),
  ),
  budget_tokens: tokenCountSchema,
  total_tokens: tokenCountSchema,
  kb_commit: shaSchema.nullish(),
});

export const diffStatsSchema = z.strictObject({
  files_changed: z.int().nonnegative(),
  insertions: z.int().nonnegative(),
  deletions: z.int().nonnegative(),
});

/** Terminal CI outcome as normalised by the git adapter. */
export const ciStatusSchema = z.enum(['success', 'failed', 'canceled', 'skipped']);

/** Cost and effort totals attached to `task.completed` / `task.cancelled`. */
export const taskTotalsSchema = z.strictObject({
  cost_usd: usdSchema,
  is_estimate: z.boolean(),
  runs: z.int().nonnegative(),
  wall_ms: z.int().nonnegative(),
});

/** Budget scopes and windows (technical/03 `budgets`). */
export const budgetScopeSchema = z.enum(['org', 'project', 'task', 'run']);
export const budgetWindowSchema = z.enum(['day', 'week', 'month', 'total']);

export const budgetRecordSchema = z.strictObject({
  id: idSchema,
  scope: budgetScopeSchema,
  scope_id: idSchema.nullish(),
  window: budgetWindowSchema,
  limit_usd: usdSchema,
  notify_pct: z.array(z.int().min(1).max(100)),
  spent_usd: usdSchema,
  window_start: isoDateTimeSchema.nullish(),
});

/**
 * The four kinds of human minute product/19 §16 defines — `human_time_entries.kind` (WP-29).
 *
 * The order is the database's (`human_time_kind`, migration 0002 plus **0025**'s appended
 * `'steer'`), because `test/integration/db/enums.integration.test.ts` compares the two *in order*
 * and `alter type … add value` without `before`/`after` appends. product/19 §16 lists `steer`
 * fourth as well, so nothing is being re-ordered to match storage.
 */
export const humanTimeKindSchema = z.enum(['review', 'question', 'approval', 'steer']);

/**
 * Where a task's cost estimate came from (product/09, Q65, Q71).
 *
 * `unknown` is the estimator's **refusal** and not an error: a project with no finished task has no
 * history, and a number invented for it would route real tasks past a maintainer or park cheap ones
 * in front of one (standing rule 16). It is distinct from *no basis at all*, which is how a task
 * that has not been through refinement yet is spelled — `null`.
 */
export const estimateBasisSchema = z.enum(['project_history', 'org_history', 'unknown']);

/**
 * What the project's CI said about this task's coverage, and about the branch it will merge into —
 * `tasks.coverage` (WP-39, migration 0027), product/18:38 and product/10:38's *"coverage delta"*.
 *
 * **The base is named in the row rather than implied** (standing rule 63): `base_branch` and
 * `base_sha` are the project's default branch and **its head at the moment this record was
 * written**, which is the instant `measured_at` carries. That is the base a maintainer is actually
 * deciding against — *"what does `main` have now, and what will it have once this merges"* — and it
 * is not the branch point, which this platform does not store anywhere. The staleness window
 * follows from that and is stated rather than left to a reader: the record is as fresh as the last
 * pipeline that finished on this task's merge request, and the default branch may have moved since;
 * a screen that wants the base current must re-read it, which no screen does.
 *
 * **Every number here is missing rather than zero when it is missing** (standing rule 16).
 *
 *  - `head_pct: null` — the pipeline for `head_sha` reported no coverage. It is *not* `0`, which
 *    would read as "the agent's change covers nothing".
 *  - `base_pct: null` — the default branch's own pipeline reported none (or has not finished), so
 *    there is nothing to subtract from. `base_branch`/`base_sha` are then still filled in, because
 *    the platform did read them; all three are `null` only when `head_pct` is, which is the case
 *    the duty stops at without asking the provider for a base it could not use.
 *  - `delta_pct: null` — exactly when either side is missing. A delta is never inferred from one
 *    number.
 *
 * `delta_pct` is `head_pct − base_pct` in **percentage points** and is signed: the sign is the
 * whole point of the panel item, so it is stored rather than recomputed by each reader.
 */
export const taskCoverageSchema = z.strictObject({
  head_sha: shaSchema,
  head_pct: coveragePctSchema.nullable(),
  base_branch: nonEmptyStringSchema.nullable(),
  base_sha: shaSchema.nullable(),
  base_pct: coveragePctSchema.nullable(),
  /** Percentage **points**, `head_pct − base_pct`, so the range is twice a percentage's. */
  delta_pct: z.number().min(-100).max(100).nullable(),
  measured_at: isoDateTimeSchema,
});

export type TaskCoverage = z.infer<typeof taskCoverageSchema>;

export const taskRecordSchema = z.strictObject({
  id: idSchema,
  project_id: idSchema,
  ticket: ticketRefSchema,
  template: templateIdSchema,
  mode: taskModeSchema,
  state: taskStateSchema,
  current_stage: stageIdSchema.nullish(),
  size: sizeSchema.nullish(),
  branch: nonEmptyStringSchema.nullish(),
  mr_ref: mergeRequestRefSchema.nullish(),
  workpad_ref: workpadRefSchema.nullish(),
  iteration_counters: z.record(slugSchema, z.int().nonnegative()),
  risk_classes: z.array(slugSchema),
  /**
   * `tasks.coverage` — what the CI reported for this task's head revision against the default
   * branch (WP-39).
   *
   * `null` means **nothing has been measured**, which is a third answer beside the two inside the
   * record: no pipeline has finished on this task's merge request yet, *or* the project's
   * `policies.coverage_source` is `none` and the platform never asked. The Checks panel prints a
   * different sentence for it than for a pipeline that reported nothing, because "we did not look"
   * and "we looked and there was no number" are different facts about a project (standing rule 18).
   */
  coverage: taskCoverageSchema.nullable(),
  cost_actual_usd: usdSchema,
  cost_estimated_usd: usdSchema,
  /**
   * `tasks.estimate_usd` — the cost predicted **at refinement**, before the spend (WP-19, WP-28).
   *
   * Not the same number as {@link taskRecordSchema}'s `cost_estimated_usd`, which is the part of
   * what the task has *already* spent that was priced from the price list rather than reported by
   * the provider (BD-011). Two fields, two questions: what the platform expected to spend, and how
   * much of what it did spend is measured.
   */
  estimate_usd: usdSchema.nullable(),
  /** `tasks.estimate_basis`; `null` means the estimator has not run on this task at all. */
  estimate_basis: estimateBasisSchema.nullable(),
  /** How many finished tasks the estimate rests on; `null` exactly when `estimate_basis` is. */
  estimate_samples: z.int().nonnegative().nullable(),
  /**
   * product/19 §10's *"Cost estimate accuracy"*, per task: `cost_actual ÷ estimate_usd`.
   *
   * Computed from those two fields and from **nothing else** (`estimateAccuracy`), so 1 is perfect
   * and 2 is twice the estimate. `null` when either side is missing or the estimate was zero — a
   * task with no estimate has no accuracy, and `Infinity` is not a data point. **It understates on
   * a task a human intervened in**: a cancelled run's spend reaches no `cost_entries` row and so no
   * `cost_actual` (PROGRESS backlog 50), which is stated here rather than corrected by this field.
   */
  estimate_accuracy: z.number().nonnegative().nullable(),
  requested_by_user_id: idSchema.nullish(),
  requested_by_identity: externalIdentitySchema.nullish(),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
  completed_at: isoDateTimeSchema.nullish(),
});

export const runRecordSchema = z.strictObject({
  id: idSchema,
  task_id: idSchema,
  project_id: idSchema,
  stage: stageIdSchema,
  role: agentRoleSchema,
  mode: runModeSchema,
  attempt: z.int().positive(),
  session_id: nonEmptyStringSchema.nullish(),
  model: nonEmptyStringSchema,
  effort: effortSchema,
  provider_mode: providerModeSchema,
  prompt_version: nonEmptyStringSchema,
  status: runStatusSchema,
  terminal_reason: runTerminalReasonSchema.nullish(),
  started_at: isoDateTimeSchema.nullish(),
  ended_at: isoDateTimeSchema.nullish(),
  last_output_at: isoDateTimeSchema.nullish(),
  num_turns: z.int().nonnegative(),
  usage: tokenUsageSchema,
  model_usage: z.array(modelUsageSchema),
  cost: runCostSchema,
  wall_ms: z.int().nonnegative(),
  redaction_count: z.int().nonnegative(),
});

/** Precedence chain for the effective configuration (technical/12). */
export const configSourceSchema = z.enum(['default', 'org', 'project', 'repo']);

export const projectRecordSchema = z.strictObject({
  id: idSchema,
  key: slugSchema,
  name: nonEmptyStringSchema,
  repo_url: urlSchema,
  default_branch: nonEmptyStringSchema,
  agentic_dir: nonEmptyStringSchema,
  knowledge_dir: nonEmptyStringSchema,
  autonomy_level: autonomyLevelSchema,
  readiness_level: z.int().min(0).max(5),
  status: z.enum(['active', 'paused', 'archived']),
  created_at: isoDateTimeSchema,
  updated_at: isoDateTimeSchema,
});

/** One row of `human_actions` (technical/03) — every human action is audited (technical/08). */
export const humanActionRecordSchema = z.strictObject({
  id: idSchema,
  task_id: idSchema.nullish(),
  actor: actorSchema,
  action: nonEmptyStringSchema,
  params: jsonObjectSchema,
  created_at: isoDateTimeSchema,
});

export type JsonValue = z.infer<typeof jsonValueSchema>;
export type JsonObject = z.infer<typeof jsonObjectSchema>;
export type AnswerChannel = z.infer<typeof answerChannelSchema>;
export type QuestionRecord = z.infer<typeof questionRecordSchema>;
export type ApprovalRecord = z.infer<typeof approvalRecordSchema>;
export type WorkspaceRecord = z.infer<typeof workspaceRecordSchema>;
export type FeedbackRecord = z.infer<typeof feedbackRecordSchema>;
export type KnowledgeProposalRecord = z.infer<typeof knowledgeProposalRecordSchema>;
export type ContextPackRecord = z.infer<typeof contextPackRecordSchema>;
export type DiffStats = z.infer<typeof diffStatsSchema>;
export type CiStatus = z.infer<typeof ciStatusSchema>;
export type TaskTotals = z.infer<typeof taskTotalsSchema>;
export type BudgetScope = z.infer<typeof budgetScopeSchema>;
export type BudgetWindow = z.infer<typeof budgetWindowSchema>;
export type BudgetRecord = z.infer<typeof budgetRecordSchema>;
export type EstimateBasis = z.infer<typeof estimateBasisSchema>;
export type HumanTimeKind = z.infer<typeof humanTimeKindSchema>;
export type TaskRecord = z.infer<typeof taskRecordSchema>;
export type RunRecord = z.infer<typeof runRecordSchema>;
export type ConfigSource = z.infer<typeof configSourceSchema>;
export type ProjectRecord = z.infer<typeof projectRecordSchema>;
export type HumanActionRecord = z.infer<typeof humanActionRecordSchema>;

// ── The materialised autonomy dial (BD-027, WP-30) ───────────────────────────

/**
 * The granular policies one dial position sets — product/19 §11's table, as stored state.
 *
 * This is the wire form of `@platform/domain`'s `AutonomyPreset`, and it exists here because
 * BD-027's consequence makes the preset **stored** rather than derived: *"Preset tables are
 * versioned; changing a preset definition in a release never silently changes a project's effective
 * policies (they are materialised at selection time and the UI offers 're-apply preset')."* A
 * project therefore keeps a copy of the fifteen values that were in force when its dial was set,
 * and a later release that edits the table changes nothing until somebody re-applies it.
 *
 * The two shapes are held to each other by `packages/domain/src/policies/autonomy.ts`
 * (`toWireAutonomyPolicies` / `fromWireAutonomyPolicies`) and by a test that enumerates both key
 * sets, so a field added to one and forgotten in the other does not compile (standing rule 68).
 */
export const autonomyPoliciesSchema = z.strictObject({
  picks_up_new_tickets: z.boolean(),
  stop_after_stage: slugSchema.nullable(),
  plan_approval: z.enum(['never', 'above_size', 'always']),
  plan_approval_size_threshold: sizeSchema.nullable(),
  plan_approval_for_risk_classes: z.boolean(),
  probation: z.boolean(),
  probation_tasks: z.int().min(0).max(1000),
  business_review: z.boolean(),
  question_timeout: nonEmptyStringSchema,
  human_mr_rounds: z.int().min(0).max(100),
  knowledge_auto_apply: z.boolean(),
  budget_approval_threshold_usd: usdSchema.nullable(),
  review_only: z.boolean(),
  shadow_mode: z.boolean(),
  suggested_readiness_min: z.int().min(0).max(5),
});

/**
 * `projects.autonomy_policies` — what a project's dial meant on the day it was set.
 *
 * `applied_by` is `null` for the rows the materialising migration wrote and for a selection the
 * platform made on a project's behalf; it is never a name this document invents.
 */
export const materialisedAutonomySchema = z.strictObject({
  level: autonomyLevelSchema,
  preset_version: z.int().positive(),
  applied_at: isoDateTimeSchema,
  applied_by: idSchema.nullable(),
  policies: autonomyPoliciesSchema,
});

export type AutonomyPolicies = z.infer<typeof autonomyPoliciesSchema>;
export type MaterialisedAutonomy = z.infer<typeof materialisedAutonomySchema>;
