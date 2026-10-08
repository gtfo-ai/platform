/**
 * The moment table — WP-174 criterion (5) (TD-029 decision 4).
 */
import type { TaskPipelineDial } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { compilePipeline } from '../pipeline/interpreter.js';
import { CHORE_TEMPLATE, FEATURE_TEMPLATE, TICKET_TEMPLATES } from '../pipeline/templates.js';
import { lastEnabledAgentReviewStage, lifecycleMomentFor } from './moments.js';

const BUSINESS_REVIEW_OFF: TaskPipelineDial = {
  level: 'assist',
  preset_version: 1,
  business_review: false,
  stop_after_stage: null,
};

const feature = compilePipeline('feature', FEATURE_TEMPLATE, null, true);
const featureNoBusiness = compilePipeline('feature', FEATURE_TEMPLATE, BUSINESS_REVIEW_OFF, true);
const chore = compilePipeline('chore', CHORE_TEMPLATE, null, true);

const approved = (stage: string) => ({
  kind: 'stage_completed' as const,
  stage,
  verdict: 'approve',
});
const entered = (stage: string) => ({ kind: 'stage_entered' as const, stage });

describe('lifecycleMomentFor (WP-174 criterion 5)', () => {
  it('fires approved on business_review’s approval, and not on code_review’s while business review runs', () => {
    expect(lifecycleMomentFor(approved('business_review'), feature)).toBe('approved');
    expect(lifecycleMomentFor(approved('code_review'), feature)).toBeNull();
  });

  it('fires approved on code_review’s approval when business review is disabled — by the dial or by the template', () => {
    expect(lastEnabledAgentReviewStage(featureNoBusiness)).toBe('code_review');
    expect(lifecycleMomentFor(approved('code_review'), featureNoBusiness)).toBe('approved');
    expect(lifecycleMomentFor(approved('business_review'), featureNoBusiness)).toBeNull();
    expect(lifecycleMomentFor(approved('code_review'), chore)).toBe('approved');
  });

  it('never fires approved on any other verdict', () => {
    for (const verdict of ['request_changes', 'reject', 'questions', 'pass', null]) {
      expect(
        lifecycleMomentFor({ kind: 'stage_completed', stage: 'business_review', verdict }, feature),
      ).toBeNull();
    }
  });

  it('never fires on a re-entry into rebase_gate — or on any entry into it', () => {
    expect(lifecycleMomentFor(entered('rebase_gate'), feature)).toBeNull();
    expect(lifecycleMomentFor(entered('rebase_gate'), featureNoBusiness)).toBeNull();
    expect(
      lifecycleMomentFor(
        { kind: 'stage_completed', stage: 'rebase_gate', verdict: 'pass' },
        feature,
      ),
    ).toBeNull();
  });

  it('writes in_progress on every entry into a developer-role stage, in_review on code_review, qa on qa and done on merged_gate', () => {
    for (const pipeline of Object.entries(TICKET_TEMPLATES).map(([id, template]) =>
      compilePipeline(id, template, null, true),
    )) {
      expect(lifecycleMomentFor(entered('implementation'), pipeline)).toBe('in_progress');
      expect(lifecycleMomentFor(entered('conflict_resolution'), pipeline)).toBe('in_progress');
      expect(lifecycleMomentFor(entered('code_review'), pipeline)).toBe('in_review');
      expect(lifecycleMomentFor(entered('qa'), pipeline)).toBe('qa');
      expect(lifecycleMomentFor(entered('merged_gate'), pipeline)).toBe('done');
      for (const quiet of ['intake', 'refinement', 'ci_gate', 'ready_for_merge', 'retrospective']) {
        expect({ quiet, slot: lifecycleMomentFor(entered(quiet), pipeline) }).toEqual({
          quiet,
          slot: null,
        });
      }
    }
  });

  it('writes nothing for a stage the pipeline disabled or does not contain', () => {
    const withoutQa = compilePipeline('feature', FEATURE_TEMPLATE, null, false);
    expect(lifecycleMomentFor(entered('qa'), withoutQa)).toBeNull();
    expect(lifecycleMomentFor(entered('business_review'), featureNoBusiness)).toBeNull();
    expect(lifecycleMomentFor(entered('constructor'), feature)).toBeNull();
    expect(lifecycleMomentFor(entered('not_a_stage'), feature)).toBeNull();
  });
});
