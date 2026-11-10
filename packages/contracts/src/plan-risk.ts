/**
 * Low-risk plans go ahead, the rest wait for a person (S-28.8, the M28 ruling amending BD-006).
 *
 * Three shapes live here because three modules need them and none may import another's:
 *
 *  - the Architect's **self-assessment** on an `ImplementationPlan` (`artifacts.ts`), whose
 *    `risk_factors` are the closed vocabulary {@link PLAN_RISK_FACTORS};
 *  - the reasons an approval stores (`records.ts`), whose `risk_factor` reason also carries the
 *    platform's own findings — {@link RISK_FACTORS} is the plan's vocabulary plus the two facts only
 *    the platform reports;
 *  - the project's opt-in policy `policies.plan_approval_risk` (`config.ts`).
 *
 * The self-assessment is **model output** and therefore untrusted (BD-022): it can only ever add a
 * reason to wait, never remove one (`planApprovalDecision` in `@platform/domain`).
 */
import * as z from 'zod';
import { nonEmptyStringSchema, sizeSchema } from './common.js';

/** What may make a plan risky, as the Architect names it (M28 ruling 2). Closed: no free text. */
export const PLAN_RISK_FACTORS = [
  'schema_migration',
  'auth_security',
  'payments',
  'public_api',
  'infra_ci',
  'data_deletion',
  'many_files',
  'unclear_requirements',
  'new_dependency',
  'other',
] as const;
export const planRiskFactorSchema = z.enum(PLAN_RISK_FACTORS);
export type PlanRiskFactor = z.infer<typeof planRiskFactorSchema>;

/**
 * The plan's factors plus the two the **platform** finds and a model cannot name for it: a path
 * under the project's protected paths, and a plan that proposes splitting the ticket.
 */
export const RISK_FACTORS = [...PLAN_RISK_FACTORS, 'protected_paths', 'split_proposed'] as const;
export const riskFactorSchema = z.enum(RISK_FACTORS);
export type RiskFactor = z.infer<typeof riskFactorSchema>;

/** How sure the Architect is that the plan is right, in its own words. */
export const planConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type PlanConfidence = z.infer<typeof planConfidenceSchema>;

/** How risky the Architect judges the change. */
export const planRiskLevelSchema = z.enum(['low', 'medium', 'high']);
export type PlanRiskLevel = z.infer<typeof planRiskLevelSchema>;

/** How many reasons or open questions one assessment may carry, and how long each may be. */
export const MAX_SELF_ASSESSMENT_ITEMS = 10;
export const MAX_SELF_ASSESSMENT_ITEM_CHARS = 500;

const assessmentItemsSchema = z
  .array(nonEmptyStringSchema.max(MAX_SELF_ASSESSMENT_ITEM_CHARS))
  .max(MAX_SELF_ASSESSMENT_ITEMS);

/**
 * The Architect's own assessment of its plan (M28 ruling 2). Optional on the plan: a plan without
 * one **waits** for a person whenever the project's low-risk rule is on (fail closed).
 */
export const planSelfAssessmentSchema = z.strictObject({
  confidence: planConfidenceSchema,
  risk_level: planRiskLevelSchema,
  risk_factors: z.array(planRiskFactorSchema).max(PLAN_RISK_FACTORS.length),
  reasons: assessmentItemsSchema,
  open_questions: assessmentItemsSchema,
});
export type PlanSelfAssessment = z.infer<typeof planSelfAssessmentSchema>;

/** The highest risk level a plan may have and still go ahead (`high` is never allowed). */
export const planRiskMaximumSchema = z.enum(['low', 'medium']);
/** The lowest confidence a plan may have and still go ahead (`low` is never allowed). */
export const planConfidenceMinimumSchema = z.enum(['high', 'medium']);

/**
 * `policies.plan_approval_risk` — the project's opt-in rule that lets a low-risk plan go ahead
 * without a person (M28 ruling 1). **Off by default.** Every key is optional and its default is
 * `PLAN_APPROVAL_RISK_DEFAULTS` in `@platform/domain`: `enabled: false`, `max_risk: low`,
 * `min_confidence: high`, `max_size: M`, and `always_ask` every factor.
 *
 * When on it replaces only the dial's plan-approval **policy** (`above_size` / `always`); a risk
 * class, probation and a shadow task are decided as before. A repository file may only tighten it
 * (`repository-grades.ts`).
 */
export const planApprovalRiskConfigSchema = z.strictObject({
  enabled: z.boolean().optional(),
  max_risk: planRiskMaximumSchema.optional(),
  min_confidence: planConfidenceMinimumSchema.optional(),
  /** The largest plan size that may go ahead. */
  max_size: sizeSchema.optional(),
  /** Factors that always make a plan wait, whoever found them. */
  always_ask: z.array(riskFactorSchema).max(RISK_FACTORS.length).optional(),
});
export type PlanApprovalRiskConfig = z.infer<typeof planApprovalRiskConfigSchema>;
