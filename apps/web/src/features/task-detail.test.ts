import type { TaskCoverage } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  coverageBasisText,
  coverageValueText,
  estimateBasisText,
  humanTimeBreakdown,
} from './task-detail.js';

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

/**
 * The Checks panel's coverage item (WP-39, product/18:38).
 *
 * Four answers and they must not collapse into each other — *"we did not look"*, *"we looked and
 * the CI reports nothing"*, *"here is the number and there is no base"*, *"here is the delta"*. The
 * one that matters most is the second: `0.0` or `+0.0 pp` there reads as **"the agent added no
 * coverage"**, a claim about the change rather than about the pipeline (standing rules 16 and 18).
 * Both directions of the delta are asserted, because a renderer that printed the head number, or
 * subtracted the wrong way round, passes any one-sided test (standing rule 42).
 */
const measured = (over: Partial<TaskCoverage> = {}): TaskCoverage => ({
  head_sha: 'b'.repeat(40),
  head_pct: 81.5,
  base_branch: 'main',
  base_sha: 'a'.repeat(40),
  base_pct: 79,
  delta_pct: 2.5,
  measured_at: '2026-06-01T09:00:00.000Z',
  ...over,
});

describe('the coverage delta on the Checks panel', () => {
  it('signs the delta, both ways, in percentage points', () => {
    expect(coverageValueText(measured())).toBe('+2.5 pp');
    expect(coverageValueText(measured({ head_pct: 70, delta_pct: -9 }))).toBe('-9.0 pp');
  });

  it('prints a measured zero as a zero, and says both numbers beneath it', () => {
    expect(coverageValueText(measured({ head_pct: 79, delta_pct: 0 }))).toBe('0.0 pp');
    const line = coverageBasisText(measured({ head_pct: 79, delta_pct: 0 }));
    expect(line).toContain('79.0 %');
    expect(line).toContain('against 79.0 %');
  });

  it('never renders a missing number as zero', () => {
    // The pipeline finished and reported nothing…
    const reportedNothing = measured({
      head_pct: null,
      base_branch: null,
      base_sha: null,
      base_pct: null,
      delta_pct: null,
    });
    expect(coverageValueText(reportedNothing)).toBe('not reported');
    expect(coverageValueText(reportedNothing)).not.toContain('0');
    expect(coverageBasisText(reportedNothing)).toContain('not a change that covers nothing');
    // …and nothing has been measured at all, which is a different sentence again.
    expect(coverageValueText(null)).toBe('not measured');
    expect(coverageBasisText(null)).toContain('coverage source is off');
  });

  it('shows the head number alone when the default branch has none', () => {
    const noBase = measured({ base_pct: null, delta_pct: null });
    expect(coverageValueText(noBase)).toBe('81.5 %');
    expect(coverageBasisText(noBase)).toContain('not a delta');
  });

  it('names the base — the branch, the revision and when it was read', () => {
    /**
     * standing rule 63 on a screen: a delta whose base nobody states is a number a maintainer
     * cannot act on. The revision is printed short, the way git prints one.
     */
    const line = coverageBasisText(measured());
    expect(line).toContain('main');
    expect(line).toContain('aaaaaaa');
    expect(line).not.toContain('a'.repeat(40));
    expect(line).toContain('bbbbbbb');
    // …and the limit of what "coverage delta" means on this build is on the screen rather than in
    // a docblock nobody using the product reads (WP-39 criterion 6).
    expect(line).toContain('per-file coverage needs the CI');
  });
});
