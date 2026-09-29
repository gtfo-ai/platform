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
import type {
  AutonomyLevel,
  AutonomyPolicies,
  Id,
  IsoDateTime,
  MaterialisedAutonomy,
  PipelineLimits,
  PoliciesConfig,
  Size,
  Slug,
  TaskPipelineDial,
} from '@platform/contracts';

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
  /**
   * Whether the dial's level runs review-only mode (product/19 §11).
   *
   * **Still not what turns review-only on, and WP-30 decided that rather than closing it.**
   * Review-only mode is *built*, and its switch is the project's `features.review_only.enabled` in
   * `.agentic/config.yml` (BD-028's opt-in), which `packages/application/src/pipeline/review-only.ts`
   * reads. This field is the dial's *recommendation* for that switch — "Observe suggests turning
   * review-only on" — and the wizard's feature card writes the opt-in key, never this. Two switches
   * for one feature would be two answers, so the opt-in key wins by construction: nothing reads this
   * field but the UI's preselection. {@link AUTONOMY_POLICY_READERS} records it as such.
   */
  readonly reviewOnly: boolean;
  readonly shadowMode: boolean;
  /**
   * The readiness level this dial position expects (product/17, BD-026).
   *
   * **Published, and read by nothing** — the suggestion an operator sees is
   * {@link suggestedAutonomyCap} over `projects.readiness_level`, which is the same ladder written
   * the other way round and never consults this field. `autonomy.test.ts` holds the two encodings
   * to each other so they cannot drift; {@link AUTONOMY_POLICY_READERS} records the absence.
   */
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

/**
 * product/18: *"Supervised (default after onboarding)"*.
 *
 * `projects.autonomy_level` defaults to the same word in SQL; this is the constant every **writer**
 * of the materialised preset uses, so the two cannot drift.
 */
export const DEFAULT_AUTONOMY_LEVEL: AutonomyLevel = 'supervised';

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

/**
 * Which policies a project changed away from its baseline — the UI's *Custom* list.
 *
 * The baseline is **either** a dial position (the preset table as this release ships it) **or a
 * preset value**, and the second form is the one a project uses: BD-027:14 stores the preset a
 * project was given, so *Custom* must be measured against **that** copy and not against whatever the
 * current release's table says. Comparing against the level would make every project read *Custom*
 * the day a release edits a preset, which is a label that moved without anybody changing a policy.
 */
export const describePresetOverrides = (
  baseline: AutonomyLevel | AutonomyPreset,
  effective: Partial<AutonomyPreset>,
): readonly PresetOverride[] => {
  const preset = typeof baseline === 'string' ? AUTONOMY_PRESETS[baseline] : baseline;
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
  baseline: AutonomyLevel | AutonomyPreset,
  effective: Partial<AutonomyPreset>,
): boolean => describePresetOverrides(baseline, effective).length > 0;

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

/**
 * Does the estimate need a budget approval first (product/18 "Cost estimate before spend")?
 *
 * **Consumed since WP-28**, by `budgetApprovalGate` in `packages/application/src/pipeline/saga.ts`,
 * which reads the threshold out of the project's **materialised** preset ({@link
 * materialiseAutonomy}, BD-027:14) rather than re-deriving it from the level.
 * {@link AUTONOMY_POLICY_READERS} records the reader.
 *
 * Two properties the caller depends on, both stated here because they are the difference between a
 * gate and a trap. A `null` threshold is the dial saying *"no budget approval at this position"* —
 * Observe and Autonomous both do — and answers **false** rather than gating everything. And the
 * argument is a **number**: a task with no estimate has nothing to compare, and the caller must not
 * pass a zero for it, because zero is below every threshold and would read as "cheap" (standing
 * rule 16). The comparison is strictly greater-than, so a task estimated at exactly the threshold
 * is *not* gated — the boundary is asserted from both sides in `autonomy.test.ts` (rule 42).
 */
export const requiresBudgetApproval = (preset: AutonomyPreset, estimateUsd: number): boolean =>
  preset.budgetApprovalThresholdUsd !== null && estimateUsd > preset.budgetApprovalThresholdUsd;

// ── Materialisation (BD-027:14) ──────────────────────────────────────────────

/**
 * The wire (and stored) spelling of every preset field, and the only place the two names meet.
 *
 * A `satisfies` over both key sets, so a field added to `AutonomyPreset` and forgotten here does not
 * compile, and `autonomy.test.ts` asserts the image is exactly `autonomyPoliciesSchema`'s key set
 * (standing rule 68 — a mapping is a set, and a set is only enumerated if something enumerates it).
 */
export const AUTONOMY_POLICY_WIRE_NAMES = {
  picksUpNewTickets: 'picks_up_new_tickets',
  stopAfterStage: 'stop_after_stage',
  planApproval: 'plan_approval',
  planApprovalSizeThreshold: 'plan_approval_size_threshold',
  planApprovalForRiskClasses: 'plan_approval_for_risk_classes',
  probation: 'probation',
  probationTasks: 'probation_tasks',
  businessReview: 'business_review',
  questionTimeout: 'question_timeout',
  humanMrRounds: 'human_mr_rounds',
  knowledgeAutoApply: 'knowledge_auto_apply',
  budgetApprovalThresholdUsd: 'budget_approval_threshold_usd',
  reviewOnly: 'review_only',
  shadowMode: 'shadow_mode',
  suggestedReadinessMin: 'suggested_readiness_min',
} as const satisfies Record<keyof AutonomyPreset, keyof AutonomyPolicies>;

export const toWireAutonomyPolicies = (preset: AutonomyPreset): AutonomyPolicies => ({
  picks_up_new_tickets: preset.picksUpNewTickets,
  stop_after_stage: preset.stopAfterStage,
  plan_approval: preset.planApproval,
  plan_approval_size_threshold: preset.planApprovalSizeThreshold,
  plan_approval_for_risk_classes: preset.planApprovalForRiskClasses,
  probation: preset.probation,
  probation_tasks: preset.probationTasks,
  business_review: preset.businessReview,
  question_timeout: preset.questionTimeout,
  human_mr_rounds: preset.humanMrRounds,
  knowledge_auto_apply: preset.knowledgeAutoApply,
  budget_approval_threshold_usd: preset.budgetApprovalThresholdUsd,
  review_only: preset.reviewOnly,
  shadow_mode: preset.shadowMode,
  suggested_readiness_min: preset.suggestedReadinessMin,
});

export const fromWireAutonomyPolicies = (wire: AutonomyPolicies): AutonomyPreset => ({
  picksUpNewTickets: wire.picks_up_new_tickets,
  stopAfterStage: wire.stop_after_stage,
  planApproval: wire.plan_approval,
  planApprovalSizeThreshold: wire.plan_approval_size_threshold,
  planApprovalForRiskClasses: wire.plan_approval_for_risk_classes,
  probation: wire.probation,
  probationTasks: wire.probation_tasks,
  businessReview: wire.business_review,
  questionTimeout: wire.question_timeout,
  humanMrRounds: wire.human_mr_rounds,
  knowledgeAutoApply: wire.knowledge_auto_apply,
  budgetApprovalThresholdUsd: wire.budget_approval_threshold_usd,
  reviewOnly: wire.review_only,
  shadowMode: wire.shadow_mode,
  suggestedReadinessMin: wire.suggested_readiness_min,
});

/**
 * BD-027:14, as one function: *"they are materialised at selection time"*.
 *
 * Selecting a level copies the whole preset **plus the version of the table it came from** into the
 * project. Every later read answers from that copy, so a release that edits `AUTONOMY_PRESETS`
 * changes nothing for a project that already chose — which is the property the decision names and
 * the one a level-only column cannot have. Re-applying is calling this again.
 */
export const materialiseAutonomy = (input: {
  readonly level: AutonomyLevel;
  readonly at: IsoDateTime;
  readonly appliedBy: Id | null;
}): MaterialisedAutonomy => ({
  level: input.level,
  preset_version: AUTONOMY_PRESET_VERSION,
  applied_at: input.at,
  applied_by: input.appliedBy,
  policies: toWireAutonomyPolicies(applyAutonomyPreset(input.level)),
});

/**
 * The dial **in force** under the organisation's `autonomy.maximum` (WP-93, BD-025 §2, BD-027's
 * WP-62 clarification: the maximum caps the **level**, never the document keys).
 *
 * At or below the maximum — or with no maximum — the project's own materialised copy, unchanged
 * (the same object). Above it, the maximum's position materialised from **this release's** table,
 * carrying the project's `applied_at`/`applied_by`: the project never chose that position, so it
 * has no copy of it to read, and re-deriving it here is the one place BD-027:14's "materialised at
 * selection time" cannot apply — the selection was the organisation's, at the next read (the WP-93
 * ruling). The project's stored choice is not rewritten: raising the maximum again restores it.
 *
 * A task's frozen dial (`tasks.pipeline_dial`, WP-62) is copied from this at task start, so a task
 * started before the maximum was lowered keeps what it started under.
 */
export const capMaterialisedAutonomy = (
  materialised: MaterialisedAutonomy,
  maximum: AutonomyLevel | undefined,
): MaterialisedAutonomy =>
  maximum === undefined || autonomyRank(materialised.level) <= autonomyRank(maximum)
    ? materialised
    : {
        level: maximum,
        preset_version: AUTONOMY_PRESET_VERSION,
        applied_at: materialised.applied_at,
        applied_by: materialised.applied_by,
        policies: toWireAutonomyPolicies(applyAutonomyPreset(maximum)),
      };

/**
 * The parts of a project's configuration document an override can come from — `ConfigValues`
 * narrowed to the two blocks that carry one, so a caller holding the whole document passes it.
 */
export interface AutonomyOverrideSource {
  readonly policies?: PoliciesConfig | undefined;
  readonly pipeline?: { readonly limits?: PipelineLimits | undefined } | undefined;
}

/**
 * Which preset fields a project may override, and the document key that does it — **the rule, not
 * a snapshot** (Q78, WP-62).
 *
 * BD-027 keeps every policy overridable; Q78 reads that as *"overridable where something reads the
 * override"*, because a preset field with no reader is not a configuration surface. So a field is
 * here **exactly when** its {@link AUTONOMY_POLICY_READERS} entry is `read` **and** a document key
 * already spells the same setting — the preset field and the key are two spellings of one setting,
 * the **key is the override** and the materialised preset is what applies where the document is
 * silent. A `read` field that is *not* here says why in {@link AUTONOMY_POLICIES_NOT_OVERRIDABLE};
 * `autonomy-readers.test.ts` holds the two tables and the readers table to that partition, and
 * drives {@link autonomyOverridesFromConfig} with each key rather than trusting this list.
 *
 * `probation` follows `probation_tasks`, because "probation for 0 tasks" and "probation off" are the
 * same behaviour and two switches for one behaviour is the thing `reviewOnly` is filed for.
 */
export const AUTONOMY_POLICY_OVERRIDE_KEYS = {
  probation: 'policies.probation_tasks',
  probationTasks: 'policies.probation_tasks',
  humanMrRounds: 'pipeline.limits.human_rounds',
  questionTimeout: 'pipeline.limits.question_timeout',
  knowledgeAutoApply: 'policies.knowledge_apply.auto_apply',
} as const satisfies Partial<Record<keyof AutonomyPreset, string>>;

/**
 * The `read` policies a project may **not** override in `.agentic/config.yml`, each with the reason
 * (Q78). A reason, not an owner: these are decided.
 */
export const AUTONOMY_POLICIES_NOT_OVERRIDABLE = {
  planApproval:
    'a project narrows plan approval per stage through `pipeline.template_overrides`; a second spelling of it would be two answers (Q78)',
  planApprovalSizeThreshold:
    'part of plan approval, which a project narrows through `pipeline.template_overrides` (Q78)',
  planApprovalForRiskClasses:
    'deliberately out of reach of `pipeline.template_overrides` as well: a risk class is a statement about the change, not about the stage (product/19 §14), so no per-project key turns the risk-class gate off',
  budgetApprovalThresholdUsd:
    'no document key spells it; the organisation and project budgets (BD-010) are the configurable spend limits, and a key added for it would be a second one',
  picksUpNewTickets:
    'it is what the dial position *is* (Observe); a project that wants tickets picked up moves the dial rather than overriding the position it chose',
  shadowMode:
    'it is what the dial position *is* (Observe); the shadow batch is started by a command, and its budget is `features.shadow_mode`',
  businessReview:
    "no document key that is read spells it: `pipeline.template_overrides.<template>.stages.business_review.enabled` is in technical/12's schema and nothing on this build reads it (PROGRESS backlog 220), and a policy key beside it would be a second switch for one stage",
  stopAfterStage:
    'it is what Assist *is* (scoping-only); a project that wants the code written moves the dial, and one task continues through the hand-back',
} as const satisfies Partial<Record<keyof AutonomyPreset, string>>;

/**
 * The granular overrides a project's `.agentic/config.yml` expresses, as preset fields — exactly
 * the keys {@link AUTONOMY_POLICY_OVERRIDE_KEYS} names (Q78, widened at WP-62 from one entry).
 *
 * A key the document does not set is absent from the result, so the materialised preset applies
 * there: that is backlog 72 (a)'s carrier. Moving the dial to Autonomous changes the human-round
 * ceiling to five **because** the document is silent on `human_rounds`, and a project that wrote
 * `human_rounds: 2` keeps two at every position — the document is the override, never a second
 * switch.
 */
export const autonomyOverridesFromConfig = (
  config: AutonomyOverrideSource | undefined,
): Partial<AutonomyPreset> => {
  const policies = config?.policies;
  const limits = config?.pipeline?.limits;
  return {
    ...(policies?.probation_tasks === undefined
      ? {}
      : { probationTasks: policies.probation_tasks, probation: policies.probation_tasks > 0 }),
    ...(limits?.human_rounds === undefined ? {} : { humanMrRounds: limits.human_rounds }),
    ...(limits?.question_timeout === undefined ? {} : { questionTimeout: limits.question_timeout }),
    ...(policies?.knowledge_apply?.auto_apply === undefined
      ? {}
      : { knowledgeAutoApply: policies.knowledge_apply.auto_apply }),
  };
};

/** The policies actually in force: the materialised preset, with the project's overrides on top. */
export const effectiveAutonomyPreset = (
  materialised: MaterialisedAutonomy,
  config: AutonomyOverrideSource | undefined,
): AutonomyPreset => ({
  ...fromWireAutonomyPolicies(materialised.policies),
  ...autonomyOverridesFromConfig(config),
});

/**
 * The two policies that shape a task's **pipeline**, as the task freezes them at start (WP-62,
 * `tasks.pipeline_dial`). `compilePipeline` is the reader of both.
 */
export const pipelineDialOf = (
  materialised: MaterialisedAutonomy,
  preset: AutonomyPreset,
): TaskPipelineDial => ({
  level: materialised.level,
  preset_version: materialised.preset_version,
  business_review: preset.businessReview,
  stop_after_stage: preset.stopAfterStage,
});

/**
 * Who reads each policy this dial sets — the enumeration standing rule 18 asks for.
 *
 * `EVENT_CONSUMPTION` is the precedent: an unconsumed event is *declared* unconsumed, with the work
 * package that will flip it, because the absent case must not be the quiet one. **Fifteen** fields
 * were stored and none was read before WP-30; **thirteen** are read since WP-62, and the two that
 * are not are decided rather than deferred (each says why). The keys are held to `AutonomyPreset` by the `satisfies` below, and every `by` is a
 * **repository path** resolved against the tree by
 * `packages/domain/src/policies/autonomy-readers.test.ts`: it must be a file git knows about whose
 * text names the policy, and it may not be this module. Round 1 of WP-30 claimed that check in this
 * docblock and asserted `by.length > 0`, which is how `suggestedReadinessMin` came to cite a
 * `routes/autonomy.ts` nobody has written (standing rules 3 and 44).
 */
export type AutonomyPolicyReader =
  /** Something in this build reads it; `by` opens with the reader's path from the repository root. */
  | { readonly kind: 'read'; readonly by: string }
  /**
   * Nothing reads it. `owner` is the work package that will, the literal `'none'` when no row owns
   * it, or a decision — which is what both remaining entries carry since WP-62 read the five that
   * said `'none'` (PROGRESS backlog 72). `autonomy-readers.test.ts` refuses `'none'` today, so a
   * new unread policy has to name its owner or its decision.
   */
  | { readonly kind: 'unread'; readonly owner: string; readonly why: string };

export const AUTONOMY_POLICY_READERS = {
  planApproval: {
    kind: 'read',
    by: 'packages/application/src/pipeline/saga.ts — planApprovalGate (WP-30)',
  },
  planApprovalSizeThreshold: {
    kind: 'read',
    by: 'packages/application/src/pipeline/saga.ts — planApprovalGate (WP-30)',
  },
  planApprovalForRiskClasses: {
    kind: 'read',
    by: 'packages/application/src/pipeline/saga.ts — planApprovalGate (WP-30)',
  },
  probation: {
    kind: 'read',
    by: 'packages/application/src/pipeline/saga.ts — planApprovalGate (WP-30)',
  },
  probationTasks: {
    kind: 'read',
    by: 'packages/application/src/pipeline/saga.ts — planApprovalGate (WP-30)',
  },
  suggestedReadinessMin: {
    kind: 'unread',
    owner: 'WP-30 (decided, not deferred)',
    why: "the readiness a position expects (product/19 §11's last row). It travels inside the published document, and the *suggestion* an operator sees is `suggestedAutonomyCap` over `projects.readiness_level` — a separate function that never reads this field. Two sources for one suggestion would be two answers, which is `reviewOnly`'s argument again; `autonomy.test.ts` holds the two encodings of the ladder to each other instead",
  },
  budgetApprovalThresholdUsd: {
    kind: 'read',
    by: 'packages/application/src/pipeline/saga.ts — budgetApprovalGate (WP-28)',
  },
  reviewOnly: {
    kind: 'unread',
    owner: 'WP-30 (decided, not deferred)',
    why: "the dial only recommends: `features.review_only.enabled` is the opt-in switch BD-028 specifies and WP-24 reads, and the wizard's card writes that key. Two switches for one feature would be two answers",
  },
  picksUpNewTickets: {
    kind: 'read',
    by: 'packages/application/src/pipeline/saga.ts — runIntakeCheck (WP-34)',
  },
  stopAfterStage: {
    kind: 'read',
    by: 'packages/application/src/pipeline/settings.ts — pipelineDialFor freezes it onto the task (WP-62); packages/domain/src/pipeline/interpreter.ts — interpret parks the task after the stage (Q79)',
  },
  businessReview: {
    kind: 'read',
    by: 'packages/application/src/pipeline/settings.ts — pipelineDialFor freezes it onto the task (WP-62); packages/domain/src/pipeline/interpreter.ts — compilePipeline disables the stage',
  },
  questionTimeout: {
    kind: 'read',
    by: "packages/application/src/pipeline/deadline-rules.ts — questionTimeoutOf, where the document's `pipeline.limits.question_timeout` is silent (WP-62)",
  },
  humanMrRounds: {
    kind: 'read',
    by: "packages/application/src/pipeline/settings.ts — iterationLimitsFor, the task's `human_rounds` ceiling where the document is silent (WP-62)",
  },
  knowledgeAutoApply: {
    kind: 'read',
    by: "packages/application/src/knowledge/librarian.ts — thresholdsFromConfig, where the document's `policies.knowledge_apply.auto_apply` is silent (WP-62)",
  },
  shadowMode: {
    kind: 'read',
    by: 'packages/application/src/shadow/batch.ts — startShadowBatch (WP-34)',
  },
} as const satisfies Record<keyof AutonomyPreset, AutonomyPolicyReader>;
