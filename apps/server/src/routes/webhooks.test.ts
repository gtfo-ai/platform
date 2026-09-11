/**
 * The webhook route's two decisions that are not wiring: which status each outcome deserves, and
 * how a repeated header reaches a signature verifier (WP-15c).
 *
 * The route itself — the raw-body parser, the params schema, the unauthenticated path through the
 * auth plugin's CSRF hook — is exercised against a real instance by
 * `test/e2e/pipeline/webhook-ingress.e2e.test.ts`, which is the only place a Fastify content-type
 * parser and a real `POST` can both be present.
 */
import type { InboundDeliveryOutcome, InboundRefusal } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { flattenHeaders, statusFor } from './webhooks.js';

const refused = (reason: InboundRefusal): InboundDeliveryOutcome => ({
  kind: 'refused',
  reason,
  detail: 'because',
});

describe('the status a delivery is answered with', () => {
  it('accepts what it performed and what it had already performed', () => {
    expect(
      statusFor({ kind: 'accepted', deliveryId: 'd', events: 1, ignored: 0, redactionCount: 0 }),
    ).toBe(202);
    expect(statusFor({ kind: 'duplicate', deliveryId: 'd' })).toBe(202);
  });

  /**
   * Standing rule 20 in its sharpest form on this route. A vendor that keeps receiving errors
   * **disables the webhook** — GitLab and Jira both do — and that would take the deliveries that
   * matter with the ones that do not. A `wiki` or `release` hook is authentic and unkeyable, so it
   * is received and performs nothing, which is what `accepted: false` on the body says.
   */
  it('receives an authentic delivery nothing can key, rather than erroring at the vendor', () => {
    expect(statusFor(refused('unkeyable'))).toBe(202);
  });

  it('refuses what an operator or an attacker must be told about', () => {
    // The only credential this endpoint has; a failure here is a forgery or a rotated secret.
    expect(statusFor(refused('unverified'))).toBe(401);
    expect(statusFor(refused('malformed_body'))).toBe(400);
    // A URL that names nothing this build can receive for — the same answer as a wrong id, so a
    // caller cannot tell an existing integration from a missing one by its status code.
    expect(statusFor(refused('provider_mismatch'))).toBe(404);
    expect(statusFor(refused('unsupported_provider'))).toBe(404);
    expect(statusFor({ kind: 'unknown_integration' })).toBe(404);
  });

  it('has an answer for every refusal the ingress can produce', () => {
    // Derived, not remembered (standing rule 7): a new refusal reason with no status fails here
    // rather than reaching a caller as `undefined`.
    const reasons: InboundRefusal[] = [
      'unverified',
      'provider_mismatch',
      'unsupported_provider',
      'malformed_body',
      'unkeyable',
    ];
    for (const reason of reasons) {
      expect(typeof statusFor(refused(reason)), reason).toBe('number');
    }
  });
});

describe('the headers handed to a signature verifier', () => {
  it('lower-cases the names, because every scheme in TD-024 reads them that way', () => {
    expect(flattenHeaders({ 'X-Gitlab-Token': 'abc' })).toEqual({ 'x-gitlab-token': 'abc' });
  });

  it('joins a repeated header instead of handing a verifier an array', () => {
    // `[object Object]` reaching a constant-time comparison is a refusal that looks like a forgery.
    expect(flattenHeaders({ 'x-forwarded-for': ['10.0.0.1', '10.0.0.2'] })).toEqual({
      'x-forwarded-for': '10.0.0.1, 10.0.0.2',
    });
  });

  it('drops an absent header rather than passing `undefined` through as a value', () => {
    expect(
      flattenHeaders({ 'x-gitlab-token': undefined, 'content-type': 'application/json' }),
    ).toEqual({ 'content-type': 'application/json' });
  });
});
