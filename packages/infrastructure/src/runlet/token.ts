/**
 * The run token: what makes the control connection *authenticated* (TD-025 §1).
 *
 * Standing rule 18 — **an empty credential is not a credential**. WP-08's webhook verifier accepted
 * `HMAC-SHA256('', body)` because an unset secret produced an empty string rather than a refusal;
 * the same shape here would be worse, because the thing behind this door spawns processes. So an
 * absent, empty, blank or too-short token is refused at *construction*: a shim can never end up
 * listening with a token that matches whatever an attacker sends, because it never starts.
 *
 * Comparison is timing-safe over SHA-256 digests rather than over the raw strings, which is what
 * makes it constant-time for inputs of *different lengths* — `timingSafeEqual` throws on a length
 * mismatch, and catching that throw is itself the length oracle.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

/** Short enough to type, long enough that guessing is not a strategy. The launcher mints 32 hex. */
export const MIN_RUN_TOKEN_LENGTH = 24;

export class RunletTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RunletTokenError';
  }
}

/** Returns the token, or throws. Never returns a token that would accept an empty `hello`. */
export const validateRunToken = (token: unknown): string => {
  if (typeof token !== 'string') {
    throw new RunletTokenError('the run token is missing');
  }
  if (token.trim().length === 0) {
    throw new RunletTokenError('the run token is empty or blank');
  }
  if (token.length < MIN_RUN_TOKEN_LENGTH) {
    throw new RunletTokenError(`the run token is shorter than ${MIN_RUN_TOKEN_LENGTH} characters`);
  }
  return token;
};

const digest = (value: string): Buffer => createHash('sha256').update(value, 'utf8').digest();

/** Constant-time comparison. `presented` is untrusted and may be any string, including empty. */
export const tokensMatch = (expected: string, presented: unknown): boolean => {
  if (typeof presented !== 'string' || presented.length === 0) {
    return false;
  }
  return timingSafeEqual(digest(expected), digest(presented));
};
