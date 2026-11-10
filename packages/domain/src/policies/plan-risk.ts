/**
 * **Low-risk plans go ahead, the rest wait for a person** — S-28.8, the M28 ruling amending BD-006
 * (the owner: *"where the plan is certain and low-risk we do not want to wait for approval and go
 * right away; where the agent calculates it would be better to have a human in the loop, wait for
 * the human approving"*).
 *
 * Three pure pieces, in the order the gate asks them:
 *
 *  1. {@link planRiskFacts} — what the **platform** reads off the plan, which the model cannot argue
 *     away: every matched risk class, protected paths, data and API changes, dependency manifests,
 *     the file count, the size, a split proposal, and an unclear specification.
 *  2. {@link planApprovalDecision} — the facts and the Architect's **self-assessment** against the
 *     project's thresholds: `ask` with every reason, or `auto` with what it saw. **Facts can only
 *     add asks, and so can the assessment**: no assessment value removes an ask a fact raised
 *     (`plan-risk.test.ts` holds that as a property), and a plan with no assessment waits.
 *  3. {@link planApprovalOutcome} — the whole plan gate: the dial's rules
 *     ({@link planApprovalReasons}), and — only when the rule is on and the dial asked for its
 *     **policy** reasons alone — the decision, which may waive them. The rule can only ever ask
 *     less than the dial (TD-037 decision 4): a plan the dial lets through is untouched, and risk
 *     classes and probation wait as before (properties in `plan-risk.test.ts`).
 *
 * ## What the facts cannot see (M28 ruling 6, stated)
 *
 * `files_to_change` is **model-declared**. A plan that omits a path escapes the facts read from
 * paths — the same residual `risk-classes.ts` states for the risk-class gate, and in the same
 * direction: an omission can only cost an ask, the facts never turn one off. The path readings
 * below are conventions (a `migrations/` directory, a `.github/` tree) and **over-report** on
 * purpose: a false match costs one approval, a missed one costs nothing that was not already the
 * plan's to declare. The check that the real diff stayed inside what the plan declared is filed
 * (BACKLOG 1562). The project's readiness level is **not** a fact on this build: the gate does not
 * read it, and a fact the decision never sees would be decoration.
 */
import type {
  ImplementationPlanData,
  PlanApprovalRiskConfig,
  PlanConfidence,
  PlanRiskLevel,
  PlanSelfAssessment,
  RiskClass,
  RiskFactor,
  Size,
} from '@platform/contracts';
import { PLAN_APPROVAL_RISK_DEFAULT, RISK_FACTORS } from '@platform/contracts';
import {
  type PlanApprovalInput,
  type PlanApprovalReason,
  planApprovalReasons,
} from './autonomy.js';
import { classifyDependencyFile, classifyUnreadManifest } from './dependencies.js';
import { pathMatchesPattern } from './path-patterns.js';
import { riskClassesForPaths } from './risk-classes.js';

/** The project's low-risk rule with every default filled in. */
export interface PlanApprovalRiskPolicy {
  readonly enabled: boolean;
  /** The highest risk level that may go ahead. */
  readonly maxRisk: 'low' | 'medium';
  /** The lowest confidence that may go ahead. */
  readonly minConfidence: 'high' | 'medium';
  /** The largest size that may go ahead. */
  readonly maxSize: Size;
  /** Factors that always make a plan wait, whoever found them. */
  readonly alwaysAsk: readonly RiskFactor[];
}

/**
 * M28 ruling 1's defaults, on the safe side: **off**; when switched on, only a plan the Architect
 * calls low-risk with high confidence, of size M at most, goes ahead — and **every** factor asks,
 * `other` included (a factor the Architect could not name is still one it saw). A project widens
 * the rule by un-ticking factors, never by the default doing it.
 */
export const PLAN_APPROVAL_RISK_DEFAULTS: PlanApprovalRiskPolicy = {
  enabled: PLAN_APPROVAL_RISK_DEFAULT.enabled,
  maxRisk: PLAN_APPROVAL_RISK_DEFAULT.max_risk,
  minConfidence: PLAN_APPROVAL_RISK_DEFAULT.min_confidence,
  maxSize: PLAN_APPROVAL_RISK_DEFAULT.max_size,
  alwaysAsk: PLAN_APPROVAL_RISK_DEFAULT.always_ask,
};

/** The policy a project's `policies.plan_approval_risk` block states, defaults filled in. */
export const planApprovalRiskPolicyOf = (
  config: PlanApprovalRiskConfig | undefined,
): PlanApprovalRiskPolicy => ({
  enabled: config?.enabled ?? PLAN_APPROVAL_RISK_DEFAULTS.enabled,
  maxRisk: config?.max_risk ?? PLAN_APPROVAL_RISK_DEFAULTS.maxRisk,
  minConfidence: config?.min_confidence ?? PLAN_APPROVAL_RISK_DEFAULTS.minConfidence,
  maxSize: config?.max_size ?? PLAN_APPROVAL_RISK_DEFAULTS.maxSize,
  alwaysAsk: config?.always_ask ?? PLAN_APPROVAL_RISK_DEFAULTS.alwaysAsk,
});

/** More files than this in one plan is the platform's `many_files` fact. */
export const PLAN_MANY_FILES_LIMIT = 10;

/** Path conventions the platform reads a factor off (case-insensitive; they over-report). */
export const PLAN_RISK_PATH_PATTERNS = {
  schema_migration:
    /(^|\/)(migrations?|migrate|alembic|flyway|liquibase)(\/|$)|\.sql$|(^|\/)schema\.prisma$/i,
  infra_ci:
    /(^|\/)(\.github|\.gitlab|\.circleci|terraform|helm|k8s|kubernetes|infra)(\/|$)|(^|\/)(\.gitlab-ci\.ya?ml|jenkinsfile|dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose[^/]*\.ya?ml)$|\.tf$/i,
  auth_security:
    /(^|[/_.-])(auth|oauth|login|logout|sessions?|security|permissions?|passwords?|crypto|secrets?|acl|rbac)([/_.-]|$)/i,
  payments: /(^|[/_.-])(payments?|billing|checkout|stripe|invoices?|charges?|refunds?)([/_.-]|$)/i,
  public_api: /(^|\/)(openapi|swagger)[^/]*\.(ya?ml|json)$|\.(proto|graphql|gql)$/i,
} as const satisfies Partial<Record<RiskFactor, RegExp>>;

/** What the platform found in a plan (M28 ruling 3). */
export interface PlanRiskFacts {
  /** Every risk class the plan's paths match — whatever the class requires. */
  readonly riskClasses: readonly string[];
  /** The factors the platform found, in {@link RISK_FACTORS} order. */
  readonly factors: readonly RiskFactor[];
  readonly size: Size | null;
  readonly files: number;
  /**
   * Whether the plan names the files it changes one by one: `none` (an empty list, or no plan) and
   * `pattern` (a glob or wildcard among them) leave the facts nothing exact to read, so such a plan
   * cannot go ahead without a person (review of #136).
   */
  readonly listed: 'listed' | 'none' | 'pattern';
}

/** A path that is a pattern rather than a file: glob and wildcard characters. */
const PATTERN_CHARACTERS = /[*?[\]{}]/;

export interface PlanRiskFactsInput {
  /** The plan, parsed; `null` when there is none or it does not read as a plan. */
  readonly plan: ImplementationPlanData | null;
  readonly riskClasses: Readonly<Record<string, RiskClass>> | undefined;
  readonly protectedPaths: readonly string[];
  /** The task's specification, where one is stored: its drift flag and its open questions. */
  readonly spec: { readonly drift: boolean; readonly questions: number } | null;
}

/** What the platform reads off a plan — never the model's own words about it. */
export const planRiskFacts = (input: PlanRiskFactsInput): PlanRiskFacts => {
  const plan = input.plan;
  if (plan === null) {
    return { riskClasses: [], factors: [], size: null, files: 0, listed: 'none' };
  }
  const paths = plan.files_to_change.map((file) => file.path);
  const declaredProtected = plan.protected_path_changes.map((change) => change.path);
  const found = new Set<RiskFactor>();
  for (const [factor, pattern] of Object.entries(PLAN_RISK_PATH_PATTERNS) as [
    RiskFactor,
    RegExp,
  ][]) {
    if (paths.some((path) => pattern.test(path))) {
      found.add(factor);
    }
  }
  if (plan.data_changes.length > 0) {
    found.add('schema_migration');
  }
  if (plan.api_changes.length > 0) {
    found.add('public_api');
  }
  if (
    paths.some(
      (path) => classifyDependencyFile(path) !== null || classifyUnreadManifest(path) !== null,
    )
  ) {
    found.add('new_dependency');
  }
  if (paths.length > PLAN_MANY_FILES_LIMIT) {
    found.add('many_files');
  }
  if (input.spec !== null && (input.spec.drift || input.spec.questions > 0)) {
    found.add('unclear_requirements');
  }
  if (
    declaredProtected.length > 0 ||
    paths.some((path) => input.protectedPaths.some((pattern) => pathMatchesPattern(pattern, path)))
  ) {
    found.add('protected_paths');
  }
  if ((plan.split_proposal ?? []).length > 0) {
    found.add('split_proposed');
  }
  return {
    riskClasses: [
      ...new Set(riskClassesForPaths(input.riskClasses, [...paths, ...declaredProtected])),
    ].sort(),
    factors: RISK_FACTORS.filter((factor) => found.has(factor)),
    size: plan.estimated_size,
    files: paths.length,
    listed:
      paths.length === 0
        ? 'none'
        : paths.some((path) => PATTERN_CHARACTERS.test(path))
          ? 'pattern'
          : 'listed',
  };
};

const SIZE_ORDER = ['S', 'M', 'L', 'XL'] as const satisfies readonly Size[];
const RISK_ORDER = ['low', 'medium', 'high'] as const satisfies readonly PlanRiskLevel[];
/** Highest first, so a larger index is a lower confidence. */
const CONFIDENCE_ORDER = ['high', 'medium', 'low'] as const satisfies readonly PlanConfidence[];

type LowRiskAuto = Extract<PlanApprovalReason, { code: 'low_risk_auto' }>;

/** The decision of the low-risk rule alone: wait with every reason, or go ahead with what it saw. */
export type PlanRiskDecision =
  | { readonly kind: 'ask'; readonly reasons: readonly PlanApprovalReason[] }
  | { readonly kind: 'auto'; readonly reasons: readonly [LowRiskAuto] };

/**
 * M28 ruling 4: `ask` when **anything** — a fact or the assessment — asks; `auto` only when both
 * are clean and inside the thresholds. The platform's reasons come first and are computed without
 * looking at the assessment, which is what makes "the assessment can only add asks" true by
 * construction rather than by care.
 */
export const planApprovalDecision = (
  policy: PlanApprovalRiskPolicy,
  facts: PlanRiskFacts,
  assessment: PlanSelfAssessment | null,
): PlanRiskDecision => {
  const asks: PlanApprovalReason[] = [];
  if (facts.riskClasses.length > 0) {
    asks.push({ code: 'risk_class', classes: [...facts.riskClasses] });
  }
  const platformFactors = facts.factors.filter((factor) => policy.alwaysAsk.includes(factor));
  if (platformFactors.length > 0) {
    asks.push({ code: 'risk_factor', factors: platformFactors, source: 'platform' });
  }
  if (facts.listed !== 'listed') {
    asks.push({ code: 'files_not_listed', why: facts.listed });
  }
  if (facts.size === null) {
    asks.push({ code: 'size_unknown' });
  } else if (SIZE_ORDER.indexOf(facts.size) > SIZE_ORDER.indexOf(policy.maxSize)) {
    asks.push({ code: 'size_above', size: facts.size, maximum: policy.maxSize });
  }
  if (assessment === null) {
    asks.push({ code: 'assessment_missing' });
    return { kind: 'ask', reasons: asks };
  }
  const planFactors = RISK_FACTORS.filter(
    (factor) =>
      assessment.risk_factors.some((named) => named === factor) &&
      policy.alwaysAsk.includes(factor),
  );
  if (planFactors.length > 0) {
    asks.push({ code: 'risk_factor', factors: planFactors, source: 'plan' });
  }
  if (RISK_ORDER.indexOf(assessment.risk_level) > RISK_ORDER.indexOf(policy.maxRisk)) {
    asks.push({
      code: 'risk_level_above',
      risk_level: assessment.risk_level,
      maximum: policy.maxRisk,
    });
  }
  if (
    CONFIDENCE_ORDER.indexOf(assessment.confidence) > CONFIDENCE_ORDER.indexOf(policy.minConfidence)
  ) {
    asks.push({
      code: 'confidence_below',
      confidence: assessment.confidence,
      minimum: policy.minConfidence,
    });
  }
  if (assessment.open_questions.length > 0) {
    asks.push({ code: 'open_questions', count: assessment.open_questions.length });
  }
  if (asks.length > 0 || facts.size === null) {
    return { kind: 'ask', reasons: asks };
  }
  return {
    kind: 'auto',
    reasons: [
      {
        code: 'low_risk_auto',
        confidence: assessment.confidence,
        risk_level: assessment.risk_level,
        size: facts.size,
        files: facts.files,
      },
    ],
  };
};

/** What the plan gate does: nothing, wait with reasons, or go ahead with what the rule saw. */
export type PlanApprovalOutcome =
  | { readonly kind: 'none' }
  | { readonly kind: 'ask'; readonly reasons: readonly PlanApprovalReason[] }
  | { readonly kind: 'auto'; readonly reasons: readonly [LowRiskAuto] };

export interface PlanRiskInput {
  readonly policy: PlanApprovalRiskPolicy;
  readonly facts: PlanRiskFacts;
  readonly assessment: PlanSelfAssessment | null;
}

/** Two `risk_class` reasons (the dial's and the rule's) are one, with every class. */
const mergeRiskClasses = (reasons: readonly PlanApprovalReason[]): PlanApprovalReason[] => {
  const classes = reasons.flatMap((reason) => (reason.code === 'risk_class' ? reason.classes : []));
  const merged: PlanApprovalReason[] = [];
  for (const reason of reasons) {
    if (reason.code !== 'risk_class') {
      merged.push(reason);
    } else if (!merged.some((entry) => entry.code === 'risk_class')) {
      merged.push({ code: 'risk_class', classes: [...new Set(classes)].sort() });
    }
  }
  return merged;
};

/** The dial's own policy reasons — the only ones the low-risk rule may waive (TD-037 decision 4). */
const POLICY_REASON_CODES: ReadonlySet<PlanApprovalReason['code']> = new Set([
  'size_at_or_above',
  'policy_always',
]);

/**
 * The whole plan gate (TD-037 decision 4, BD-006's 2026-11-10 amendment): the rule can **only ever
 * ask less** than the dial does. It is consulted only when it is on **and** the dial asked, for
 * policy reasons alone (`size_at_or_above`, `policy_always`): a plan the dial lets through is let
 * through exactly as with the rule off (no row, no wait), and a `risk_class` or `probation` reason
 * waits exactly as with the rule off. Then the plan goes ahead when nothing the rule checks asks;
 * otherwise it waits with the dial's reasons and the rule's, so the card says what held it.
 */
export const planApprovalOutcome = (
  input: PlanApprovalInput,
  risk: PlanRiskInput | null,
): PlanApprovalOutcome => {
  const dial = planApprovalReasons(input);
  if (dial.length === 0) {
    return { kind: 'none' };
  }
  if (
    risk === null ||
    !risk.policy.enabled ||
    !dial.every((reason) => POLICY_REASON_CODES.has(reason.code))
  ) {
    return { kind: 'ask', reasons: dial };
  }
  const decided = planApprovalDecision(risk.policy, risk.facts, risk.assessment);
  if (decided.kind === 'auto') {
    return decided;
  }
  return { kind: 'ask', reasons: mergeRiskClasses([...dial, ...decided.reasons]) };
};

/**
 * The repository file's `policies.plan_approval_risk`, **only ever tighter** than the settings'
 * (M28 ruling 1, `repository-grades.ts`). Each key moves toward *ask more*: the file may turn the
 * rule off (which only ever restores the dial's asks, {@link planApprovalOutcome}), never on; lower `max_risk` and `max_size`; raise `min_confidence`; and add to
 * `always_ask` (a union). What it tried to loosen is answered by name in `loosened`, and the value
 * in force there is the settings' (or the default).
 */
export const tightenPlanApprovalRisk = (
  settings: PlanApprovalRiskConfig | undefined,
  repo: PlanApprovalRiskConfig,
): { readonly value: PlanApprovalRiskConfig; readonly loosened: readonly string[] } => {
  const base = planApprovalRiskPolicyOf(settings);
  const loosened: string[] = [];
  const value: { -readonly [K in keyof PlanApprovalRiskConfig]: PlanApprovalRiskConfig[K] } = {
    ...repo,
  };
  if (repo.enabled === true && !base.enabled) {
    value.enabled = false;
    loosened.push('enabled');
  }
  if (
    repo.max_risk !== undefined &&
    RISK_ORDER.indexOf(repo.max_risk) > RISK_ORDER.indexOf(base.maxRisk)
  ) {
    value.max_risk = base.maxRisk;
    loosened.push('max_risk');
  }
  if (
    repo.min_confidence !== undefined &&
    CONFIDENCE_ORDER.indexOf(repo.min_confidence) > CONFIDENCE_ORDER.indexOf(base.minConfidence)
  ) {
    value.min_confidence = base.minConfidence;
    loosened.push('min_confidence');
  }
  if (
    repo.max_size !== undefined &&
    SIZE_ORDER.indexOf(repo.max_size) > SIZE_ORDER.indexOf(base.maxSize)
  ) {
    value.max_size = base.maxSize;
    loosened.push('max_size');
  }
  if (repo.always_ask !== undefined) {
    const kept = base.alwaysAsk.filter((factor) => !repo.always_ask?.includes(factor));
    value.always_ask = RISK_FACTORS.filter(
      (factor) => base.alwaysAsk.includes(factor) || repo.always_ask?.includes(factor),
    );
    if (kept.length > 0) {
      loosened.push('always_ask');
    }
  }
  return { value, loosened };
};
