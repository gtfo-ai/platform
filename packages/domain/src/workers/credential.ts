/**
 * The worker credential's spelling — `wkr_<base32 id>_<43 base64url chars>` (TD-031 decision 7).
 *
 * The id half is the worker row's uuid — its 128 bits in lowercase RFC 4648 base32 without padding,
 * 26 characters (the assumption `workerCredentialSchema` states and this module pins). Carrying the
 * id lets the core find the one row whose hash to compare, rather than looking a secret up by its
 * hash across every worker; the secret half is 32 random bytes the server draws. The stored form is
 * the SHA-256 of the **whole** credential (the server's `hashWorkerCredential`).
 *
 * Decoding is strict: 128 bits fill 25 characters and 3 bits of the 26th, so the 26th's two low
 * bits must be zero — otherwise four spellings would name one id, and a credential is an identity.
 */
import { workerCredentialSchema } from '@platform/contracts';

export const WORKER_CREDENTIAL_PREFIX = 'wkr_';

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ID_CHARS = 26;

/** A uuid's 128 bits as 26 lowercase base32 characters. Throws on a value that is not a uuid. */
export const workerIdToBase32 = (uuid: string): string => {
  const lower = uuid.toLowerCase();
  if (!UUID.test(lower)) {
    throw new TypeError('a worker id is a uuid');
  }
  let value = BigInt(`0x${lower.replaceAll('-', '')}`);
  // Two zero bits of padding make 130 bits, 26 groups of five.
  value <<= 2n;
  let out = '';
  for (let index = 0; index < ID_CHARS; index += 1) {
    out = BASE32_ALPHABET[Number(value & 31n)] + out;
    value >>= 5n;
  }
  return out;
};

/** The inverse of {@link workerIdToBase32}, or `null` for anything it would not have produced. */
export const workerIdFromBase32 = (encoded: string): string | null => {
  if (encoded.length !== ID_CHARS) {
    return null;
  }
  let value = 0n;
  for (const character of encoded) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) {
      return null;
    }
    value = (value << 5n) | BigInt(digit);
  }
  if ((value & 3n) !== 0n) {
    return null;
  }
  const hex = (value >> 2n).toString(16).padStart(32, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

/** `wkr_<base32 id>_<secret>`; the secret is 43 unpadded base64url characters (32 bytes). */
export const formatWorkerCredential = (workerId: string, secret: string): string => {
  const credential = `${WORKER_CREDENTIAL_PREFIX}${workerIdToBase32(workerId)}_${secret}`;
  if (!workerCredentialSchema.safeParse(credential).success) {
    throw new TypeError('the secret half of a worker credential is 43 base64url characters');
  }
  return credential;
};

/** The worker id a presented credential names, or `null` when it is not a credential's spelling. */
export const parseWorkerCredential = (presented: string): { readonly workerId: string } | null => {
  if (!workerCredentialSchema.safeParse(presented).success) {
    return null;
  }
  const workerId = workerIdFromBase32(
    presented.slice(WORKER_CREDENTIAL_PREFIX.length, WORKER_CREDENTIAL_PREFIX.length + ID_CHARS),
  );
  return workerId === null ? null : { workerId };
};
