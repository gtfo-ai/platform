import { WORKER_USER_CODE_ALPHABET, workerUserCodeSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  checkDeviceDecision,
  DEVICE_CODE_STALE_AFTER_MS,
  DEVICE_CODE_TTL_SECONDS,
  DEVICE_MAX_INTERVAL_SECONDS,
  DEVICE_POLL_INTERVAL_SECONDS,
  type DeviceCodeState,
  decideDevicePoll,
  deviceCodeLimitExceeded,
  isDeviceCodeStale,
  MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS,
  MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE,
  normaliseUserCode,
  repeatedDeviceDecision,
  userCodeFromBytes,
} from './device-flow.js';

const T0 = Date.UTC(2026, 10, 4, 12, 0, 0);

const pending = (overrides: Partial<DeviceCodeState> = {}): DeviceCodeState => ({
  createdAt: T0,
  expiresAt: T0 + DEVICE_CODE_TTL_SECONDS * 1000,
  intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS,
  lastPolledAt: null,
  approvedAt: null,
  deniedAt: null,
  consumedAt: null,
  ...overrides,
});

describe('the user code alphabet', () => {
  it('is twenty consonants with no vowel and no confusable digit pair', () => {
    expect(WORKER_USER_CODE_ALPHABET).toHaveLength(20);
    expect(new Set(WORKER_USER_CODE_ALPHABET).size).toBe(20);
    expect(WORKER_USER_CODE_ALPHABET).not.toMatch(/[AEIOUY01]/);
  });

  it('draws XXXX-XXXX over the alphabet from any bytes that suffice, and the contract accepts it', () => {
    fc.assert(
      fc.property(fc.uint8Array({ minLength: 0, maxLength: 64 }), (bytes) => {
        const code = userCodeFromBytes(bytes);
        const usable = [...bytes].filter((byte) => byte < 240).length;
        if (usable < 8) {
          expect(code).toBeNull();
          return;
        }
        expect(code).not.toBeNull();
        expect(workerUserCodeSchema.safeParse(code).success).toBe(true);
      }),
    );
  });

  it('rejects a byte at or above 240 rather than reducing it, so every letter is equally likely', () => {
    // 239 is the last accepted byte (239 % 20 = 19, the last letter); 240 would be the first
    // letter again under a plain modulo and is discarded instead.
    expect(userCodeFromBytes(new Uint8Array([240, 255, 0, 1, 2, 3, 4, 5, 6, 239]))).toBe(
      `${WORKER_USER_CODE_ALPHABET.slice(0, 4)}-${WORKER_USER_CODE_ALPHABET.slice(4, 7)}${WORKER_USER_CODE_ALPHABET[19]}`,
    );
    // Every accepted byte value maps to each letter exactly twelve times.
    const counts = new Map<string, number>();
    for (let byte = 0; byte < 240; byte += 1) {
      const letter = userCodeFromBytes(new Uint8Array(8).fill(byte))?.[0] ?? '';
      counts.set(letter, (counts.get(letter) ?? 0) + 1);
    }
    expect([...counts.values()]).toEqual(new Array(20).fill(12));
    expect(userCodeFromBytes(new Uint8Array(8).fill(240))).toBeNull();
  });
});

describe('normaliseUserCode', () => {
  it('accepts what a person types: case, spaces and hyphens are not part of the code', () => {
    expect(normaliseUserCode('bcdf-ghjk')).toBe('BCDF-GHJK');
    expect(normaliseUserCode(' BCDF GHJK ')).toBe('BCDF-GHJK');
    expect(normaliseUserCode('BCDFGHJK')).toBe('BCDF-GHJK');
  });

  it('refuses a vowel, a digit, a wrong length and an over-long input', () => {
    expect(normaliseUserCode('BCDF-GHJA')).toBeNull();
    expect(normaliseUserCode('BCDF-GHJ1')).toBeNull();
    expect(normaliseUserCode('BCDF-GHJ')).toBeNull();
    expect(normaliseUserCode('BCDF-GHJKL')).toBeNull();
    expect(normaliseUserCode(`BCDF-GHJK${' '.repeat(40)}`)).toBeNull();
  });
});

describe('decideDevicePoll — expiry and the one-time credential', () => {
  it('is pending inside the ten minutes and expired_token at the boundary and after', () => {
    const code = pending();
    expect(decideDevicePoll(code, T0 + 1)).toEqual({ outcome: 'authorization_pending' });
    expect(decideDevicePoll(code, code.expiresAt - 1)).toEqual({
      outcome: 'authorization_pending',
    });
    expect(decideDevicePoll(code, code.expiresAt)).toEqual({ outcome: 'expired_token' });
    expect(decideDevicePoll(code, code.expiresAt + 60_000)).toEqual({ outcome: 'expired_token' });
  });

  it('issues an approved code once: a consumed code answers expired_token', () => {
    const approved = pending({ approvedAt: T0 + 10_000 });
    expect(decideDevicePoll(approved, T0 + 20_000)).toEqual({ outcome: 'issue' });
    expect(decideDevicePoll({ ...approved, consumedAt: T0 + 20_000 }, T0 + 30_000)).toEqual({
      outcome: 'expired_token',
    });
  });

  it('answers access_denied for a denied code, and an approval that expires is not issued', () => {
    expect(decideDevicePoll(pending({ deniedAt: T0 + 1 }), T0 + 10_000)).toEqual({
      outcome: 'access_denied',
    });
    const approved = pending({ approvedAt: T0 + 1 });
    expect(decideDevicePoll(approved, approved.expiresAt)).toEqual({ outcome: 'expired_token' });
  });
});

describe('decideDevicePoll — slow_down', () => {
  it('slows a poll sooner than the interval, from both sides of the boundary', () => {
    const code = pending({ lastPolledAt: T0 + 1_000 });
    expect(decideDevicePoll(code, T0 + 1_000 + 4_999)).toEqual({
      outcome: 'slow_down',
      intervalSeconds: DEVICE_POLL_INTERVAL_SECONDS + 5,
    });
    expect(decideDevicePoll(code, T0 + 1_000 + 5_000)).toEqual({
      outcome: 'authorization_pending',
    });
  });

  it('honours the grown interval, and caps it', () => {
    const slowed = pending({ lastPolledAt: T0, intervalSeconds: 10 });
    expect(decideDevicePoll(slowed, T0 + 9_000).outcome).toBe('slow_down');
    expect(decideDevicePoll(slowed, T0 + 10_000).outcome).toBe('authorization_pending');
    expect(
      decideDevicePoll(
        pending({ lastPolledAt: T0, intervalSeconds: DEVICE_MAX_INTERVAL_SECONDS }),
        T0 + 1,
      ),
    ).toEqual({ outcome: 'slow_down', intervalSeconds: DEVICE_MAX_INTERVAL_SECONDS });
  });

  it('slows an approved code polled too fast rather than issuing it', () => {
    expect(
      decideDevicePoll(pending({ approvedAt: T0, lastPolledAt: T0 + 1_000 }), T0 + 2_000).outcome,
    ).toBe('slow_down');
  });
});

describe('checkDeviceDecision — the second confirmation and the decided code', () => {
  it('needs a confirmation to approve a code strictly older than five minutes', () => {
    const code = pending();
    const atFive = T0 + DEVICE_CODE_STALE_AFTER_MS;
    expect(isDeviceCodeStale(code, atFive)).toBe(false);
    expect(isDeviceCodeStale(code, atFive + 1)).toBe(true);
    expect(checkDeviceDecision(code, atFive, 'approve', false)).toBe('ok');
    expect(checkDeviceDecision(code, atFive + 1, 'approve', false)).toBe('needs_confirmation');
    expect(checkDeviceDecision(code, atFive + 1, 'approve', true)).toBe('ok');
    // Denying a stale code needs nothing.
    expect(checkDeviceDecision(code, atFive + 1, 'deny', false)).toBe('ok');
  });

  it('refuses an expired code and one already decided or consumed', () => {
    const code = pending();
    expect(checkDeviceDecision(code, code.expiresAt, 'approve', true)).toBe('expired');
    expect(checkDeviceDecision(pending({ approvedAt: T0 }), T0 + 1, 'deny', false)).toBe(
      'already_decided',
    );
    expect(checkDeviceDecision(pending({ deniedAt: T0 }), T0 + 1, 'approve', false)).toBe(
      'already_decided',
    );
    expect(
      checkDeviceDecision(pending({ approvedAt: T0, consumedAt: T0 }), T0 + 1, 'approve', false),
    ).toBe('already_decided');
  });
});

describe('deviceCodeLimitExceeded', () => {
  it('admits the twentieth code for an address and the two hundredth for the instance, and refuses the next', () => {
    expect(deviceCodeLimitExceeded(MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS - 1, 0)).toBeNull();
    expect(deviceCodeLimitExceeded(MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS, 0)).toBe('address');
    expect(deviceCodeLimitExceeded(0, MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE - 1)).toBeNull();
    expect(deviceCodeLimitExceeded(0, MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE)).toBe('instance');
    expect(MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS).toBe(20);
    expect(MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE).toBe(200);
  });
});

describe('repeatedDeviceDecision — a retried decision (WP-280 review)', () => {
  const approved = {
    approvedAt: T0 + 1_000,
    approvedBy: 'alice',
    workerName: 'alice-laptop',
    deniedAt: null,
    deniedBy: null,
  };

  it('answers the recorded instant for the same person, decision and name', () => {
    expect(
      repeatedDeviceDecision(approved, {
        decision: 'approve',
        actorUserId: 'alice',
        name: 'alice-laptop',
      }),
    ).toBe(T0 + 1_000);
    const denied = {
      ...approved,
      approvedAt: null,
      approvedBy: null,
      workerName: null,
      deniedAt: T0,
      deniedBy: 'alice',
    };
    expect(
      repeatedDeviceDecision(denied, { decision: 'deny', actorUserId: 'alice', name: null }),
    ).toBe(T0);
  });

  it('is no repeat for another person, another name, the other decision or an undecided code', () => {
    expect(
      repeatedDeviceDecision(approved, {
        decision: 'approve',
        actorUserId: 'bob',
        name: 'alice-laptop',
      }),
    ).toBeNull();
    expect(
      repeatedDeviceDecision(approved, {
        decision: 'approve',
        actorUserId: 'alice',
        name: 'other',
      }),
    ).toBeNull();
    expect(
      repeatedDeviceDecision(approved, { decision: 'deny', actorUserId: 'alice', name: null }),
    ).toBeNull();
    expect(
      repeatedDeviceDecision(
        { approvedAt: null, approvedBy: null, workerName: null, deniedAt: null, deniedBy: null },
        { decision: 'approve', actorUserId: 'alice', name: 'alice-laptop' },
      ),
    ).toBeNull();
  });
});
