/**
 * The device flow's and the worker credential's secrets: drawn here, hashed here, compared here
 * (WP-280, TD-031 decisions 7 and 10c).
 *
 * - A **device code** is 32 random bytes in unpadded base64url (43 characters), the poll's bearer
 *   secret; a **user code** is eight letters drawn by `userCodeFromBytes` (`@platform/domain`).
 * - A **worker credential** is `wkr_<base32 id>_<32 random bytes, base64url>`.
 * - All three are stored as **SHA-256 hex** ({@link hashSecret}): they are high-entropy, so a slow
 *   hash buys nothing (TD-022) — the user code is the exception in entropy (≈ 34 bits), which is
 *   why it is only ever looked up while pending, behind a signed-in session, and dies in ten minutes.
 *
 * Nothing here logs, and no value drawn here is returned except to the one response that hands it
 * over; `workers/secrets.test.ts` holds the shapes.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import {
  formatWorkerCredential,
  normaliseUserCode,
  parseWorkerCredential,
  userCodeFromBytes,
} from '@platform/domain';
import type { CredentialSubject, WorkerStore } from '../queries/worker-queries.js';

/** SHA-256 of a secret's UTF-8 bytes, as lowercase hex — the stored form of every secret here. */
export const hashSecret = (value: string): string =>
  createHash('sha256').update(value, 'utf8').digest('hex');

const random32 = (): string => randomBytes(32).toString('base64url');

/** A fresh code pair. The user code is drawn again in the (rare) case the bytes run out. */
export const mintDeviceCodes = (
  draw: (size: number) => Uint8Array = randomBytes,
): { readonly deviceCode: string; readonly userCode: string } => {
  for (;;) {
    const userCode = userCodeFromBytes(draw(32));
    if (userCode !== null) {
      return { deviceCode: random32(), userCode };
    }
  }
};

/** The stored form of what a person typed, or `null` when it is not a user code. */
export const hashTypedUserCode = (typed: string): string | null => {
  const normalised = normaliseUserCode(typed);
  return normalised === null ? null : hashSecret(normalised);
};

/** A new worker's id and credential; the credential is returned once and stored only hashed. */
export const mintWorkerCredential = (): {
  readonly workerId: string;
  readonly credential: string;
  readonly credentialHash: string;
} => {
  const workerId = randomUUID();
  const credential = formatWorkerCredential(workerId, random32());
  return { workerId, credential, credentialHash: hashSecret(credential) };
};

/**
 * The worker a presented credential authenticates, or `null` — for a malformed value, an unknown
 * id, a wrong secret, a revoked worker and a worker whose user may not act (TD-031 §7: every later
 * call is `401`). The hash comparison is constant-time. The worker protocol's routes (WP-281)
 * authenticate through this; nothing in WP-280 serves a route that does.
 */
export const authenticateWorkerCredential = async (
  store: Pick<WorkerStore, 'findCredentialSubject'>,
  presented: string,
): Promise<CredentialSubject | null> => {
  const parsed = parseWorkerCredential(presented);
  if (parsed === null) {
    return null;
  }
  const subject = await store.findCredentialSubject(parsed.workerId);
  if (subject === null) {
    return null;
  }
  const expected = Buffer.from(subject.credentialHash, 'hex');
  const actual = Buffer.from(hashSecret(presented), 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return null;
  }
  return subject.usable ? subject : null;
};
