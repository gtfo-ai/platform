import type { Size } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  estimateAccuracy,
  estimateTaskCostUsd,
  SIZE_COST_WEIGHTS,
  type TaskCostSample,
} from './estimate.js';

const sample = (size: Size, costUsd: number): TaskCostSample => ({ size, costUsd });

describe('estimateTaskCostUsd (product/09 "size × project history", Q65)', () => {
  it('is the plain mean when every sample is this size', () => {
    const estimate = estimateTaskCostUsd('M', {
      project: [sample('M', 10), sample('M', 20)],
      org: [],
    });
    expect(estimate).toEqual({ usd: 15, basis: 'project_history', samples: 2 });
  });

  it('scales history of other sizes by the size weights', () => {
    // One M at 20 USD is 10 USD per unit; an XL is eight units.
    const estimate = estimateTaskCostUsd('XL', { project: [sample('M', 20)], org: [] });
    expect(estimate.usd).toBe(80);
    expect(estimate.basis).toBe('project_history');
  });

  it('falls back to the organisation when the project has no finished task', () => {
    const estimate = estimateTaskCostUsd('S', {
      project: [],
      org: [sample('L', 40)],
    });
    expect(estimate).toEqual({ usd: 10, basis: 'org_history', samples: 1 });
  });

  it('refuses to invent a number when there is no history anywhere (standing rule 16)', () => {
    expect(estimateTaskCostUsd('L', { project: [], org: [] })).toEqual({
      usd: null,
      basis: 'unknown',
      samples: 0,
    });
  });

  it('ignores samples that teach nothing — zero, negative and non-finite spend', () => {
    expect(
      estimateTaskCostUsd('M', {
        project: [sample('M', 0), sample('M', -5), sample('M', Number.NaN)],
        org: [sample('M', 6)],
      }),
    ).toEqual({ usd: 6, basis: 'org_history', samples: 1 });
  });

  it(
    'is monotone in size and never negative',
    () => {
      const sizes: readonly Size[] = ['S', 'M', 'L', 'XL'];
      fc.assert(
        fc.property(
          fc.array(
            fc.tuple(fc.constantFrom(...sizes), fc.double({ min: 0.01, max: 500, noNaN: true })),
            { minLength: 1, maxLength: 8 },
          ),
          (rows) => {
            const project = rows.map(([size, cost]) => sample(size, cost));
            const estimates = sizes.map((size) => estimateTaskCostUsd(size, { project, org: [] }));
            for (const estimate of estimates) {
              expect(estimate.usd).not.toBeNull();
              expect(estimate.usd as number).toBeGreaterThanOrEqual(0);
            }
            for (let index = 1; index < estimates.length; index += 1) {
              expect(estimates[index]?.usd as number).toBeGreaterThanOrEqual(
                estimates[index - 1]?.usd as number,
              );
            }
          },
        ),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('weights every size positively, which the division depends on', () => {
    for (const weight of Object.values(SIZE_COST_WEIGHTS)) {
      expect(weight).toBeGreaterThan(0);
    }
  });
});

describe('estimateAccuracy (product/09 "estimate accuracy is tracked")', () => {
  it('is the ratio of actual to estimate', () => {
    expect(estimateAccuracy(10, 20)).toBe(2);
    expect(estimateAccuracy(10, 5)).toBe(0.5);
  });

  it('has no answer when either side is missing or the estimate was zero', () => {
    expect(estimateAccuracy(null, 20)).toBeNull();
    expect(estimateAccuracy(10, null)).toBeNull();
    expect(estimateAccuracy(0, 20)).toBeNull();
    expect(estimateAccuracy(Number.NaN, 20)).toBeNull();
  });
});
