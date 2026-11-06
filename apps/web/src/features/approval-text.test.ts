/**
 * What an approval card says (S-25.1, TD-035 decision 7): every reason the vocabulary can carry has
 * a sentence, a lever and the settings section that holds the lever — enumerated off the schema, so
 * a code added to `approvalReasonSchema` and forgotten in `reasonCopy` fails here (rule 68).
 */
import { type ApprovalReason, approvalReasonSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  approveConsequence,
  reasonCopy,
  rejectNext,
  reviewVerb,
  subjectLine,
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
];

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

  it('names the risk classes, and recommends keeping the rule', () => {
    expect(reasonCopy({ code: 'risk_class', classes: ['auth'] }).why).toContain(
      'the auth risk class',
    );
    const many = reasonCopy({ code: 'risk_class', classes: ['auth', 'payments', 'migrations'] });
    expect(many.why).toContain('auth, payments and migrations risk classes');
    expect(many.stop).toContain('Keeping it is recommended');
    expect(many.section).toBe('policies');
  });

  it('says how far probation has to go, and who may end it early', () => {
    const copy = reasonCopy({ code: 'probation', completed: 2, of: 5 });
    expect(copy.why).toBe('The project is on probation: 2 of its first 5 tasks are done.');
    expect(copy.stop).toContain('after 5 completed tasks (3 to go)');
    expect(copy.stop).toContain('a maintainer ends it');
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
    expect(size.stop).toContain('size_threshold');
    // The override may only have turned above_size on: its plan_approval is named too, and the
    // dial — which would not stop that ask — is not (review of PR #76).
    expect(size.stop).toContain('plan_approval');
    expect(size.stop).not.toContain('autonomy dial');
  });

  it('names both budget figures', () => {
    expect(
      reasonCopy({ code: 'estimate_above_threshold', estimate_usd: 61.5, threshold_usd: 50 }).why,
    ).toBe('The estimate, $61.50, is above this project’s threshold of $50.00.');
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
    ).toBe('Budget · estimate $61.50, over the $50.00 threshold');
  });
});
