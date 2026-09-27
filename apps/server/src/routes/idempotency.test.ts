/**
 * `claimIdempotentAttempt` — WP-67's claim-before-effect, driven over the in-memory record.
 *
 * Every branch of the ordering the module note decides, both ways (standing rule 42): a first claim
 * runs and a performed key does not; a refusal gives the key back and a completed command keeps it;
 * a held key refuses the second request as in flight and, once stale, as unknown; a different body
 * is `idempotency_key_reused` whether the key performed or is still held. The SQL half of the same
 * semantics is `test/integration/server/command-idempotency.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import { CLAIM_IN_FLIGHT_MS, claimIdempotentAttempt, configHashOf } from './idempotency.js';
import { type MemoryAttempt, memoryAttemptRecords, scopeOf } from './idempotency-memory.js';

const USER = 'user-1';
const ACTION = 'task.feedback';
const NOW = Date.parse('2026-09-27T10:00:00.000Z');

const setup = () => {
  const performed = new Map<string, MemoryAttempt>();
  const records = memoryAttemptRecords(performed, () => new Date(NOW).toISOString());
  const claim = (key: string | null, request: unknown, now = NOW) =>
    claimIdempotentAttempt(records, { userId: USER, action: ACTION, key, request, now: () => now });
  /** What `insertHumanAction` does to the record when the audit row is written. */
  const complete = (key: string, request: unknown, params: Record<string, unknown> = {}) => {
    performed.set(scopeOf({ userId: USER, action: ACTION, key }), {
      bodyDigest: configHashOf(request),
      params: params as never,
    });
  };
  return { performed, records, claim, complete };
};

const codeOf = async (promise: Promise<unknown>): Promise<string> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpError) {
      return `${error.statusCode} ${error.code}`;
    }
    throw error;
  }
  return 'resolved';
};

describe('claimIdempotentAttempt', () => {
  it('claims nothing for a request with no key, and runs it', async () => {
    const { claim, records } = setup();
    const attempt = await claim(null, { a: 1 });
    expect(attempt.replayed).toBe(false);
    expect(attempt.digest).toBeNull();
    expect(await attempt.run(async () => 'ran')).toBe('ran');
    expect(records.inFlight.size).toBe(0);
  });

  it('holds the key while the command runs, and a completed command keeps it', async () => {
    const { claim, complete, records } = setup();
    const attempt = await claim('k1', { a: 1 });
    expect(attempt.replayed).toBe(false);
    await attempt.run(async () => {
      expect(records.inFlight.size, 'held while performing').toBe(1);
      complete('k1', { a: 1 }, { feedback_id: 'f1' });
    });
    expect(records.inFlight.size).toBe(0);
    const replay = await claim('k1', { a: 1 });
    expect(replay.replayed).toBe(true);
    expect(replay.previous).toEqual({ feedback_id: 'f1' });
  });

  it('gives the key back when the command refuses, so the same request is a first attempt again', async () => {
    const { claim } = setup();
    const attempt = await claim('k1', { a: 1 });
    await expect(
      attempt.run(async () => {
        throw new HttpError(409, 'illegal_transition', 'no');
      }),
    ).rejects.toThrow('no');
    const again = await claim('k1', { a: 1 });
    expect(again.replayed).toBe(false);
  });

  it('keeps the key held when anything fails after the effect returned, so a retry never performs again', async () => {
    // WP-67 review round 1: the audit insert refused after the command committed. Releasing here
    // made the retry a first attempt, and the command was performed a second time.
    const { claim, records } = setup();
    const attempt = await claim('k1', { a: 1 });
    await expect(
      attempt.run(async (performed) => {
        performed();
        throw new Error('the audit insert was refused');
      }),
    ).rejects.toThrow('the audit insert was refused');
    expect(records.inFlight.size).toBe(1);
    expect(await codeOf(claim('k1', { a: 1 }))).toBe('409 idempotency_key_in_flight');
    expect(await codeOf(claim('k1', { a: 1 }, NOW + CLAIM_IN_FLIGHT_MS))).toBe(
      '409 idempotency_attempt_unknown',
    );
  });

  it('gives the key back when the command answers without performing', async () => {
    const { claim } = setup();
    await (await claim('k1', { a: 1 })).run(async () => 'already');
    expect((await claim('k1', { a: 1 })).replayed).toBe(false);
  });

  it('refuses a second request while the first holds the key, then as unknown once stale', async () => {
    const { claim } = setup();
    await claim('k1', { a: 1 });
    expect(await codeOf(claim('k1', { a: 1 }))).toBe('409 idempotency_key_in_flight');
    expect(await codeOf(claim('k1', { a: 1 }, NOW + CLAIM_IN_FLIGHT_MS - 1))).toBe(
      '409 idempotency_key_in_flight',
    );
    expect(await codeOf(claim('k1', { a: 1 }, NOW + CLAIM_IN_FLIGHT_MS))).toBe(
      '409 idempotency_attempt_unknown',
    );
  });

  it('refuses a different body under a used key, performed or held', async () => {
    const performedCase = setup();
    performedCase.complete('k1', { a: 1 });
    expect(await codeOf(performedCase.claim('k1', { a: 2 }))).toBe('409 idempotency_key_reused');

    const heldCase = setup();
    await heldCase.claim('k1', { a: 1 });
    expect(await codeOf(heldCase.claim('k1', { a: 2 }))).toBe('409 idempotency_key_reused');
  });

  it('answers a legacy attempt with no digest as a replay rather than refusing it', async () => {
    const { claim, performed } = setup();
    performed.set(scopeOf({ userId: USER, action: ACTION, key: 'k1' }), {
      bodyDigest: null,
      params: {},
    });
    expect((await claim('k1', { a: 2 })).replayed).toBe(true);
  });
});
