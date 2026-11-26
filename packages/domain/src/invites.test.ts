import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inviteStateAt } from './invites.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);
const USER = '00000000-0000-4000-8000-0000000000b2';

describe('inviteStateAt', () => {
  it('is pending only while nothing ended it and the expiry is ahead', () => {
    expect(
      inviteStateAt(
        { acceptedAt: null, acceptedUserId: null, revokedAt: null, expiresAt: at(1) },
        NOW,
      ),
    ).toBe('pending');
  });

  it('is expired at the expiry instant itself — the claim asks `expires_at > now()`', () => {
    expect(
      inviteStateAt(
        { acceptedAt: null, acceptedUserId: null, revokedAt: null, expiresAt: at(0) },
        NOW,
      ),
    ).toBe('expired');
    expect(
      inviteStateAt(
        { acceptedAt: null, acceptedUserId: null, revokedAt: null, expiresAt: at(-1) },
        NOW,
      ),
    ).toBe('expired');
  });

  it('keeps an accepted or revoked link so after its expiry passes', () => {
    expect(
      inviteStateAt(
        { acceptedAt: at(-10), acceptedUserId: USER, revokedAt: null, expiresAt: at(-1) },
        NOW,
      ),
    ).toBe('accepted');
    expect(
      inviteStateAt(
        { acceptedAt: null, acceptedUserId: null, revokedAt: at(-10), expiresAt: at(-1) },
        NOW,
      ),
    ).toBe('revoked');
  });

  it('lets a revoke stand over a claim that made no account, and an account win over a revoke', () => {
    // An accept in flight (claimed, no account) is revoked: the revoke stands.
    expect(
      inviteStateAt(
        { acceptedAt: at(-5), acceptedUserId: null, revokedAt: at(-1), expiresAt: at(9) },
        NOW,
      ),
    ).toBe('revoked');
    // A claim with no account and no revoke is spent (in flight, or a crash).
    expect(
      inviteStateAt(
        { acceptedAt: at(-5), acceptedUserId: null, revokedAt: null, expiresAt: at(9) },
        NOW,
      ),
    ).toBe('accepted');
    // The in-flight accept made its account anyway: an account exists.
    expect(
      inviteStateAt(
        { acceptedAt: at(-5), acceptedUserId: USER, revokedAt: at(-1), expiresAt: at(9) },
        NOW,
      ),
    ).toBe('accepted');
  });

  it('answers accepted whenever an account was made, at any instants', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.integer({ min: -1e9, max: 1e9 }),
        (a, e) => {
          expect(
            inviteStateAt(
              { acceptedAt: at(a), acceptedUserId: USER, revokedAt: null, expiresAt: at(e) },
              NOW,
            ),
          ).toBe('accepted');
        },
      ),
    );
  });
});
