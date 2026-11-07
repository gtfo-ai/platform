/**
 * The worker page's legacy claim-scope vocabulary against the claim policy (S-26.4, the review of
 * PR #98): a save of `[]` is *pick only*, a list while *pick only* leaves it, and a `pick_only`
 * worker reads as `[]` — so the page this build ships is never trapped in *pick only*.
 */
import type { WorkerLocalClaimScope } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { claimScopeReadForPage, claimScopeWriteOfPage } from './page-scope.js';

const A = '00000000-0000-4000-8000-0000000264a1';

describe('a page save, as the core’s protocol-4 PUT reads it', () => {
  it('sends [] with no policy as pick_only over every project — never the [] the core refuses', () => {
    for (const current of [null, 'everything', 'mine', 'pick_only'] as const) {
      expect(claimScopeWriteOfPage([], undefined, current)).toEqual({
        claim_project_ids: null,
        claim_policy: 'pick_only',
      });
    }
  });

  it('leaves pick only for a list, or every project, saved while the policy reads pick_only', () => {
    expect(claimScopeWriteOfPage([A], undefined, 'pick_only')).toEqual({
      claim_project_ids: [A],
      claim_policy: 'mine_and_unassigned',
    });
    expect(claimScopeWriteOfPage(null, undefined, 'pick_only')).toEqual({
      claim_project_ids: null,
      claim_policy: 'mine_and_unassigned',
    });
  });

  it('leaves any other policy as it was, and sends a named policy as it is', () => {
    for (const current of [null, 'everything', 'mine', 'mine_and_unassigned'] as const) {
      expect(claimScopeWriteOfPage([A], undefined, current)).toEqual({ claim_project_ids: [A] });
      expect(claimScopeWriteOfPage(null, undefined, current)).toEqual({ claim_project_ids: null });
    }
    expect(claimScopeWriteOfPage([A], 'everything', 'pick_only')).toEqual({
      claim_project_ids: [A],
      claim_policy: 'everything',
    });
    expect(claimScopeWriteOfPage(null, 'pick_only', 'mine')).toEqual({
      claim_project_ids: null,
      claim_policy: 'pick_only',
    });
  });
});

describe('a page read', () => {
  const answer = (overrides: Partial<WorkerLocalClaimScope>): WorkerLocalClaimScope => ({
    claim_project_ids: null,
    projects: [],
    ...overrides,
  });

  it('answers [] for a worker whose policy reads pick_only, whatever its list', () => {
    expect(claimScopeReadForPage(answer({ claim_policy: 'pick_only' }))).toEqual(
      answer({ claim_policy: 'pick_only', claim_project_ids: [] }),
    );
    expect(
      claimScopeReadForPage(answer({ claim_policy: 'pick_only', claim_project_ids: [A] })),
    ).toMatchObject({ claim_project_ids: [] });
  });

  it('answers every other worker as the core did', () => {
    for (const claim_policy of ['everything', 'mine', 'mine_and_unassigned'] as const) {
      const read = answer({ claim_policy, claim_project_ids: [A] });
      expect(claimScopeReadForPage(read)).toEqual(read);
    }
    // A core before the policy says none: the list is the page's own vocabulary already.
    expect(claimScopeReadForPage(answer({ claim_project_ids: [] }))).toEqual(
      answer({ claim_project_ids: [] }),
    );
  });
});
