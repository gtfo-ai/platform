/**
 * The device flow's rules — TD-031 decision 10c, RFC 8628's shape (research/17 § 7).
 *
 * A worker machine asks for a code pair, its owner approves the short `user_code` on
 * `/workers/approve` while signed in, and the machine's poll collects the worker credential once.
 * Everything here is a pure decision over a code's recorded state and an instant; the randomness,
 * the hashing and the rows are the server's (`apps/server/src/queries/worker-queries.ts`).
 *
 * ## The user code
 *
 * Eight characters of {@link WORKER_USER_CODE_ALPHABET} (20 consonants — RFC 8628 §6.1's example
 * alphabet), shown as `XXXX-XXXX`: 20⁸ ≈ 2.6 × 10¹⁰ codes, of which at most
 * {@link MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE} are pending at once. A character is drawn by
 * **rejection sampling** over random bytes: a byte at or above 240 (the largest multiple of 20 a
 * byte can hold) is discarded rather than reduced, so every letter is equally likely — `byte % 20`
 * over all 256 values would make the first 16 letters 13/256 likely and the last four 12/256.
 *
 * What a person types is normalised before it is compared ({@link normaliseUserCode}): case,
 * spaces and the hyphen are not part of the code, every other character refuses it.
 */
import { WORKER_USER_CODE_ALPHABET } from '@platform/contracts';

/** `expires_in` (TD-031 §10c): a code pair lives ten minutes. */
export const DEVICE_CODE_TTL_SECONDS = 600;
/** `interval` (TD-031 §10c): the poll's starting interval. */
export const DEVICE_POLL_INTERVAL_SECONDS = 5;
/** RFC 8628 §3.5: every `slow_down` adds five seconds to the interval. */
export const DEVICE_SLOW_DOWN_STEP_SECONDS = 5;
/** The interval never grows past this, so a confused client is slowed, not locked out for good. */
export const DEVICE_MAX_INTERVAL_SECONDS = 60;
/** TD-031 §10c: a code older than five minutes needs a second confirmation to approve. */
export const DEVICE_CODE_STALE_AFTER_MS = 5 * 60_000;
/** TD-031 §10c: pending codes per client address before `device` answers `429`. */
export const MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS = 20;
/** TD-031 §10c: pending codes in the whole instance before `device` answers `429`. */
export const MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE = 200;

const USER_CODE_LENGTH = 8;
/** The largest multiple of the alphabet's size a byte can hold; bytes at or above it are rejected. */
const REJECTION_BOUND = 256 - (256 % WORKER_USER_CODE_ALPHABET.length);

/**
 * A user code drawn from random bytes, `XXXX-XXXX`, or `null` when the bytes ran out before eight
 * letters were accepted (the caller draws again). Each byte is used at most once.
 */
export const userCodeFromBytes = (bytes: Uint8Array): string | null => {
  let letters = '';
  for (const byte of bytes) {
    if (letters.length === USER_CODE_LENGTH) {
      break;
    }
    if (byte < REJECTION_BOUND) {
      letters += WORKER_USER_CODE_ALPHABET[byte % WORKER_USER_CODE_ALPHABET.length];
    }
  }
  return letters.length === USER_CODE_LENGTH ? `${letters.slice(0, 4)}-${letters.slice(4)}` : null;
};

/**
 * What a person typed, as the canonical `XXXX-XXXX`, or `null` when it is not a user code.
 * Lower case, spaces and hyphens anywhere are accepted; any other character, or a length other
 * than eight letters, refuses it.
 */
export const normaliseUserCode = (input: string): string | null => {
  if (input.length > 32) {
    return null;
  }
  const letters = input.replaceAll(/[\s-]/g, '').toUpperCase();
  if (letters.length !== USER_CODE_LENGTH) {
    return null;
  }
  for (const letter of letters) {
    if (!WORKER_USER_CODE_ALPHABET.includes(letter)) {
      return null;
    }
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
};

/** A device code's recorded state, as the decisions below read it. Instants are epoch millis. */
export interface DeviceCodeState {
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly intervalSeconds: number;
  readonly lastPolledAt: number | null;
  readonly approvedAt: number | null;
  readonly deniedAt: number | null;
  readonly consumedAt: number | null;
}

/** What one `device/token` poll answers (RFC 8628 §3.5), or `issue` — mint the credential now. */
export type DevicePollDecision =
  | { readonly outcome: 'issue' }
  | { readonly outcome: 'authorization_pending' }
  | { readonly outcome: 'slow_down'; readonly intervalSeconds: number }
  | { readonly outcome: 'access_denied' }
  | { readonly outcome: 'expired_token' };

/**
 * One poll's answer. The order is the decision:
 *
 * 1. a consumed code (its credential was already handed over) and an expired one answer
 *    `expired_token` — the credential is answered **once** (TD-031 §7);
 * 2. a poll sooner than `interval` after the previous one answers `slow_down` and grows the
 *    interval, whatever the code's decision — the one rule that throttles a client;
 * 3. a denied code answers `access_denied`, an approved one is issued, anything else is pending.
 *
 * Every poll that reaches step 2 is recorded as the new `last_polled_at` by the caller, a
 * `slow_down` included, so a client that keeps hammering keeps being slowed.
 */
export const decideDevicePoll = (state: DeviceCodeState, now: number): DevicePollDecision => {
  if (state.consumedAt !== null || now >= state.expiresAt) {
    return { outcome: 'expired_token' };
  }
  if (state.lastPolledAt !== null && now - state.lastPolledAt < state.intervalSeconds * 1000) {
    return {
      outcome: 'slow_down',
      intervalSeconds: Math.min(
        state.intervalSeconds + DEVICE_SLOW_DOWN_STEP_SECONDS,
        DEVICE_MAX_INTERVAL_SECONDS,
      ),
    };
  }
  if (state.deniedAt !== null) {
    return { outcome: 'access_denied' };
  }
  if (state.approvedAt !== null) {
    return { outcome: 'issue' };
  }
  return { outcome: 'authorization_pending' };
};

/** Why a person's decision on a code is refused, or `ok`. */
export type DeviceDecisionCheck = 'ok' | 'expired' | 'already_decided' | 'needs_confirmation';

/**
 * Whether a signed-in person may decide (approve or deny) a code now. A code that is expired, or
 * was already decided, is refused; **approving** a code older than
 * {@link DEVICE_CODE_STALE_AFTER_MS} needs `confirmedStale` (TD-031 §10c's second confirmation —
 * a phisher's code has usually aged by the time a victim types it). Denying never needs it.
 */
export const checkDeviceDecision = (
  state: DeviceCodeState,
  now: number,
  decision: 'approve' | 'deny',
  confirmedStale: boolean,
): DeviceDecisionCheck => {
  if (now >= state.expiresAt) {
    return 'expired';
  }
  if (state.approvedAt !== null || state.deniedAt !== null || state.consumedAt !== null) {
    return 'already_decided';
  }
  if (decision === 'approve' && isDeviceCodeStale(state, now) && !confirmedStale) {
    return 'needs_confirmation';
  }
  return 'ok';
};

/** TD-031 §10c's threshold: strictly older than five minutes. */
export const isDeviceCodeStale = (
  state: Pick<DeviceCodeState, 'createdAt'>,
  now: number,
): boolean => now - state.createdAt > DEVICE_CODE_STALE_AFTER_MS;

/**
 * Which outstanding-code limit a new code would exceed, or `null`. The counts are of **pending**
 * codes — unexpired, neither approved nor denied — before the new one.
 */
export const deviceCodeLimitExceeded = (
  pendingForAddress: number,
  pendingInInstance: number,
): 'address' | 'instance' | null => {
  if (pendingForAddress >= MAX_OUTSTANDING_DEVICE_CODES_PER_ADDRESS) {
    return 'address';
  }
  if (pendingInInstance >= MAX_OUTSTANDING_DEVICE_CODES_PER_INSTANCE) {
    return 'instance';
  }
  return null;
};
