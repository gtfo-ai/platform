/**
 * The two pieces of the wizard's command surface that are decisions rather than plumbing (WP-21).
 *
 * The routes themselves need a database, so their behaviour is asserted on the integration tier
 * (`test/integration/server/onboarding.integration.test.ts`) and end to end
 * (`test/e2e/onboarding/wizard.e2e.test.ts`); their **auth** is asserted per route by
 * `client-census.test.ts`, which probes the real router. What is left here is what a pure function
 * can be held to:
 *
 *  - the `Idempotency-Key` guard, which is the one place a client-chosen string reaches a stored
 *    audit row. It lives in `./idempotency.ts` since WP-15i, which gave it eleven more callers;
 *    this file is still where its decisions are driven directly;
 *  - `configHashOf`, which two endpoints have to agree about — `GET …/config` publishes it and
 *    `PUT …/config` compares `base_hash` against it — so a hash that moved for a reason other than
 *    the document moving would tell an operator their configuration had changed when it had not.
 */

import type { FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import { HttpError } from '../errors.js';
import {
  assertIdempotentRequest,
  configHashOf,
  MAX_IDEMPOTENCY_KEY_CHARS,
  requireIdempotencyKey,
} from './idempotency.js';

const request = (value: string | string[] | undefined): FastifyRequest =>
  ({ headers: value === undefined ? {} : { 'idempotency-key': value } }) as FastifyRequest;

describe('the Idempotency-Key guard', () => {
  it('returns the key a client sent', () => {
    expect(requireIdempotencyKey(request('wizard-step-1.attempt-2'))).toBe(
      'wizard-step-1.attempt-2',
    );
  });

  it('refuses a request with no key, because an optional header is one production omits', () => {
    try {
      requireIdempotencyKey(request(undefined));
      expect.unreachable('a creating command must require the header');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(400);
      expect((error as HttpError).code).toBe('idempotency_key_required');
    }
  });

  it('refuses an empty key, which is not a key (standing rule 18)', () => {
    expect(() => requireIdempotencyKey(request(''))).toThrow(HttpError);
  });

  it('bounds the key and fixes its character set rather than escaping it', () => {
    // Both sides of the bound (rule 42): exactly at the cap is accepted, one past it is not.
    const exact = 'a'.repeat(MAX_IDEMPOTENCY_KEY_CHARS);
    expect(requireIdempotencyKey(request(exact))).toBe(exact);
    expect(() => requireIdempotencyKey(request(`${exact}a`))).toThrow(HttpError);
    // A key is an identity, so anything outside the set is refused and never rewritten — rewriting
    // would answer one client's call with another's key (the argument `idempotencyScopeFor` makes).
    for (const hostile of ['key with spaces', 'key/../..', 'key\nsecond', 'key%00', '🙂']) {
      expect(() => requireIdempotencyKey(request(hostile)), hostile).toThrow(HttpError);
    }
  });

  it('takes the first of a repeated header rather than joining them', () => {
    expect(requireIdempotencyKey(request(['first', 'second']))).toBe('first');
  });
});

describe('configHashOf', () => {
  it('is stable across key order, so a round trip does not look like a change', () => {
    expect(configHashOf({ version: 1, policies: { autonomy: 'supervised' } })).toBe(
      configHashOf({ policies: { autonomy: 'supervised' }, version: 1 }),
    );
  });

  it('moves when the document moves', () => {
    // The other direction (rule 10): a hash that was constant would pass the case above.
    expect(configHashOf({ version: 1, policies: { autonomy: 'supervised' } })).not.toBe(
      configHashOf({ version: 1, policies: { autonomy: 'autonomous' } }),
    );
  });

  it('keeps array order, because a command policy is a list and not a set', () => {
    expect(configHashOf({ commands: { allow: ['a', 'b'] } })).not.toBe(
      configHashOf({ commands: { allow: ['b', 'a'] } }),
    );
  });

  it('tells an absent key from a null one', () => {
    expect(configHashOf({ version: 1 })).not.toBe(configHashOf({ version: 1, policies: null }));
  });

  it('is a short hex digest, which is what the DTO publishes', () => {
    expect(configHashOf({ version: 1 })).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('assertIdempotentRequest', () => {
  const request = { action: 'project.create', key: 'wizard-1' };

  it('passes a key nobody has used', () => {
    expect(() =>
      assertIdempotentRequest({ ...request, previousDigest: null, digest: 'a' }),
    ).not.toThrow();
  });

  it('passes a genuine retry — the same key with the same request', () => {
    expect(() =>
      assertIdempotentRequest({ ...request, previousDigest: 'a', digest: 'a' }),
    ).not.toThrow();
  });

  it('refuses a different request under a used key, with a code a client can branch on', () => {
    // The half a unique key cannot see: `projects.key` is unchanged and only `name` moved, so the
    // create would find the row and answer 200 as if the second request had been honoured.
    try {
      assertIdempotentRequest({ ...request, previousDigest: 'a', digest: 'b' });
      expect.unreachable('a reused key with a different request must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).statusCode).toBe(409);
      expect((error as HttpError).code).toBe('idempotency_key_reused');
      expect((error as HttpError).message).toContain('wizard-1');
    }
  });

  it('passes a row written before the digest existed rather than refusing it', () => {
    // `human_actions` is append-only, so rows from an older build carry no digest. Refusing them
    // would break a retry of a command that already succeeded; there is nothing to compare to.
    expect(() =>
      assertIdempotentRequest({ ...request, previousDigest: null, digest: 'b' }),
    ).not.toThrow();
  });
});
