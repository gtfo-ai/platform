import { describe, expect, it } from 'vitest';
import { estimateBasisText } from './task-detail.js';

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
