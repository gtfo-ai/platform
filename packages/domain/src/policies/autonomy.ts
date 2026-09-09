/**
 * The autonomy dial — BD-027, product/18 § "The autonomy dial", product/19 §11.
 *
 * "Each project has an autonomy level — Observe, Assist, Supervised (default), Autonomous — that
 * sets the granular policies … Granular policies remain overridable; an override shows the dial as
 * *Custom* with the differences."
 *
 * BD-027's consequence is the reason `AUTONOMY_PRESET_VERSION` exists: "Preset tables are
 * versioned; changing a preset definition in a release never silently changes a project's
 * effective policies (they are materialised at selection time and the UI offers 're-apply
 * preset')." So a project stores the *materialised* preset plus its overrides, not the level alone.
 */
import type { AutonomyLevel, Size, Slug } from '@platform/contracts';

/** Bump when any preset below changes. Stored with the materialised policies. */
export const AUTONOMY_PRESET_VERSION = 1;

export type PlanApprovalPolicy = 'never' | 'above_size' | 'always';

export interface AutonomyPreset {
  /** Does the pipeline pick up new tickets at all? Observe runs nothing on new tickets. */
  readonly picksUpNewTickets: boolean;
  /** Assist is "scoping-only": artifacts up to and including this stage, then a human decides. */
  readonly stopAfterStage: Slug | null;
  readonly planApproval: PlanApprovalPolicy;
  /** The size at or above which `above_size` requires approval (BD-006 default: L). */
  readonly planApprovalSizeThreshold: Size | null;
  /** Autonomous still stops for risk-classed changes (product/19 §14). */
  readonly planApprovalForRiskClasses: boolean;
  readonly probation: boolean;
  readonly probationTasks: number;
  readonly businessReview: boolean;
  /** `durationSchema` form; 1 working day at every level (Q8). */
  readonly questionTimeout: string;
  /** Human MR rounds before escalation (BD-007, BD-008). */
  readonly humanMrRounds: number;
  /** Knowledge auto-apply for the middle significance band (BD-018). */
  readonly knowledgeAutoApply: boolean;
  /** Above this estimate a maintainer approves the spend; `null` disables the gate. */
  readonly budgetApprovalThresholdUsd: number | null;
  readonly reviewOnly: boolean;
  readonly shadowMode: boolean;
  /** The readiness level this dial position expects (product/17, BD-026). */
  readonly suggestedReadinessMin: number;
}

const QUESTION_TIMEOUT = '1 working day';

/**
 * product/19 §11, transcribed. Where the table prints "—" the policy does not apply at that level
 * (Observe runs no pipeline, Assist stops before implementation); the value kept here is the
 * conservative one, so a project that overrides `picksUpNewTickets` alone does not accidentally
 * inherit a permissive gate.
 */
export const AUTONOMY_PRESETS: Record<AutonomyLevel, AutonomyPreset> = {
  observe: {
    picksUpNewTickets: false,
    stopAfterStage: null,
    planApproval: 'always',
    planApprovalSizeThreshold: null,
    planApprovalForRiskClasses: true,
    probation: true,
    probationTasks: 5,
    businessReview: false,
    questionTimeout: QUESTION_TIMEOUT,
    humanMrRounds: 3,
    knowledgeAutoApply: false,
    budgetApprovalThresholdUsd: null,
    reviewOnly: true,
    shadowMode: true,
    suggestedReadinessMin: 0,
  },
  assist: {
    picksUpNewTickets: true,
    stopAfterStage: 'architecture',
    planApproval: 'always',
    planApprovalSizeThreshold: null,
    planApprovalForRiskClasses: true,
    probation: true,
    probationTasks: 5,
    businessReview: false,
    questionTimeout: QUESTION_TIMEOUT,
    humanMrRounds: 3,
    knowledgeAutoApply: false,
    budgetApprovalThresholdUsd: 20,
    reviewOnly: false,
    shadowMode: false,
    suggestedReadinessMin: 0,
  },
  supervised: {
    picksUpNewTickets: true,
    stopAfterStage: null,
    planApproval: 'above_size',
    planApprovalSizeThreshold: 'L',
    planApprovalForRiskClasses: true,
    probation: true,
    probationTasks: 5,
    businessReview: true,
    questionTimeout: QUESTION_TIMEOUT,
    humanMrRounds: 3,
    knowledgeAutoApply: false,
    budgetApprovalThresholdUsd: 50,
    reviewOnly: false,
    shadowMode: false,
    suggestedReadinessMin: 1,
  },
  autonomous: {
    picksUpNewTickets: true,
    stopAfterStage: null,
    planApproval: 'never',
    planApprovalSizeThreshold: null,
    planApprovalForRiskClasses: true,
    probation: false,
    probationTasks: 0,
    businessReview: true,
    questionTimeout: QUESTION_TIMEOUT,
    humanMrRounds: 5,
    knowledgeAutoApply: true,
    budgetApprovalThresholdUsd: null,
    reviewOnly: false,
    shadowMode: false,
    suggestedReadinessMin: 2,
  },
};

/** Dial positions in order, so "at most" comparisons are integer comparisons. */
export const AUTONOMY_ORDER = [
  'observe',
  'assist',
  'supervised',
  'autonomous',
] as const satisfies readonly AutonomyLevel[];

export const autonomyRank = (level: AutonomyLevel): number => AUTONOMY_ORDER.indexOf(level);

/** Materialises a level into its granular policies (BD-027: at selection time, not at read time). */
export const applyAutonomyPreset = (level: AutonomyLevel): AutonomyPreset =>
  AUTONOMY_PRESETS[level];

/**
 * Readiness caps the *suggested* level, never the chosen one — "the maintainer can override,
 * visibly" (product/18, Q21). Level 0 readiness suggests at most Assist.
 */
export const suggestedAutonomyCap = (readinessLevel: number): AutonomyLevel => {
  if (readinessLevel <= 0) {
    return 'assist';
  }
  return readinessLevel === 1 ? 'supervised' : 'autonomous';
};

/** The lower of two dial positions. */
export const capAutonomy = (requested: AutonomyLevel, cap: AutonomyLevel): AutonomyLevel =>
  autonomyRank(requested) <= autonomyRank(cap) ? requested : cap;

export interface PresetOverride {
  readonly policy: keyof AutonomyPreset;
  readonly preset: AutonomyPreset[keyof AutonomyPreset];
  readonly effective: AutonomyPreset[keyof AutonomyPreset];
}

/** Which policies a project changed away from its dial position — the UI's *Custom* list. */
export const describePresetOverrides = (
  level: AutonomyLevel,
  effective: Partial<AutonomyPreset>,
): readonly PresetOverride[] => {
  const preset = AUTONOMY_PRESETS[level];
  const overrides: PresetOverride[] = [];
  for (const policy of Object.keys(preset) as (keyof AutonomyPreset)[]) {
    const value = effective[policy];
    if (value !== undefined && value !== preset[policy]) {
      overrides.push({ policy, preset: preset[policy], effective: value });
    }
  }
  return overrides;
};

/** True when the dial should read *Custom* rather than the level's name (BD-027). */
export const isCustomAutonomy = (
  level: AutonomyLevel,
  effective: Partial<AutonomyPreset>,
): boolean => describePresetOverrides(level, effective).length > 0;

/** Sizes in ascending order, for the `above_size` comparison. */
const SIZE_ORDER = ['S', 'M', 'L', 'XL'] as const satisfies readonly Size[];

export interface PlanApprovalInput {
  readonly preset: AutonomyPreset;
  readonly size: Size | null;
  /** Completed tasks in this project, for probation ("the first 5 tasks", BD-006). */
  readonly tasksCompleted: number;
  /** Risk classes matched by the task's touched paths (product/19 §14). */
  readonly riskClassesRequiringApproval: readonly string[];
}

/** Does this task need a maintainer's plan approval before Implementation (BD-006, BD-030)? */
export const requiresPlanApproval = (input: PlanApprovalInput): boolean => {
  if (input.preset.planApprovalForRiskClasses && input.riskClassesRequiringApproval.length > 0) {
    return true;
  }
  if (input.preset.probation && input.tasksCompleted < input.preset.probationTasks) {
    return true;
  }
  switch (input.preset.planApproval) {
    case 'always':
      return true;
    case 'never':
      return false;
    case 'above_size': {
      const threshold = input.preset.planApprovalSizeThreshold;
      if (threshold === null || input.size === null) {
        return false;
      }
      return SIZE_ORDER.indexOf(input.size) >= SIZE_ORDER.indexOf(threshold);
    }
  }
};

/** Does the estimate need a budget approval first (product/18 "Cost estimate before spend")? */
export const requiresBudgetApproval = (preset: AutonomyPreset, estimateUsd: number): boolean =>
  preset.budgetApprovalThresholdUsd !== null && estimateUsd > preset.budgetApprovalThresholdUsd;
