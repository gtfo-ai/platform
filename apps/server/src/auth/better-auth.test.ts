import { describe, expect, it } from 'vitest';
import { sessionCookieName } from './better-auth.js';

describe('sessionCookieName (TD-022)', () => {
  it('uses the __Host- prefix on https, where it is valid', () => {
    expect(sessionCookieName('https://agentic.example.com')).toBe('__Host-session');
  });

  it('drops the prefix on http, where a browser would refuse the cookie', () => {
    // `__Host-` requires `Secure`, and a browser will not store a `Secure` cookie received over
    // plain http — so keeping the prefix there would make login silently impossible in local
    // development and behind a TLS-terminating proxy addressed by its internal name.
    expect(sessionCookieName('http://localhost:8080')).toBe('session');
    expect(sessionCookieName('http://127.0.0.1:3000')).toBe('session');
  });
});

describe('authOptions', () => {
  it('derives its origin the same way the CSRF check does', async () => {
    // `auth/plugin.ts` compares the `Origin` header against `new URL(APP_BASE_URL).origin`. If the
    // two halves normalised differently, a trailing slash would put Better Auth's own origin check
    // and ours on different answers — invisible until a deployment used one.
    const { authOptions } = await import('./better-auth.js');
    const { loadServerConfig } = await import('../config.js');
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'x'.repeat(40),
      APP_BASE_URL: 'https://agentic.example.com/',
    });
    const options = authOptions({ pool: {} as never, config });
    expect(options.baseURL).toBe('https://agentic.example.com');
    expect(options.trustedOrigins).toEqual(['https://agentic.example.com']);
    expect(new URL(config.baseUrl).origin).toBe(options.baseURL);
  });
});
