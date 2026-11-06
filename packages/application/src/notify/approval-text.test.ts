/**
 * The chat approval's words are held to the closed vocabulary (S-25.9, TD-035 decision 7): every
 * reason code the schema declares has a sentence here, read off the schema rather than listed, so a
 * code added to `approvalReasonSchema` and forgotten in `approval-text.ts` fails this file.
 */
import { type ApprovalReason, approvalReasonSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { IMPLEMENTATION_PLAN } from '../testing/artifact-fixtures.js';
import {
  APPROVAL_PLAN_FILES_SHOWN,
  APPROVAL_REFUSAL_WORDS,
  approvalReasonWords,
  approvalRefusalBody,
  approvalRequestBody,
  planSummaryOf,
  taskPageUrl,
} from './approval-text.js';
import { notificationDraft } from './render.js';

/** One valid reason per code, every variant of `source` included. */
const SAMPLES: readonly ApprovalReason[] = [
  { code: 'risk_class', classes: ['payments'] },
  { code: 'risk_class', classes: ['auth', 'payments'] },
  { code: 'probation', completed: 1, of: 5 },
  { code: 'policy_always', source: 'dial' },
  { code: 'policy_always', source: 'stage_override' },
  { code: 'size_at_or_above', size: 'L', threshold: 'M', source: 'dial' },
  { code: 'size_at_or_above', size: 'L', threshold: 'M', source: 'stage_override' },
  { code: 'estimate_above_threshold', estimate_usd: 12.5, threshold_usd: 10 },
];

/** Plain words for a person in a channel: no decision ids, no spec names, no snake_case codes. */
const NOT_PLAIN = /\b(?:BD|TD|WP|S)-\d|backlog|\b[a-z]+_[a-z_]+\b/i;

describe('the reasons an approval was asked, in words', () => {
  it('words every code the schema declares — the set read off the schema', () => {
    const declared = approvalReasonSchema.options.map((option) => option.shape.code.value).sort();
    const sampled = [...new Set(SAMPLES.map((reason) => reason.code))].sort();
    expect(sampled).toEqual(declared);
    for (const reason of SAMPLES) {
      expect(approvalReasonSchema.parse(reason)).toEqual(reason);
      const words = approvalReasonWords(reason);
      expect(words.length, reason.code).toBeGreaterThan(20);
      expect(words, reason.code).not.toMatch(NOT_PLAIN);
    }
  });

  it('says the numbers the reason carries', () => {
    expect(approvalReasonWords({ code: 'probation', completed: 2, of: 5 })).toBe(
      'The project is on probation: 2 of its first 5 tasks are done.',
    );
    expect(
      approvalReasonWords({
        code: 'estimate_above_threshold',
        estimate_usd: 12.5,
        threshold_usd: 10,
      }),
    ).toContain('$12.50');
    expect(approvalReasonWords({ code: 'risk_class', classes: ['auth', 'payments'] })).toContain(
      'auth and payments risk classes',
    );
  });

  it('tells the stage override from the dial, because the lever differs', () => {
    expect(approvalReasonWords({ code: 'policy_always', source: 'stage_override' })).not.toBe(
      approvalReasonWords({ code: 'policy_always', source: 'dial' }),
    );
  });

  it('bounds a risk class name and unlabels a link in it (project configuration, still text)', () => {
    const words = approvalReasonWords({
      code: 'risk_class',
      classes: [`[Approve](https://attacker.example) ${'x'.repeat(200)}`],
    });
    expect(words).not.toContain('[Approve](');
    expect(words).not.toContain('x'.repeat(60));
  });
});

describe('why a press approved nothing, in words', () => {
  it('words each of the guard’s three refusals, and nothing else', () => {
    expect(Object.keys(APPROVAL_REFUSAL_WORDS).sort()).toEqual([
      'approval_subject_mismatch',
      'approval_subject_superseded',
      'approval_subject_unrecorded',
    ]);
    for (const words of Object.values(APPROVAL_REFUSAL_WORDS)) {
      expect(words).not.toMatch(NOT_PLAIN);
      expect(words).toMatch(/approved|approve/);
    }
  });

  it('answers with the reason and the task page, under the ticket key', () => {
    const body = approvalRefusalBody({
      name: 'ACME-1',
      refusal: 'approval_subject_superseded',
      reviewUrl: 'https://agentic.example.test/tasks/t-1',
    });
    expect(body.markdown.split('\n')).toEqual([
      '**ACME-1: the approval was not applied**',
      APPROVAL_REFUSAL_WORDS.approval_subject_superseded,
      'Review the plan on the task page: https://agentic.example.test/tasks/t-1',
    ]);
    expect(body.blocks).toBeUndefined();
  });
});

describe('the plan a message shows', () => {
  it('summarises a stored plan, and refuses one whose data is not a plan', () => {
    expect(planSummaryOf(2, IMPLEMENTATION_PLAN as never)).toEqual({
      version: 2,
      size: 'M',
      approach: 'Sum the lines in the renderer.',
      files: ['src/totals.ts'],
      fileCount: 1,
      risks: [],
      riskCount: 0,
    });
    expect(planSummaryOf(2, { approach: 'half a plan' })).toBeNull();
    expect(planSummaryOf(2, null)).toBeNull();
  });

  it('shows at most the first files and says how many more', () => {
    const summary = planSummaryOf(1, {
      ...IMPLEMENTATION_PLAN,
      files_to_change: Array.from({ length: APPROVAL_PLAN_FILES_SHOWN + 2 }, (_, index) => ({
        path: `src/f${index}.ts`,
        change: 'x',
      })),
    } as never);
    expect(summary?.files).toHaveLength(APPROVAL_PLAN_FILES_SHOWN);
    expect(summary?.fileCount).toBe(APPROVAL_PLAN_FILES_SHOWN + 2);
  });

  it('puts the task page after the reasons and the ticket link last', () => {
    const draft = notificationDraft({
      notificationClass: 'approval',
      subject: { name: 'ACME-1', url: 'https://tickets.example.test/browse/ACME-1' },
      detail: 'The implementation plan needs a maintainer’s approval before the task goes on.',
    });
    const summary = planSummaryOf(1, IMPLEMENTATION_PLAN as never);
    if (summary === null) {
      throw new Error('the fixture is a plan');
    }
    const lines = approvalRequestBody({
      draft,
      kind: 'plan',
      plan: { kind: 'shown', artifactId: 'p-1', summary },
      reasons: [{ code: 'policy_always', source: 'dial' }],
      reviewUrl: 'https://agentic.example.test/tasks/t-1',
    }).markdown.split('\n');
    expect(lines[0]).toBe('**ACME-1 is waiting for an approval**');
    expect(lines).toContain('Asked because:');
    expect(lines.indexOf('Asked because:')).toBeLessThan(
      lines.indexOf('Review the plan on the task page: https://agentic.example.test/tasks/t-1'),
    );
    expect(lines.at(-1)).toBe('https://tickets.example.test/browse/ACME-1');
  });

  it('drops a task page link that is not a publishable http(s) URL', () => {
    expect(taskPageUrl('https://agentic.example.test/', 't-1')).toBe(
      'https://agentic.example.test/tasks/t-1',
    );
    expect(taskPageUrl('javascript:alert(1)//', 't-1')).toBeNull();
    const draft = notificationDraft({
      notificationClass: 'approval',
      subject: { name: 'ACME-1', url: null },
      detail: null,
    });
    const markdown = approvalRequestBody({
      draft,
      kind: 'budget',
      plan: null,
      reasons: null,
      reviewUrl: 'javascript:alert(1)',
    }).markdown;
    expect(markdown).not.toContain('javascript:');
    expect(markdown).toContain('Why it was asked was not recorded.');
  });
});
