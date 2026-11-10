/**
 * What an approval card says (S-25.1, TD-035 decision 7): every reason the vocabulary can carry has
 * a sentence, a lever and the settings section that holds the lever — enumerated off the schema, so
 * a code added to `approvalReasonSchema` and forgotten in `reasonCopy` fails here (rule 68).
 */
import { type ApprovalReason, approvalReasonSchema } from '@platform/contracts';
import { MIN_ESTIMATE_SAMPLES_FOR_APPROVAL } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import {
  approveConsequence,
  budgetApprovalHeadline,
  budgetApproveConsequence,
  budgetNotRequiredLine,
  ESTIMATE_SAMPLES_TO_ASK,
  lowRiskAutoOf,
  reasonCopy,
  reasonShort,
  rejectNext,
  reviewVerb,
  roughEstimateLine,
  subjectLine,
  waitingLine,
  wentAheadLine,
} from './approval-text.js';

/** One reason per code, and both sources where a reason has a source. */
const SAMPLES: readonly ApprovalReason[] = [
  { code: 'risk_class', classes: ['auth'] },
  { code: 'risk_class', classes: ['auth', 'payments', 'migrations'] },
  { code: 'probation', completed: 2, of: 5 },
  { code: 'policy_always', source: 'dial' },
  { code: 'policy_always', source: 'stage_override' },
  { code: 'size_at_or_above', size: 'XL', threshold: 'L', source: 'dial' },
  { code: 'size_at_or_above', size: 'M', threshold: 'M', source: 'stage_override' },
  { code: 'estimate_above_threshold', estimate_usd: 61.5, threshold_usd: 50 },
  { code: 'risk_factor', factors: ['schema_migration'], source: 'platform' },
  { code: 'risk_factor', factors: ['payments', 'other'], source: 'plan' },
  { code: 'confidence_below', confidence: 'medium', minimum: 'high' },
  { code: 'risk_level_above', risk_level: 'medium', maximum: 'low' },
  { code: 'size_above', size: 'L', maximum: 'M' },
  { code: 'open_questions', count: 1 },
  { code: 'assessment_missing' },
  { code: 'files_not_listed', why: 'none' },
  { code: 'files_not_listed', why: 'pattern' },
  { code: 'size_unknown' },
  { code: 'low_risk_auto', confidence: 'high', risk_level: 'low', size: 'S', files: 2 },
];

/**
 * S-28.8: every reason has a short clause for the one-line *Waiting for your approval because: …*
 * the Inbox shows, in plain words — no code name, no snake_case value on screen.
 */
describe('reasonShort and the waiting line', () => {
  it('has a short clause for every code, with no raw value in it', () => {
    for (const reason of SAMPLES) {
      const short = reasonShort(reason);
      expect(short.length, reason.code).toBeGreaterThan(5);
      expect(short, reason.code).not.toMatch(/\b[a-z]+_[a-z_]+\b/);
    }
  });

  it('says who found each risk, as the owner asked for it', () => {
    expect(
      waitingLine([
        { code: 'risk_factor', factors: ['schema_migration'], source: 'platform' },
        { code: 'confidence_below', confidence: 'medium', minimum: 'high' },
      ]),
    ).toBe(
      'Waiting for your approval because: touches database migrations or stored data (found by the platform); confidence medium (the agent’s own assessment).',
    );
    expect(waitingLine(null)).toBe('Waiting for your approval; why was not recorded.');
  });

  it('says what the rule saw when a plan went ahead', () => {
    const auto = lowRiskAutoOf([
      { code: 'low_risk_auto', confidence: 'high', risk_level: 'low', size: 'S', files: 2 },
    ]);
    expect(wentAheadLine(auto)).toBe(
      'Plan went ahead without approval: low risk, high confidence, 2 files.',
    );
    expect(lowRiskAutoOf([{ code: 'probation', completed: 1, of: 5 }])).toBeNull();
    expect(wentAheadLine(null)).toBe('Plan went ahead without approval.');
  });
});

describe('reasonCopy', () => {
  it('covers every code in the vocabulary', () => {
    const codes = approvalReasonSchema.options.map((option) => option.shape.code.value);
    expect(new Set(SAMPLES.map((reason) => reason.code))).toEqual(new Set(codes));
  });

  it.each(SAMPLES.map((reason) => [reason.code, reason] as const))(
    'words %s and names where to stop being asked',
    (_code, reason) => {
      const copy = reasonCopy(reason);
      expect(copy.why.length).toBeGreaterThan(20);
      expect(copy.stop.length).toBeGreaterThan(20);
      expect(['policies', 'repository']).toContain(copy.section);
      expect(copy.link.length).toBeGreaterThan(0);
    },
  );

  it('names the sensitive areas, and recommends keeping the rule', () => {
    expect(reasonCopy({ code: 'risk_class', classes: ['auth'] }).why).toContain(
      'touches auth, an area this project marks as sensitive',
    );
    const many = reasonCopy({ code: 'risk_class', classes: ['auth', 'payments', 'migrations'] });
    expect(many.why).toContain(
      'auth, payments and migrations, areas this project marks as sensitive',
    );
    expect(many.stop).toContain('Keeping it is recommended');
    expect(many.section).toBe('policies');
  });

  it('says how far the first tasks’ extra checks have to go, and who may end them early', () => {
    const copy = reasonCopy({ code: 'probation', completed: 2, of: 5 });
    expect(copy.why).toBe('This project’s first 5 tasks get extra checks, and 2 of them are done.');
    expect(copy.stop).toContain('after 5 completed tasks (3 to go)');
    expect(copy.stop).toContain('a maintainer ends them');
    // S-25.5: the outcome, never the internal word (research/21 § 4).
    expect(`${copy.why} ${copy.stop}`).not.toMatch(/probation/i);
  });

  it('sends a stage override to the repository configuration, and the dial to the policies', () => {
    expect(reasonCopy({ code: 'policy_always', source: 'stage_override' }).section).toBe(
      'repository',
    );
    expect(reasonCopy({ code: 'policy_always', source: 'dial' }).section).toBe('policies');
    const size = reasonCopy({
      code: 'size_at_or_above',
      size: 'M',
      threshold: 'M',
      source: 'stage_override',
    });
    expect(size.section).toBe('repository');
    expect(size.stop).toContain('size threshold');
    // The override may only have turned above_size on: its plan-approval setting is named too, and
    // the dial, which would not stop that ask, is not (review of PR #76). In plain words: visible
    // copy names no configuration file or key (`admin-names-census.test.ts`).
    expect(size.stop).toContain('plan-approval setting');
    expect(size.stop).toContain('repository configuration');
    expect(size.stop).not.toContain('How much agents do alone');
  });

  it('names both budget figures', () => {
    expect(
      reasonCopy({ code: 'estimate_above_threshold', estimate_usd: 61.5, threshold_usd: 50 }).why,
    ).toBe(
      'The estimate made before the expensive stages, $61.50, is above this project’s threshold of $50.00 for asking first.',
    );
  });
});

describe('what each answer does, and the rows’ verb', () => {
  it('says Implementation starts on an approved plan and Architecture gets a rejected one', () => {
    expect(approveConsequence('plan')).toBe('Approve: Implementation starts on this plan.');
    expect(rejectNext('plan')).toBe('Reject: the plan goes back to Architecture with your reason.');
    expect(rejectNext('budget')).toContain('nothing more is spent');
  });

  it('reviews, never approves, from a row', () => {
    expect(reviewVerb('plan')).toBe('Review plan');
    expect(reviewVerb('budget')).toBe('Review budget');
  });
});

describe('subjectLine', () => {
  const plan = {
    kind: 'plan' as const,
    artifact_id: '00000000-0000-4000-8000-0000000000d1',
    artifact_version: 2,
    stage: 'architecture',
    attempt: 1,
    basis: 'recorded' as const,
  };

  it('names the plan’s version, size and files once the plan is read', () => {
    expect(subjectLine('plan', plan)).toBe('Plan v2');
    expect(subjectLine('plan', plan, { size: 'L', files: 6 })).toBe('Plan v2 · size L · 6 files');
    expect(subjectLine('plan', plan, { size: null, files: 1 })).toBe('Plan v2 · 1 file');
  });

  it('says a subject was not recorded, never what it might have been', () => {
    expect(subjectLine('plan', null)).toBe('Plan approval · the plan it is about was not recorded');
    expect(subjectLine('budget', undefined)).toBe(
      'Budget approval · the figures were not recorded',
    );
  });

  it('names a budget’s figures', () => {
    expect(
      subjectLine('budget', {
        kind: 'budget',
        estimate_usd: 61.5,
        threshold_usd: 50,
        estimate_basis: 'project_history',
        estimate_samples: 4,
      }),
    ).toBe(
      'Budget · estimated $61.50 before the spend, above the $50.00 threshold for asking first',
    );
  });
});

/**
 * S-28.16 (BD-010's 2026-11-10 amendment, M28 ruling B2): the owner read *"Estimated $123.66
 * against this project’s threshold of $50.00"* beside *"Cost so far $0.45"* as the budget being
 * over. The card now opens with what was spent, says it is an estimate before the expensive stages
 * and what it rests on, and says what approving does to the cap before the click.
 */
describe('the budget approval’s words (S-28.16)', () => {
  const subject = {
    kind: 'budget' as const,
    estimate_usd: 123.66,
    threshold_usd: 50,
    estimate_basis: 'project_history' as const,
    estimate_samples: 3,
    size: 'L' as const,
    size_weight: 4,
  };

  it('holds the floor to the domain’s one number', () => {
    expect(ESTIMATE_SAMPLES_TO_ASK).toBe(MIN_ESTIMATE_SAMPLES_FOR_APPROVAL);
  });

  it('opens with nothing over budget and the spend, then the estimate, its basis and the threshold', () => {
    expect(budgetApprovalHeadline(subject, 0.45)).toBe(
      'Nothing is over budget: $0.45 spent so far. Before the expensive stages, this task is estimated at $123.66 (size L × 4, from 3 finished tasks), above this project’s threshold of $50.00 for asking a maintainer first.',
    );
    // A row asked before the size was recorded names what it has.
    expect(
      budgetApprovalHeadline(
        {
          kind: 'budget',
          estimate_usd: 123.66,
          threshold_usd: 50,
          estimate_basis: 'project_history',
          estimate_samples: 3,
        },
        0,
      ),
    ).toContain('estimated at $123.66 (from 3 finished tasks)');
  });

  it('says nothing is over budget only while the spend is under the cap', () => {
    expect(budgetApprovalHeadline(subject, 0.45, 50)).toMatch(/^Nothing is over budget: \$0\.45/);
    const atCap = budgetApprovalHeadline(subject, 50, 50);
    expect(atCap).not.toContain('Nothing is over budget');
    expect(atCap).toMatch(
      /^\$50\.00 spent so far, which has reached this task’s cap of \$50\.00\./,
    );
  });

  it('says the cap approving sets: raised above the cap, kept within it', () => {
    expect(budgetApproveConsequence(subject, 50)).toBe(
      'Approve: the task goes on to Implementation. Approving raises this task’s cap from $50.00 to $123.66.',
    );
    expect(budgetApproveConsequence({ ...subject, estimate_usd: 123.651 }, 50)).toContain(
      'to $123.66.',
    );
    expect(budgetApproveConsequence({ ...subject, estimate_usd: 40 }, 50)).toBe(
      'Approve: the task goes on to Implementation within its cap; the cap stays $50.00.',
    );
    expect(approveConsequence('budget')).not.toContain('may spend what was estimated');
  });

  it('labels an estimate on fewer than three finished tasks rough, with the cap that applies', () => {
    const task = { estimate_usd: 123.66, estimate_samples: 1, budget_cap_usd: 50 };
    expect(roughEstimateLine(task)).toBe(
      'Rough estimate $123.66, from 1 finished task — too few to ask you about; the $50.00 cap applies.',
    );
    expect(roughEstimateLine({ ...task, estimate_samples: 3 })).toBeNull();
    expect(roughEstimateLine({ ...task, estimate_usd: null })).toBeNull();
  });

  it('says a settled approval was no longer required, with what the estimate rested on', () => {
    expect(budgetNotRequiredLine({ ...subject, estimate_samples: 1 })).toBe(
      'Budget approval no longer required: the estimate rested on 1 finished task.',
    );
    expect(budgetNotRequiredLine(null)).toContain('too few finished tasks');
  });

  it('never words an estimate as money over budget', () => {
    const reason = {
      code: 'estimate_above_threshold' as const,
      estimate_usd: 123.66,
      threshold_usd: 50,
    };
    for (const words of [
      reasonCopy(reason).why,
      reasonShort(reason),
      subjectLine('budget', subject),
    ]) {
      expect(words).not.toMatch(/over (the )?budget|budget is over|over the \$/i);
    }
  });
});
