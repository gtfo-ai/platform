import { describe, expect, it } from 'vitest';
import {
  artifactQuestions,
  reviewFindingSignature,
  roundSignature,
  stageVerdict,
} from './verdicts.js';

const verdictOf = (
  artifactType: Parameters<typeof stageVerdict>[0]['artifactType'],
  data: unknown,
) => stageVerdict({ artifactType, data: data as never, attemptOnLowConfidence: false });

describe('stageVerdict', () => {
  it('reads the verdict field of the two artifacts that have one', () => {
    expect(verdictOf('ReviewVerdict', { verdict: 'approve' })).toBe('approve');
    expect(verdictOf('ReviewVerdict', { verdict: 'request_changes' })).toBe('request_changes');
    expect(verdictOf('AcceptanceVerdict', { verdict: 'request_changes' })).toBe('request_changes');
  });

  it('returns null — not approve — when the verdict field is missing or unknown', () => {
    // Standing rule 16: the producer can omit the field, and the caller escalates on null.
    expect(verdictOf('ReviewVerdict', {})).toBeNull();
    expect(verdictOf('ReviewVerdict', { verdict: 'looks good' })).toBeNull();
    expect(verdictOf('ReviewVerdict', null)).toBeNull();
    expect(verdictOf('ReviewVerdict', ['approve'])).toBeNull();
  });

  it('maps a RefinedSpec decision onto the three endings product/04 S1 gives it', () => {
    expect(verdictOf('RefinedSpec', { decision: 'proceed' })).toBe('approve');
    expect(verdictOf('RefinedSpec', { decision: 'ask' })).toBe('questions');
    expect(verdictOf('RefinedSpec', { decision: 'reject' })).toBe('reject');
    expect(verdictOf('RefinedSpec', { decision: 'maybe' })).toBeNull();
  });

  it('asks for more evidence on a low-confidence root cause unless the policy says otherwise', () => {
    // product/04 S1b, both branches: the policy flag is the only thing that separates them.
    expect(verdictOf('RootCauseAnalysis', { confidence: 'low' })).toBe('questions');
    expect(
      stageVerdict({
        artifactType: 'RootCauseAnalysis',
        data: { confidence: 'low' } as never,
        attemptOnLowConfidence: true,
      }),
    ).toBe('approve');
    expect(verdictOf('RootCauseAnalysis', { confidence: 'high' })).toBe('approve');
    expect(verdictOf('RootCauseAnalysis', {})).toBeNull();
  });

  it('treats "the artifact validated" as the verdict for the types with no verdict channel', () => {
    expect(verdictOf('ImplementationPlan', { approach: 'x' })).toBe('approve');
    expect(verdictOf('ImplementationNotes', { summary: 'x' })).toBe('approve');
    expect(verdictOf('RetroReport', {})).toBe('approve');
    expect(verdictOf(null, null)).toBe('approve');
  });
});

describe('artifactQuestions', () => {
  it('takes the well-formed entries and drops the rest', () => {
    expect(
      artifactQuestions({
        questions: [
          { id: 'q1', text: 'Which currency?', blocking: true, options: ['EUR', 'CZK'] },
          { id: 'q2', text: 'Anything else?', blocking: false },
          { id: 'q3', text: '' },
          { id: 'q4' },
          'not an object',
          null,
        ],
      } as never),
    ).toEqual([
      { text: 'Which currency?', blocking: true, options: ['EUR', 'CZK'] },
      { text: 'Anything else?', blocking: false, options: null },
    ]);
  });

  it('treats a question with no blocking flag as blocking', () => {
    // The fail-closed reading: product/04 makes non-blocking the stated exception.
    expect(artifactQuestions({ questions: [{ text: 'Which currency?' }] } as never)).toEqual([
      { text: 'Which currency?', blocking: true, options: null },
    ]);
  });

  it('returns nothing for an artifact with no questions at all', () => {
    expect(artifactQuestions({} as never)).toEqual([]);
    expect(artifactQuestions({ questions: 'soon' } as never)).toEqual([]);
    expect(artifactQuestions(null)).toEqual([]);
  });
});

describe('convergence signatures', () => {
  it('is order-independent, so the same findings in another order are the same round', () => {
    expect(roundSignature(['b', 'a'])).toBe(roundSignature(['a', 'b']));
    expect(roundSignature(['a'])).not.toBe(roundSignature(['a', 'b']));
  });

  it('builds a review signature from severity, file and id — never from the prose', () => {
    const first = reviewFindingSignature({
      summary: 'The totals are wrong.',
      findings: [{ id: 'f1', severity: 'major', file: 'src/totals.ts', explanation: 'off by one' }],
    } as never);
    const reworded = reviewFindingSignature({
      summary: 'Totals still incorrect, please fix.',
      findings: [
        {
          id: 'f1',
          severity: 'major',
          file: 'src/totals.ts',
          explanation: 'the sum is off by one',
        },
      ],
    } as never);
    expect(first).toBe(reworded);

    const different = reviewFindingSignature({
      findings: [{ id: 'f2', severity: 'major', file: 'src/totals.ts' }],
    } as never);
    expect(different).not.toBe(first);
  });

  it('is empty when there are no findings, so an approval never looks like a repeat', () => {
    expect(reviewFindingSignature({ verdict: 'approve', findings: [] } as never)).toBe('');
    expect(reviewFindingSignature(null)).toBe('');
  });
});
