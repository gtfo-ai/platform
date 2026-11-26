import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { inviteStateAt } from './invites.js';

const NOW = new Date('2026-11-26T12:00:00.000Z');
const at = (offsetMs: number): Date => new Date(NOW.getTime() + offsetMs);

describe('inviteStateAt', () => {
  it('is pending only while nothing ended it and the expiry is ahead', () => {
    expect(inviteStateAt({ acceptedAt: null, revokedAt: null, expiresAt: at(1) }, NOW)).toBe(
      'pending',
    );
  });

  it('is expired at the expiry instant itself — the claim asks `expires_at > now()`', () => {
    expect(inviteStateAt({ acceptedAt: null, revokedAt: null, expiresAt: at(0) }, NOW)).toBe(
      'expired',
    );
    expect(inviteStateAt({ acceptedAt: null, revokedAt: null, expiresAt: at(-1) }, NOW)).toBe(
      'expired',
    );
  });

  it('keeps an accepted or revoked link so after its expiry passes', () => {
    expect(inviteStateAt({ acceptedAt: at(-10), revokedAt: null, expiresAt: at(-1) }, NOW)).toBe(
      'accepted',
    );
    expect(inviteStateAt({ acceptedAt: null, revokedAt: at(-10), expiresAt: at(-1) }, NOW)).toBe(
      'revoked',
    );
  });

  it('answers accepted whenever accepted_at is set, at any instants', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -1e9, max: 1e9 }),
        fc.integer({ min: -1e9, max: 1e9 }),
        (a, e) => {
          expect(inviteStateAt({ acceptedAt: at(a), revokedAt: null, expiresAt: at(e) }, NOW)).toBe(
            'accepted',
          );
        },
      ),
    );
  });
});
