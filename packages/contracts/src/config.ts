/**
 * `.agentic/config.yml` — the repository-side, non-secret configuration.
 *
 * Source: docs/technical/12-configuration-and-schemas.md § "`.agentic/config.yml`".
 *
 * Three rules from that document are load-bearing and are enforced here:
 *  1. **Unknown keys are errors.** Every object is strict; validation fails loudly rather than
 *     silently ignoring a typo in a setting an operator believes is active.
 *  2. **Secrets are never accepted from the repo.** No field in this schema takes a credential.
 *  3. **`version` is a major.** The platform refuses unknown majors, so it is a literal.
 *
 * The maps whose keys are user-chosen — `pipeline.template_overrides`, `stages`,
 * `policies.risk_classes`, `status_mapping` — are records with a constrained key schema. There
 * "unknown key" is not a concept: an unexpected *key* is the payload, and an unexpected *value*
 * shape still fails.
 */
import * as z from 'zod';
import {
  autonomyLevelSchema,
  durationSchema,
  effortSchema,
  languageTagSchema,
  nonEmptyStringSchema,
  pathPatternSchema,
  severitySchema,
  sizeSchema,
  slugSchema,
  stageIdSchema,
  templateIdSchema,
  timeOfDaySchema,
  tokenCountSchema,
  unitIntervalSchema,
  usdSchema,
} from './common.js';
import { customStageSchema } from './pipeline.js';

// ── project ──────────────────────────────────────────────────────────────────

export const projectConfigSchema = z.strictObject({
  knowledge_dir: pathPatternSchema.optional(),
  /**
   * Tokens a run's context pack may spend on tiers 0–1 (product/05: "a project setting, default
   * 12k"; technical/07 step 4). Added to the schema at WP-16, with technical/12's example file
   * amended in the same change — product/05 called it a project setting and technical/12's
   * `.agentic/config.yml` had no key for it.
   */
  context_budget_tokens: tokenCountSchema.optional(),
  /** `auto` follows the ticket's language (BD-016). */
  communication_language: z.union([z.literal('auto'), languageTagSchema]).optional(),
  commit_convention: z.enum(['conventional', 'none']).optional(),
  default_branch: nonEmptyStringSchema.optional(),
});

// ── pipeline ─────────────────────────────────────────────────────────────────

/** Per-stage overrides a template may carry (technical/12 `template_overrides.*.stages.*`). */
export const stageOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  plan_approval: z.enum(['never', 'above_size', 'always']).optional(),
  size_threshold: sizeSchema.optional(),
});

export const templateOverrideSchema = z.strictObject({
  enabled: z.boolean().optional(),
  stages: z.record(stageIdSchema, stageOverrideSchema).optional(),
});

/** Bounded loops (BD-008). Every counter has a ceiling; hitting it escalates. */
export const pipelineLimitsSchema = z.strictObject({
  code_review_iterations: z.int().min(0).max(20).optional(),
  business_review_iterations: z.int().min(0).max(20).optional(),
  ci_fix_iterations: z.int().min(0).max(20).optional(),
  human_rounds: z.int().min(0).max(20).optional(),
  question_timeout: durationSchema.optional(),
});

export const pipelineConfigSchema = z.strictObject({
  template_overrides: z.record(templateIdSchema, templateOverrideSchema).optional(),
  custom_stages: z.array(customStageSchema).optional(),
  limits: pipelineLimitsSchema.optional(),
});

// ── stages (agent settings) ──────────────────────────────────────────────────

export const stageAgentSettingsSchema = z.strictObject({
  model: nonEmptyStringSchema.optional(),
  effort: effortSchema.optional(),
  max_turns: z.int().positive().max(1000).optional(),
  budget_usd: usdSchema.optional(),
  prompt: pathPatternSchema.optional(),
  prompt_append: pathPatternSchema.optional(),
});

// ── policies ─────────────────────────────────────────────────────────────────

/** BD-018 thresholds: below `discard_below` the proposal is dropped, above the band it queues. */
export const knowledgeApplyPolicySchema = z.strictObject({
  auto_apply: z.boolean().optional(),
  discard_below: unitIntervalSchema.optional(),
  proposal_above: unitIntervalSchema.optional(),
});

/**
 * What a risk class requires before the task may proceed: a plan approval, and/or a named
 * reviewer (`reviewer:@security`, resolved through CODEOWNERS and identity mapping).
 */
export const riskRequirementSchema = z.union([
  z.enum(['plan_approval', 'budget_approval']),
  z.string().regex(/^reviewer:@?[A-Za-z0-9._\-/]+$/, 'expected "reviewer:@handle"'),
]);

export const riskClassSchema = z.strictObject({
  paths: z.array(pathPatternSchema).min(1),
  require: z.array(riskRequirementSchema).min(1),
});

export const policiesConfigSchema = z.strictObject({
  autonomy: autonomyLevelSchema.optional(),
  probation_tasks: z.int().min(0).max(1000).optional(),
  knowledge_apply: knowledgeApplyPolicySchema.optional(),
  dependency_policy: z.enum(['allow', 'ask', 'block']).optional(),
  /** product/05 (Q7): what drift detection does when no `business/direction.md` exists. */
  drift_without_direction: z.enum(['disabled', 'label_unknown']).optional(),
  protected_paths: z.array(pathPatternSchema).optional(),
  risk_classes: z.record(slugSchema, riskClassSchema).optional(),
});

// ── commands (BD-025) ────────────────────────────────────────────────────────

/**
 * The three-list command policy. A project may only *narrow* the org maximum: entries added to
 * `allow` that the org does not allow are ignored by the merge, and `block` always wins.
 */
export const commandPolicySchema = z.strictObject({
  allow: z.array(nonEmptyStringSchema).optional(),
  ask: z.array(nonEmptyStringSchema).optional(),
  block: z.array(nonEmptyStringSchema).optional(),
});

// ── features (BD-028) ────────────────────────────────────────────────────────

export const featuresConfigSchema = z.strictObject({
  ticket_linter: z
    .strictObject({
      enabled: z.boolean().optional(),
      issue_types: z.array(nonEmptyStringSchema).optional(),
    })
    .optional(),
  review_only: z
    .strictObject({
      enabled: z.boolean().optional(),
      trigger: z.enum(['label', 'all', 'manual']).optional(),
      label: nonEmptyStringSchema.optional(),
      severity_floor: severitySchema.optional(),
    })
    .optional(),
  maintenance: z
    .strictObject({
      enabled: z.boolean().optional(),
      schedule: z.enum(['daily', 'weekly', 'monthly']).optional(),
      budget_usd: usdSchema.optional(),
      chores: z.array(z.enum(['deps', 'flaky', 'docs', 'lint', 'kb'])).optional(),
    })
    .optional(),
  digest: z
    .strictObject({
      enabled: z.boolean().optional(),
      at: timeOfDaySchema.optional(),
      quiet_hours: z
        .strictObject({ from: timeOfDaySchema, to: timeOfDaySchema })
        .nullable()
        .optional(),
    })
    .optional(),
  shadow_mode: z
    .strictObject({
      enabled: z.boolean().optional(),
      budget_usd: usdSchema.optional(),
    })
    .optional(),
});

// ── status mapping ───────────────────────────────────────────────────────────

/**
 * Task state (or stage) → the ticket status name in the provider's own workflow. Keys are
 * project-chosen because a template may add stages; values are provider strings, so they are
 * free text.
 */
export const statusMappingSchema = z.record(slugSchema, nonEmptyStringSchema);

// ── the file ─────────────────────────────────────────────────────────────────

export const agenticConfigSchema = z.strictObject({
  version: z.literal(1),
  project: projectConfigSchema.optional(),
  pipeline: pipelineConfigSchema.optional(),
  stages: z.record(stageIdSchema, stageAgentSettingsSchema).optional(),
  policies: policiesConfigSchema.optional(),
  commands: commandPolicySchema.optional(),
  features: featuresConfigSchema.optional(),
  status_mapping: statusMappingSchema.optional(),
});

export type AgenticConfig = z.infer<typeof agenticConfigSchema>;
export type ProjectConfig = z.infer<typeof projectConfigSchema>;
export type PipelineConfig = z.infer<typeof pipelineConfigSchema>;
export type PipelineLimits = z.infer<typeof pipelineLimitsSchema>;
export type StageAgentSettings = z.infer<typeof stageAgentSettingsSchema>;
export type PoliciesConfig = z.infer<typeof policiesConfigSchema>;
export type RiskClass = z.infer<typeof riskClassSchema>;
export type CommandPolicy = z.infer<typeof commandPolicySchema>;
export type FeaturesConfig = z.infer<typeof featuresConfigSchema>;
export type StatusMapping = z.infer<typeof statusMappingSchema>;
