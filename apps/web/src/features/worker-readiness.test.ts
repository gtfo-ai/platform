/**
 * The worker-readiness stub (S-23.20): what it derives from today's `GET /api/workers` item, and
 * that its words table names every blocker of the vocabulary the server will publish.
 */
import { describe, expect, it } from 'vitest';
import { NOW, workerFixture } from './worker.test-fixture.js';
import {
  isWorkerOnline,
  WORKER_BLOCKER_WORDS,
  WORKER_CLAIM_BLOCKERS,
  WORKER_ONLINE_WITHIN_MS,
  workerReadinessOf,
} from './worker-readiness.js';

const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('workerReadinessOf (the stub of N1)', () => {
  it('can claim when it is online, not paused and not revoked', () => {
    expect(workerReadinessOf(workerFixture(), NOW)).toEqual({
      can_claim: true,
      claim_blockers: [],
      last_claimed_at: null,
    });
  });

  it.each([
    { name: 'never seen', over: { last_seen_at: null }, blockers: ['offline'] },
    {
      name: 'seen just past the minute',
      over: { last_seen_at: ago(WORKER_ONLINE_WITHIN_MS + 1) },
      blockers: ['offline'],
    },
    { name: 'paused by its owner', over: { manually_paused_at: ago(1_000) }, blockers: ['paused'] },
    {
      name: 'held by a usage limit that has not reset',
      over: {
        paused_until: new Date(NOW + 60_000).toISOString(),
        paused_reason: 'usage_limited' as const,
      },
      blockers: ['usage_limited'],
    },
    {
      name: 'offline and paused at once',
      over: { last_seen_at: null, manually_paused_at: ago(1_000) },
      blockers: ['offline', 'paused'],
    },
  ])('is blocked when $name', ({ over, blockers }) => {
    const readiness = workerReadinessOf(workerFixture(over), NOW);
    expect(readiness.claim_blockers).toEqual(blockers);
    expect(readiness.can_claim).toBe(false);
  });

  it('treats the online bound from both sides', () => {
    expect(isWorkerOnline(workerFixture({ last_seen_at: ago(WORKER_ONLINE_WITHIN_MS) }), NOW)).toBe(
      true,
    );
    expect(
      isWorkerOnline(workerFixture({ last_seen_at: ago(WORKER_ONLINE_WITHIN_MS + 1) }), NOW),
    ).toBe(false);
  });

  it('ignores a usage pause that has already reset', () => {
    const readiness = workerReadinessOf(workerFixture({ paused_until: ago(1_000) }), NOW);
    expect(readiness.claim_blockers).toEqual([]);
    expect(readiness.can_claim).toBe(true);
  });

  it('never lets a revoked worker claim, though it names no blocker for it', () => {
    const readiness = workerReadinessOf(
      workerFixture({ state: 'revoked', revoked_at: ago(1_000) }),
      NOW,
    );
    expect(readiness.can_claim).toBe(false);
    expect(readiness.claim_blockers).toEqual([]);
  });
});

describe('WORKER_BLOCKER_WORDS', () => {
  it('says every blocker of the vocabulary in words and with a fix, and no spec word', () => {
    expect(Object.keys(WORKER_BLOCKER_WORDS).sort()).toEqual([...WORKER_CLAIM_BLOCKERS].sort());
    for (const blocker of WORKER_CLAIM_BLOCKERS) {
      const { word, fix } = WORKER_BLOCKER_WORDS[blocker];
      expect(word.length).toBeGreaterThan(0);
      expect(fix.length).toBeGreaterThan(0);
      // The words are a person's, not the vocabulary's identifiers.
      expect(`${word} ${fix}`).not.toMatch(/_|claimant|TD-|BD-|protocol/);
    }
  });
});
