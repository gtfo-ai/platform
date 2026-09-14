/**
 * The coverage delta's arithmetic and its default (WP-39).
 *
 * Two things are asserted here and neither is obvious from reading the function. First, **both
 * directions** (standing rule 42): a change that raises coverage shows a positive delta and one
 * that lowers it a negative one — a renderer that always printed the head number, or a subtraction
 * written the wrong way round, passes any one-sided test. Second, **a missing number is missing**
 * (standing rule 16): every combination with a `null` on either side answers `null` rather than the
 * other side's number or a zero, because `+0.0 pp` on a merge-readiness panel reads as *"the agent
 * added no coverage"* and is the one wrong sentence this feature must not print.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import { coverageDeltaPoints, coverageSourceOf, DEFAULT_COVERAGE_SOURCE } from './coverage.js';

describe('the coverage delta, in percentage points', () => {
  it('is positive when the change raises coverage and negative when it lowers it', () => {
    expect(coverageDeltaPoints(81.5, 79)).toBe(2.5);
    expect(coverageDeltaPoints(70, 79)).toBe(-9);
  });

  it('is zero when nothing moved, which is not the same as no number at all', () => {
    expect(coverageDeltaPoints(79, 79)).toBe(0);
    // …and never `-0`, which JSON serialises as `-0` and a panel would render as a loss.
    expect(Object.is(coverageDeltaPoints(79, 79), -0)).toBe(false);
  });

  it('answers null whenever either side is missing, and never substitutes the other', () => {
    expect(coverageDeltaPoints(null, 79)).toBeNull();
    expect(coverageDeltaPoints(81.5, null)).toBeNull();
    expect(coverageDeltaPoints(null, null)).toBeNull();
    // The zero cases both ways, because zero coverage is a **number** and must subtract normally.
    expect(coverageDeltaPoints(0, 79)).toBe(-79);
    expect(coverageDeltaPoints(79, 0)).toBe(79);
  });

  it('rounds to two decimals, so a double’s tail never reaches the panel', () => {
    // 81.4 - 79.1 is 2.3000000000000114 in IEEE-754 doubles; measured, not assumed.
    expect(81.4 - 79.1).not.toBe(2.3);
    expect(coverageDeltaPoints(81.4, 79.1)).toBe(2.3);
    expect(coverageDeltaPoints(0.1, 0.2)).toBe(-0.1);
  });

  it(
    'over arbitrary pairs: the sign follows the comparison and the magnitude stays in range',
    () => {
      const pct = fc.double({ min: 0, max: 100, noNaN: true });
      fc.assert(
        fc.property(pct, pct, (head, base) => {
          const delta = coverageDeltaPoints(head, base);
          expect(delta).not.toBeNull();
          const points = delta as number;
          expect(points).toBeGreaterThanOrEqual(-100);
          expect(points).toBeLessThanOrEqual(100);
          // The sign is the comparison's, up to the rounding the panel is shown at: two values
          // within half a hundredth of each other may round to zero, and that is the only case in
          // which a strict inequality does not carry through.
          if (Math.abs(head - base) >= 0.01) {
            expect(Math.sign(points)).toBe(Math.sign(head - base));
          }
          expect(Math.abs(points - (head - base))).toBeLessThanOrEqual(0.005);
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('the coverage source', () => {
  it('defaults to product/18:38’s "on when available" when a project says nothing', () => {
    expect(coverageSourceOf(undefined)).toBe('pipeline');
    expect(coverageSourceOf({})).toBe('pipeline');
    expect(DEFAULT_COVERAGE_SOURCE).toBe('pipeline');
  });

  it('takes the project’s own answer, including the one that turns it off', () => {
    expect(coverageSourceOf({ coverage_source: 'none' })).toBe('none');
    expect(coverageSourceOf({ coverage_source: 'pipeline' })).toBe('pipeline');
  });
});
