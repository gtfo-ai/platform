/**
 * Worker readiness (S-23.24): read off the server's `claim_blockers` / `can_claim` /
 * `last_claimed_at`, never derived from the heartbeat or the pause columns — and the one judgement
 * it adds, `takes`, which lets a *pick only* worker count as ready to work.
 */
import { describe, expect, it } from 'vitest';
import { NOW, workerFixture } from './worker.test-fixture.js';
import { isReadyToWork, workerReadinessOf } from './worker-readiness.js';

const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('workerReadinessOf (the server’s answer, S-22.19)', () => {
  it('can claim when the server says so, with its last claim', () => {
    expect(workerReadinessOf(workerFixture({ last_claimed_at: ago(5 * 60_000) }))).toEqual({
      can_claim: true,
      claim_blockers: [],
      takes: 'automatically',
      last_claimed_at: ago(5 * 60_000),
    });
  });

  it('reports the server’s blockers, not guesses: a worker seen just now with an older build is blocked', () => {
    const readiness = workerReadinessOf(
      workerFixture({
        last_seen_at: ago(1_000),
        claim_blockers: ['images_outdated'],
        can_claim: false,
      }),
    );
    expect(readiness.claim_blockers).toEqual(['images_outdated']);
    expect(readiness.can_claim).toBe(false);
    expect(readiness.takes).toBe('no');
    expect(isReadyToWork(readiness)).toBe(false);
  });

  it('derives nothing from the heartbeat or a pause the server did not name', () => {
    // Long unseen and paused in its columns, but the server names no blocker: it is the server's call.
    const readiness = workerReadinessOf(
      workerFixture({ last_seen_at: null, manually_paused_at: ago(1_000) }),
    );
    expect(readiness.claim_blockers).toEqual([]);
    expect(readiness.takes).toBe('automatically');
  });

  it('orders the blockers in the vocabulary’s order, most fundamental first', () => {
    const readiness = workerReadinessOf(
      workerFixture({ claim_blockers: ['images_outdated', 'offline'], can_claim: false }),
    );
    expect(readiness.claim_blockers).toEqual(['offline', 'images_outdated']);
  });

  it('counts a pick-only worker as ready to work, though it claims nothing by itself', () => {
    const readiness = workerReadinessOf(
      workerFixture({ claim_blockers: ['pick_only'], can_claim: false, claim_projects: [] }),
    );
    expect(readiness.can_claim).toBe(false);
    expect(readiness.takes).toBe('picked_only');
    expect(isReadyToWork(readiness)).toBe(true);
    // Pick only beside a real blocker is not ready.
    const both = workerReadinessOf(
      workerFixture({ claim_blockers: ['offline', 'pick_only'], can_claim: false }),
    );
    expect(both.takes).toBe('no');
  });

  it('never lets a revoked worker claim', () => {
    const readiness = workerReadinessOf(
      workerFixture({
        state: 'revoked',
        revoked_at: ago(1_000),
        claim_blockers: ['revoked'],
        can_claim: false,
      }),
    );
    expect(readiness.can_claim).toBe(false);
    expect(readiness.claim_blockers).toEqual(['revoked']);
  });
});
