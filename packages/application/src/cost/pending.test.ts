/**
 * The arithmetic and the words of `./pending.ts` — the hold of WP-131 (PROGRESS backlog 402).
 *
 * The derivation of each number is the stores' (the SQL in the integration tier, `holdOf` in the
 * in-memory doubles); what is here is the comparison every cap makes and the sentence a pause
 * carries, with the hold kept apart from the spend (standing rule 16).
 */
import type { Slug } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { capIsSpent, capSpendDetail, holdDetail, holdOf, NO_HOLD } from './pending.js';

const STAGE = 'implementation' as Slug;

describe('the hold of a run nobody measured (WP-131)', () => {
  it('holds each run at its own reservation, and one that recorded none at the admitting reserve', () => {
    expect(holdOf([15, null], 10)).toEqual({ heldUsd: 25, heldRuns: 2 });
    expect(holdOf([], 10)).toEqual(NO_HOLD);
  });

  /**
   * Criterion (2)'s figures on the comparison the shadow, maintenance and bootstrap caps share: a cap
   * of 20, one run held at 15, a 10 USD admission. Both directions (standing rule 42): the hold
   * refuses it, and the same admission with the hold at 0 is admitted.
   */
  it('refuses a 10 USD admission to a cap of 20 holding 15, and admits it with nothing held', () => {
    const admission = {
      capUsd: 20,
      spentUsd: 0,
      pendingUsd: 0,
      reserveUsd: 10,
    };
    expect(capIsSpent({ ...admission, heldUsd: 15, heldRuns: 1 })).toBe(true);
    expect(capIsSpent({ ...admission, ...NO_HOLD })).toBe(false);
  });

  it('names the hold apart from the spend and the pending reservations', () => {
    expect(
      capSpendDetail(
        {
          capUsd: 20,
          spentUsd: 0.4,
          pendingUsd: 2,
          heldUsd: 30,
          heldRuns: 2,
          reserveUsd: 10,
        },
        STAGE,
      ),
    ).toBe(
      '0.4 spent and 2 committed by runs the ledger has not recorded yet of 20 USD, with 2 runs ' +
        'nobody measured, held at their caps: 30 USD, and "implementation" may spend 10 more',
    );
    // No hold, no clause — the pause a cap with no unmeasured run has always carried.
    expect(
      capSpendDetail({ capUsd: 20, spentUsd: 19, pendingUsd: 0, ...NO_HOLD, reserveUsd: 2 }, STAGE),
    ).toBe('19 spent of 20 USD, and "implementation" may spend 2 more');
    expect(holdDetail(NO_HOLD)).toBe('');
  });
});
