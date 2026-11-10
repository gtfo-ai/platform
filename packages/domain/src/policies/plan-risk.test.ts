/**
 * S-28.8 (the M28 ruling amending BD-006): low-risk plans go ahead, the rest wait for a person.
 *
 * The two properties the ruling names are asserted over the whole input space — no assessment value
 * can remove an ask a platform fact raised, and `enabled: false` is the gate as it was — beside the
 * unit cases for each fact and each threshold, both sides of each boundary (rule 42).
 */
import {
  approvalReasonSchema,
  type ImplementationPlanData,
  PLAN_RISK_FACTORS,
  type PlanSelfAssessment,
  planConfidenceSchema,
  planRiskLevelSchema,
  RISK_FACTORS,
  type RiskFactor,
  sizeSchema,
} from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  AUTONOMY_ORDER,
  AUTONOMY_PRESETS,
  type PlanApprovalInput,
  type PlanApprovalPolicy,
  planApprovalReasons,
} from './autonomy.js';
import {
  PLAN_APPROVAL_RISK_DEFAULTS,
  PLAN_MANY_FILES_LIMIT,
  type PlanApprovalRiskPolicy,
  type PlanRiskFacts,
  planApprovalDecision,
  planApprovalOutcome,
  planApprovalRiskPolicyOf,
  planRiskFacts,
  tightenPlanApprovalRisk,
} from './plan-risk.js';

const PLAN: ImplementationPlanData = {
  approach: 'Fix the typo in the footer.',
  alternatives_considered: [],
  affected_modules: ['footer'],
  files_to_change: [{ path: 'src/footer.ts', change: 'fix the word' }],
  data_changes: [],
  api_changes: [],
  validation_contract: [],
  test_plan: ['footer renders the word'],
  rollout_notes: '',
  risks: [],
  estimated_size: 'S',
  decisions_to_record: [],
  protected_path_changes: [],
};

const CLEAN: PlanSelfAssessment = {
  confidence: 'high',
  risk_level: 'low',
  risk_factors: [],
  reasons: ['one file, one word'],
  open_questions: [],
};

const ON: PlanApprovalRiskPolicy = { ...PLAN_APPROVAL_RISK_DEFAULTS, enabled: true };

const factsOf = (
  plan: ImplementationPlanData | null,
  extra: Partial<Parameters<typeof planRiskFacts>[0]> = {},
) => planRiskFacts({ plan, riskClasses: undefined, protectedPaths: [], spec: null, ...extra });

const withFiles = (...paths: string[]): ImplementationPlanData => ({
  ...PLAN,
  files_to_change: paths.map((path) => ({ path, change: 'edit' })),
});

describe('planRiskFacts — what the platform reads off a plan', () => {
  it('finds nothing in a one-file text fix', () => {
    expect(factsOf(PLAN)).toEqual({ riskClasses: [], factors: [], size: 'S', files: 1 });
  });

  it.each([
    ['schema_migration', withFiles('db/migrations/0002_add_column.sql')],
    ['schema_migration', { ...PLAN, data_changes: ['add a column'] }],
    ['public_api', { ...PLAN, api_changes: ['new field on GET /invoices'] }],
    ['public_api', withFiles('api/openapi.yaml')],
    ['infra_ci', withFiles('.github/workflows/ci.yml')],
    ['infra_ci', withFiles('Dockerfile')],
    ['auth_security', withFiles('src/auth/session.ts')],
    ['payments', withFiles('src/billing/charge.ts')],
    ['new_dependency', withFiles('package.json')],
    ['new_dependency', withFiles('composer.json')],
    ['split_proposed', { ...PLAN, split_proposal: [{ title: 'first half', scope: 'the API' }] }],
    [
      'protected_paths',
      { ...PLAN, protected_path_changes: [{ path: 'tests/a.test.ts', reason: 'x' }] },
    ],
  ] as [RiskFactor, ImplementationPlanData][])('finds %s', (factor, plan) => {
    expect(factsOf(plan).factors).toContain(factor);
  });

  it('counts many files only above the limit (both sides)', () => {
    const at = withFiles(
      ...Array.from({ length: PLAN_MANY_FILES_LIMIT }, (_, i) => `src/f${i}.ts`),
    );
    const over = withFiles(
      ...Array.from({ length: PLAN_MANY_FILES_LIMIT + 1 }, (_, i) => `src/f${i}.ts`),
    );
    expect(factsOf(at).factors).not.toContain('many_files');
    expect(factsOf(over).factors).toContain('many_files');
  });

  it('reads protected paths and risk classes off the project’s own patterns', () => {
    const facts = factsOf(withFiles('src/pay/x.ts', '.agentic/config.yml'), {
      protectedPaths: ['.agentic/**'],
      riskClasses: {
        money: { paths: ['src/pay/**'], require: ['reviewer:@ops'] },
        other: { paths: ['nowhere/**'], require: ['plan_approval'] },
      },
    });
    expect(facts.factors).toContain('protected_paths');
    // Every matched class, whatever it requires — a match is a statement about the change.
    expect(facts.riskClasses).toEqual(['money']);
  });

  it('reads an unclear specification: a drift flag or open questions', () => {
    expect(factsOf(PLAN, { spec: { drift: true, questions: 0 } }).factors).toEqual([
      'unclear_requirements',
    ]);
    expect(factsOf(PLAN, { spec: { drift: false, questions: 2 } }).factors).toEqual([
      'unclear_requirements',
    ]);
    expect(factsOf(PLAN, { spec: { drift: false, questions: 0 } }).factors).toEqual([]);
  });

  it('has no facts and no size for a missing plan', () => {
    expect(factsOf(null)).toEqual({ riskClasses: [], factors: [], size: null, files: 0 });
  });
});

describe('planApprovalDecision — the rule alone', () => {
  it('lets a clean, small, sure plan go ahead and says what it saw', () => {
    const decision = planApprovalDecision(ON, factsOf(PLAN), CLEAN);
    expect(decision).toEqual({
      kind: 'auto',
      reasons: [
        { code: 'low_risk_auto', confidence: 'high', risk_level: 'low', size: 'S', files: 1 },
      ],
    });
    for (const reason of decision.reasons) {
      expect(approvalReasonSchema.parse(reason)).toEqual(reason);
    }
  });

  it('waits when the plan carries no self-assessment (fail closed)', () => {
    expect(planApprovalDecision(ON, factsOf(PLAN), null)).toEqual({
      kind: 'ask',
      reasons: [{ code: 'assessment_missing' }],
    });
  });

  it('waits for a migration the platform found, whatever the plan says about itself', () => {
    const decision = planApprovalDecision(ON, factsOf(withFiles('db/migrations/0002.sql')), CLEAN);
    expect(decision).toEqual({
      kind: 'ask',
      reasons: [{ code: 'risk_factor', factors: ['schema_migration'], source: 'platform' }],
    });
  });

  it('names every assessment reason: factors, risk level, confidence and open questions', () => {
    const decision = planApprovalDecision(ON, factsOf(PLAN), {
      confidence: 'low',
      risk_level: 'high',
      risk_factors: ['payments', 'payments'],
      reasons: [],
      open_questions: ['which currency?', 'which rounding?'],
    });
    expect(decision.reasons).toEqual([
      { code: 'risk_factor', factors: ['payments'], source: 'plan' },
      { code: 'risk_level_above', risk_level: 'high', maximum: 'low' },
      { code: 'confidence_below', confidence: 'low', minimum: 'high' },
      { code: 'open_questions', count: 2 },
    ]);
  });

  it('holds each threshold at its boundary, from both sides', () => {
    const medium = { ...ON, maxRisk: 'medium' as const, minConfidence: 'medium' as const };
    const atEdge = { ...CLEAN, risk_level: 'medium' as const, confidence: 'medium' as const };
    expect(planApprovalDecision(medium, factsOf(PLAN), atEdge).kind).toBe('auto');
    expect(planApprovalDecision(ON, factsOf(PLAN), atEdge).kind).toBe('ask');
    const sizedM = factsOf({ ...PLAN, estimated_size: 'M' });
    const sizedL = factsOf({ ...PLAN, estimated_size: 'L' });
    expect(planApprovalDecision(ON, sizedM, CLEAN).kind).toBe('auto');
    expect(planApprovalDecision(ON, sizedL, CLEAN).reasons).toEqual([
      { code: 'size_above', size: 'L', maximum: 'M' },
    ]);
  });

  it('lets a factor the project took off the always-ask list through', () => {
    const relaxed = {
      ...ON,
      alwaysAsk: RISK_FACTORS.filter((factor) => factor !== 'protected_paths'),
    };
    const testsOnly = {
      ...PLAN,
      protected_path_changes: [{ path: 'tests/a.test.ts', reason: 'x' }],
    };
    expect(planApprovalDecision(ON, factsOf(testsOnly), CLEAN).kind).toBe('ask');
    expect(planApprovalDecision(relaxed, factsOf(testsOnly), CLEAN).kind).toBe('auto');
  });

  const assessments = fc.record({
    confidence: fc.constantFrom(...planConfidenceSchema.options),
    risk_level: fc.constantFrom(...planRiskLevelSchema.options),
    risk_factors: fc.subarray([...PLAN_RISK_FACTORS]),
    reasons: fc.array(fc.constant('a reason'), { maxLength: 3 }),
    open_questions: fc.array(fc.constant('a question'), { maxLength: 3 }),
  });
  const policies = fc.record({
    enabled: fc.constant(true),
    maxRisk: fc.constantFrom('low' as const, 'medium' as const),
    minConfidence: fc.constantFrom('high' as const, 'medium' as const),
    maxSize: fc.constantFrom(...sizeSchema.options),
    alwaysAsk: fc.subarray([...RISK_FACTORS]),
  });
  const factsArbitrary: fc.Arbitrary<PlanRiskFacts> = fc.record({
    riskClasses: fc.subarray(['auth', 'payments']),
    factors: fc.subarray([...RISK_FACTORS]),
    size: fc.option(fc.constantFrom(...sizeSchema.options), { nil: null }),
    files: fc.nat({ max: 30 }),
  });
  const PLATFORM_CODES = new Set(['risk_class', 'size_above']);
  const platformPart = (reasons: readonly { code: string; source?: string }[]) =>
    reasons.filter(
      (reason) =>
        PLATFORM_CODES.has(reason.code) ||
        (reason.code === 'risk_factor' && reason.source === 'platform'),
    );

  it(
    'never lets an assessment remove an ask a platform fact raised (M28 ruling 4)',
    () => {
      fc.assert(
        fc.property(
          policies,
          factsArbitrary,
          fc.option(assessments, { nil: null }),
          (policy, facts, assessment) => {
            const without = planApprovalDecision(policy, facts, null);
            const withIt = planApprovalDecision(policy, facts, assessment);
            expect(platformPart(withIt.reasons)).toEqual(platformPart(without.reasons));
            if (platformPart(without.reasons).length > 0) {
              expect(withIt.kind).toBe('ask');
            }
            for (const reason of withIt.reasons) {
              expect(approvalReasonSchema.safeParse(reason).success).toBe(true);
            }
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('planApprovalOutcome — the whole gate', () => {
  const dialInput = (
    planApproval: PlanApprovalPolicy,
    over: Partial<PlanApprovalInput> = {},
  ): PlanApprovalInput => ({
    preset: { ...AUTONOMY_PRESETS.supervised, planApproval, probation: false },
    size: 'S',
    tasksCompleted: 0,
    riskClassesRequiringApproval: [],
    ...over,
  });
  const risk = (policy = ON, assessment: PlanSelfAssessment | null = CLEAN) => ({
    policy,
    facts: factsOf(PLAN),
    assessment,
  });

  it('goes ahead under `always` when the rule is on and the plan is clean', () => {
    expect(planApprovalOutcome(dialInput('always'), risk()).kind).toBe('auto');
    expect(planApprovalOutcome(dialInput('always'), null)).toEqual({
      kind: 'ask',
      reasons: [{ code: 'policy_always', source: 'dial' }],
    });
  });

  it('still waits for probation and a risk class the dial asks for, with one class list', () => {
    const outcome = planApprovalOutcome(
      dialInput('above_size', {
        preset: { ...AUTONOMY_PRESETS.supervised, probation: true, probationTasks: 5 },
        tasksCompleted: 1,
        riskClassesRequiringApproval: ['auth'],
      }),
      { ...risk(), facts: { ...factsOf(PLAN), riskClasses: ['auth', 'money'] } },
    );
    expect(outcome).toEqual({
      kind: 'ask',
      reasons: [
        { code: 'risk_class', classes: ['auth', 'money'] },
        { code: 'probation', completed: 1, of: 5 },
      ],
    });
  });

  it('changes nothing under `never`: there is no policy branch to replace', () => {
    expect(planApprovalOutcome(dialInput('never'), risk(ON, null))).toEqual({ kind: 'none' });
  });

  it(
    'is today’s gate when the rule is off, over every input (M28 ruling 4)',
    () => {
      fc.assert(
        fc.property(
          fc.constantFrom(...AUTONOMY_ORDER),
          fc.constantFrom('never', 'above_size', 'always') as fc.Arbitrary<PlanApprovalPolicy>,
          fc.option(fc.constantFrom(...sizeSchema.options), { nil: null }),
          fc.boolean(),
          fc.nat({ max: 8 }),
          fc.subarray(['auth', 'payments']),
          fc.option(assessments, { nil: null }),
          fc.boolean(),
          (level, planApproval, size, probation, completed, classes, assessment, absent) => {
            const input: PlanApprovalInput = {
              preset: { ...AUTONOMY_PRESETS[level], planApproval, probation, probationTasks: 5 },
              size,
              tasksCompleted: completed,
              riskClassesRequiringApproval: classes,
            };
            const reasons = planApprovalReasons(input);
            const outcome = planApprovalOutcome(
              input,
              absent
                ? null
                : { policy: PLAN_APPROVAL_RISK_DEFAULTS, facts: factsOf(PLAN), assessment },
            );
            expect(outcome).toEqual(
              reasons.length === 0 ? { kind: 'none' } : { kind: 'ask', reasons },
            );
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('the policy and its repository tightening', () => {
  it('is off by default, and every factor asks', () => {
    expect(planApprovalRiskPolicyOf(undefined)).toEqual(PLAN_APPROVAL_RISK_DEFAULTS);
    expect(PLAN_APPROVAL_RISK_DEFAULTS.enabled).toBe(false);
    expect([...PLAN_APPROVAL_RISK_DEFAULTS.alwaysAsk]).toEqual([...RISK_FACTORS]);
  });

  it('lets a file switch the rule off, and never on', () => {
    expect(tightenPlanApprovalRisk({ enabled: true }, { enabled: false })).toEqual({
      value: { enabled: false },
      loosened: [],
    });
    expect(tightenPlanApprovalRisk(undefined, { enabled: true })).toEqual({
      value: { enabled: false },
      loosened: ['enabled'],
    });
  });
});
