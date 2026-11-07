/**
 * S-26.4 — what a person's machine takes by itself, the pure half (TD-031's 2026-11-06 amendment
 * items 6–7). The matrix is restated **by hand** from the amendment, cell by cell; the SQL spelling
 * is held to the same cells against PostgreSQL by
 * `test/integration/pipeline/claim-policy.integration.test.ts`.
 */
import { WORKER_CLAIM_POLICIES, type WorkerClaimPolicy } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  claimPolicyTakes,
  effectiveClaimPolicy,
  mayHoldHeadStart,
  NEW_WORKER_CLAIM_POLICY,
  projectListOf,
  projectListTakes,
} from './claim-policy.js';

const A = '00000000-0000-4000-8000-0000000264a1';
const B = '00000000-0000-4000-8000-0000000264b1';

describe('effectiveClaimPolicy: what a row reads as (TD-031 amendment item 6)', () => {
  it('reads a null policy as pick_only over the legacy [] and as everything otherwise', () => {
    expect(effectiveClaimPolicy(null, [])).toBe('pick_only');
    expect(effectiveClaimPolicy(null, null)).toBe('everything');
    expect(effectiveClaimPolicy(null, [A])).toBe('everything');
  });

  it('answers a stored policy as stored, whatever the scope', () => {
    for (const policy of WORKER_CLAIM_POLICIES) {
      for (const scope of [null, [], [A]]) {
        expect(effectiveClaimPolicy(policy, scope)).toBe(policy);
      }
    }
  });

  it('writes a new worker as mine_and_unassigned', () => {
    expect(NEW_WORKER_CLAIM_POLICY).toBe('mine_and_unassigned');
  });
});

describe('the project list: a legacy [] narrows nothing (TD-031 amendment item 6)', () => {
  it('reads [] as every project, and a list as those', () => {
    expect(projectListOf([])).toBeNull();
    expect(projectListOf(null)).toBeNull();
    expect(projectListOf([A])).toEqual([A]);
    expect(projectListTakes([], B)).toBe(true);
    expect(projectListTakes(null, B)).toBe(true);
    expect(projectListTakes([A], A)).toBe(true);
    expect(projectListTakes([A], B)).toBe(false);
  });
});

describe('claimPolicyTakes: the policy × offer matrix (TD-031 amendment item 6)', () => {
  /** The cells, by hand: [policy, mine, unassigned, takes]. */
  const CELLS: readonly (readonly [WorkerClaimPolicy, boolean, boolean, boolean])[] = [
    ['everything', true, false, true],
    ['everything', false, true, true],
    ['everything', false, false, true],
    ['mine_and_unassigned', true, false, true],
    ['mine_and_unassigned', false, true, true],
    ['mine_and_unassigned', false, false, false],
    ['mine', true, false, true],
    ['mine', false, true, false],
    ['mine', false, false, false],
    ['pick_only', true, false, false],
    ['pick_only', false, true, false],
    ['pick_only', false, false, false],
  ];

  it.each(CELLS)('%s, mine %s, unassigned %s → %s', (policy, mine, unassigned, takes) => {
    expect(claimPolicyTakes(policy, { mine, unassigned })).toBe(takes);
  });

  it('covers every policy', () => {
    expect(new Set(CELLS.map(([policy]) => policy))).toEqual(new Set(WORKER_CLAIM_POLICIES));
  });
});

describe('mayHoldHeadStart: the owner’s machine qualifies (TD-031 §8 as amended)', () => {
  it('only when its policy claims by itself and its list takes the project', () => {
    expect(mayHoldHeadStart('pick_only', null, A)).toBe(false);
    expect(mayHoldHeadStart('mine', [B], A)).toBe(false);
    expect(mayHoldHeadStart('mine', [A], A)).toBe(true);
    expect(mayHoldHeadStart('mine_and_unassigned', null, A)).toBe(true);
    expect(mayHoldHeadStart('everything', [], A)).toBe(true);
    // A legacy row: null policy over [] reads pick_only, and holds nothing.
    expect(mayHoldHeadStart(effectiveClaimPolicy(null, []), [], A)).toBe(false);
  });
});
