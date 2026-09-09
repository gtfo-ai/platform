import { describe, expect, it } from 'vitest';
import { applyClientAddress, CSRF_HEADER_VALUE, csrfViolation } from './plugin.js';

const ORIGIN = 'https://agentic.example.com';
const base = {
  method: 'POST',
  origin: ORIGIN,
  requestedWith: CSRF_HEADER_VALUE,
  hasSessionCookie: true,
  trustedOrigins: [ORIGIN],
} as const;

describe('csrfViolation (TD-022)', () => {
  it('lets a same-origin request from our own SPA through', () => {
    expect(csrfViolation(base)).toBeNull();
  });

  it('refuses a mutation from another origin', () => {
    // The whole attack: a page on evil.example makes the browser attach our SameSite=Lax cookie to
    // a top-level POST. Removing this check makes this test pass a request it must not.
    expect(csrfViolation({ ...base, origin: 'https://evil.example' })).toMatch(/not a trusted/);
  });

  it('refuses a mutation with no Origin at all', () => {
    expect(csrfViolation({ ...base, origin: undefined })).toMatch(/absent/);
  });

  it('refuses a mutation without the custom header', () => {
    // A cross-site form post and an <img> can carry cookies; neither can set a custom header.
    expect(csrfViolation({ ...base, requestedWith: undefined })).toMatch(/x-requested-with/);
    expect(csrfViolation({ ...base, requestedWith: 'something-else' })).toMatch(/x-requested-with/);
  });

  it('lets safe methods through untouched', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get', 'head']) {
      expect(
        csrfViolation({
          ...base,
          method,
          origin: 'https://evil.example',
          requestedWith: undefined,
        }),
      ).toBeNull();
    }
  });

  it('lets a request with no cookie through: there is nothing to ride on', () => {
    // A bearer-token client sets its own Authorization header; the browser attaches nothing, so
    // there is no cross-site *authenticated* request to forge.
    expect(
      csrfViolation({
        ...base,
        hasSessionCookie: false,
        origin: undefined,
        requestedWith: undefined,
      }),
    ).toBeNull();
  });

  it('applies to every unsafe method, not just POST', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      expect(csrfViolation({ ...base, method, origin: 'https://evil.example' })).not.toBeNull();
    }
  });
});

describe('applyClientAddress (APP_TRUST_PROXY)', () => {
  const headersWithForwarding = (): Headers =>
    new Headers({
      'x-forwarded-for': '203.0.113.9',
      'x-real-ip': '203.0.113.9',
      'cf-connecting-ip': '203.0.113.9',
      forwarded: 'for=203.0.113.9',
      cookie: 'session=abc',
    });

  it('overwrites the caller’s forwarding headers when no proxy is trusted', () => {
    // Better Auth reads the client IP from `x-forwarded-for`, keys its login rate limit on it and
    // stores it on the session. Passing the caller's header through gave every sign-in attempt its
    // own rate-limit bucket — twelve failures, no 429 — and wrote an attacker-chosen address into
    // `sessions.ip_address`, which is meant to be evidence.
    const headers = applyClientAddress(headersWithForwarding(), '198.51.100.4', false);
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.4');
    for (const header of ['x-real-ip', 'cf-connecting-ip', 'forwarded']) {
      expect(headers.get(header), header).toBeNull();
    }
    // Everything that is not about the client address is left alone.
    expect(headers.get('cookie')).toBe('session=abc');
  });

  it('still sets the resolved address when a proxy is trusted', () => {
    // With APP_TRUST_PROXY=true, Fastify has already resolved the client address from the
    // forwarding chain; the header is set from that rather than from whatever arrived.
    const headers = applyClientAddress(headersWithForwarding(), '203.0.113.9', true);
    expect(headers.get('x-forwarded-for')).toBe('203.0.113.9');
    expect(headers.get('x-real-ip')).toBe('203.0.113.9');
  });

  it('gives a request with no forwarding header at all a real address', () => {
    // Without this, every login in the instance shared one rate-limit bucket and three failures
    // locked everybody out.
    const headers = applyClientAddress(new Headers(), '198.51.100.4', false);
    expect(headers.get('x-forwarded-for')).toBe('198.51.100.4');
  });
});

describe('trusted origin normalisation', () => {
  it('is an origin, not the configured string', () => {
    // `APP_BASE_URL=http://localhost:8080/` — what an address bar and most copy-pastes produce —
    // matched no `Origin` header ever sent, and 403'd every mutating request in the instance.
    const origin = new URL('http://localhost:8080/').origin;
    expect(origin).toBe('http://localhost:8080');
    expect(
      csrfViolation({ ...base, origin: 'http://localhost:8080', trustedOrigins: [origin] }),
    ).toBeNull();
  });
});
