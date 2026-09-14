import { describe, expect, it } from 'vitest';
import { estimateBasisText, humanTimeBreakdown } from './task-detail.js';

/**
 * The estimate's provenance line on the task page (WP-28, Q71 (b)).
 *
 * It exists because *"the estimator has not run"* and *"it ran and there was nothing to estimate
 * from"* are different facts about a project, and the field they would otherwise share — a blank —
 * states neither. Four states, one sentence each, asserted from every side (standing rule 42): a
 * function that returned one string for all of them would pass any single case.
 *
 * The panel's *number* is asserted here only through its absence, because `formatUsd` is the kit's
 * and has its own tests; what is this function's is the sentence beside it.
 */
const taskWith = (estimate: {
  usd: number | null;
  basis: 'project_history' | 'org_history' | 'unknown' | null;
  samples: number | null;
}) =>
  ({
    estimate_usd: estimate.usd,
    estimate_basis: estimate.basis,
    estimate_samples: estimate.samples,
  }) as Parameters<typeof estimateBasisText>[0];

describe('the estimate basis line', () => {
  it('names this project’s own finished tasks, and counts them', () => {
    expect(estimateBasisText(taskWith({ usd: 12, basis: 'project_history', samples: 7 }))).toBe(
      'From 7 finished tasks in this project.',
    );
    expect(estimateBasisText(taskWith({ usd: 12, basis: 'project_history', samples: 1 }))).toBe(
      'From 1 finished task in this project.',
    );
  });

  it('says the organisation when the project had no history of its own', () => {
    expect(estimateBasisText(taskWith({ usd: 8, basis: 'org_history', samples: 3 }))).toContain(
      'elsewhere in this organisation',
    );
  });

  it('names the refusal rather than leaving the field blank', () => {
    const line = estimateBasisText(taskWith({ usd: null, basis: 'unknown', samples: 0 }));
    expect(line).toContain('no finished task to estimate from');
    // …and it says what bounds the spend meanwhile, which is the thing a maintainer can act on.
    expect(line).toContain('per-task budget cap');
  });

  it('distinguishes "not estimated yet" from "estimated with nothing to go on"', () => {
    const notYet = estimateBasisText(taskWith({ usd: null, basis: null, samples: null }));
    expect(notYet).toContain('when refinement completes');
    expect(notYet).not.toContain('no finished task to estimate from');
  });

  it('does not invent a provenance for a row written before migration 0022', () => {
    expect(estimateBasisText(taskWith({ usd: 4, basis: null, samples: null }))).toContain(
      'before this platform recorded where the figure came from',
    );
  });
});

/**
 * The human-time line under the task page's metric (WP-29, Q73).
 *
 * The same reason the estimate line above exists: *"nothing has happened"* and *"something happened
 * and it measured nothing"* are different facts about a task, and product/19 §16's arithmetic makes
 * the second one ordinary — a merge request with a single comment on it is a **measured** window of
 * zero length. Both are asserted, from both sides (standing rule 42).
 */
const humanTime = (
  over: Partial<Parameters<typeof humanTimeBreakdown>[0]> = {},
): Parameters<typeof humanTimeBreakdown>[0] => ({
  total_minutes: 0,
  by_kind: { review: 0, question: 0, approval: 0, steer: 0 },
  by_user: null,
  entries: 0,
  ...over,
});

describe('the human-time breakdown line', () => {
  it('says nothing has happened when no entry exists', () => {
    const line = humanTimeBreakdown(humanTime());
    expect(line).toContain('No human activity recorded');
    // …and names the four things that would create one, so the sentence is actionable.
    expect(line).toContain('review comment, question, approval or steer');
  });

  it('distinguishes a measured zero from an absence', () => {
    const line = humanTimeBreakdown(humanTime({ entries: 1 }));
    expect(line).not.toContain('No human activity');
    expect(line).toContain('1 entry');
    expect(line).toContain('zero length');
  });

  it('names only the kinds that have minutes, in product/19 §16’s order', () => {
    const line = humanTimeBreakdown(
      humanTime({
        total_minutes: 147.5,
        by_kind: { review: 132.5, question: 0, approval: 10, steer: 5 },
        entries: 4,
      }),
    );
    expect(line).toBe('review 2 h 13 m · approvals 10 m · steers 5 m over 4 entries.');
    // A kind with no minutes is left out rather than printed as a zero: the absent case must not
    // be the quiet one, and here the absence is the *whole line's* job (rule 16, rule 18).
    expect(line).not.toContain('questions');
  });
});
