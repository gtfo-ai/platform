import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  AGENT_ITERATION_LOOPS,
  DEFAULT_ITERATION_LIMITS,
  evaluateIteration,
  hasIdenticalFailureStreak,
  ITERATION_LOOPS,
  incrementIteration,
  isRepeatOfPreviousRound,
  resetAgentIterations,
  resolveIterationLimits,
} from './iteration-limits.js';

describe('BD-008 defaults', () => {
  it('reproduces the decision verbatim', () => {
    expect(DEFAULT_ITERATION_LIMITS).toEqual({
      code_review: 3,
      business_review: 2,
      ci_fix: 3,
      human_rounds: 3,
      refinement_questions: 2,
      architecture_revisions: 2,
    });
    expect([...ITERATION_LOOPS].sort()).toEqual(Object.keys(DEFAULT_ITERATION_LIMITS).sort());
  });
});

describe('resolveIterationLimits', () => {
  it('falls back to the defaults with no configuration', () => {
    expect(resolveIterationLimits()).toEqual(DEFAULT_ITERATION_LIMITS);
  });

  it('takes each configured limit', () => {
    expect(
      resolveIterationLimits({
        code_review_iterations: 5,
        business_review_iterations: 0,
        ci_fix_iterations: 1,
        human_rounds: 4,
      }),
    ).toEqual({
      code_review: 5,
      business_review: 0,
      ci_fix: 1,
      human_rounds: 4,
      refinement_questions: 2,
      architecture_revisions: 2,
    });
  });

  it('uses the autonomy preset for human MR rounds when the config is silent', () => {
    expect(resolveIterationLimits(undefined, 5).human_rounds).toBe(5);
    expect(resolveIterationLimits({ human_rounds: 2 }, 5).human_rounds).toBe(2);
  });
});

describe('evaluateIteration', () => {
  it('allows exactly `limit` iterations, then refuses', () => {
    const limits = resolveIterationLimits({ code_review_iterations: 2 });
    expect(evaluateIteration({}, 'code_review', limits)).toEqual({
      allowed: true,
      next: 1,
      current: 0,
      limit: 2,
    });
    expect(evaluateIteration({ code_review: 1 }, 'code_review', limits).allowed).toBe(true);
    expect(evaluateIteration({ code_review: 2 }, 'code_review', limits).allowed).toBe(false);
  });

  it('refuses immediately when the limit is zero', () => {
    const limits = resolveIterationLimits({ business_review_iterations: 0 });
    expect(evaluateIteration({}, 'business_review', limits).allowed).toBe(false);
  });

  it('increments only the loop it is told to', () => {
    const next = incrementIteration({ ci_fix: 2 }, 'code_review');
    expect(next).toEqual({ ci_fix: 2, code_review: 1 });
  });
});

describe('resetAgentIterations (a human decision resets the agent loop)', () => {
  it('zeroes the agent-to-agent counters and keeps the human rounds', () => {
    const counters = {
      code_review: 3,
      business_review: 1,
      ci_fix: 2,
      refinement_questions: 1,
      architecture_revisions: 1,
      human_rounds: 2,
    };
    expect(resetAgentIterations(counters)).toEqual({
      code_review: 0,
      business_review: 0,
      ci_fix: 0,
      refinement_questions: 0,
      architecture_revisions: 0,
      human_rounds: 2,
    });
  });

  it('leaves counters that were never used absent', () => {
    expect(resetAgentIterations({ human_rounds: 1 })).toEqual({ human_rounds: 1 });
  });

  it('never resets a loop outside the agent-to-agent set', () => {
    expect([...AGENT_ITERATION_LOOPS]).not.toContain('human_rounds');
  });

  it('is idempotent', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.constantFrom(...ITERATION_LOOPS), fc.nat({ max: 9 })),
        (counters) => {
          const once = resetAgentIterations(counters);
          expect(resetAgentIterations(once)).toEqual(once);
        },
      ),
    );
  });
});

describe('convergence detection', () => {
  it('spots a re-review that repeats the previous round (product/04 S5)', () => {
    expect(isRepeatOfPreviousRound([], 'a')).toBe(false);
    expect(isRepeatOfPreviousRound(['a'], 'a')).toBe(true);
    expect(isRepeatOfPreviousRound(['a', 'b'], 'a')).toBe(false);
  });

  it('spots three identical CI failures in a row (product/04 S4)', () => {
    expect(hasIdenticalFailureStreak(['a', 'a'])).toBe(false);
    expect(hasIdenticalFailureStreak(['a', 'a', 'a'])).toBe(true);
    expect(hasIdenticalFailureStreak(['a', 'a', 'b'])).toBe(false);
    expect(hasIdenticalFailureStreak(['b', 'a', 'a', 'a'])).toBe(true);
    expect(hasIdenticalFailureStreak(['a', 'a'], 2)).toBe(true);
    expect(hasIdenticalFailureStreak(['a'], 0)).toBe(false);
  });
});
