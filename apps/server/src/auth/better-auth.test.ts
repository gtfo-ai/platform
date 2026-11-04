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

describe('the first-sign-in hook (WP-291)', () => {
  const build = async (onSessionCreated?: (userId: string) => Promise<void>) => {
    const { authOptions } = await import('./better-auth.js');
    const { loadServerConfig } = await import('../config.js');
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'x'.repeat(40),
      APP_BASE_URL: 'http://localhost:8080',
    });
    return authOptions({
      pool: {} as never,
      config,
      ...(onSessionCreated === undefined ? {} : { onSessionCreated }),
    });
  };
  type After = (session: unknown, context: unknown) => Promise<void>;

  it('tells onSessionCreated about every session it creates, by user id', async () => {
    const seen: string[] = [];
    const options = await build(async (userId) => {
      seen.push(userId);
    });
    const after = options.databaseHooks?.session?.create?.after as After | undefined;
    expect(after).toBeDefined();
    await after?.({ userId: '00000000-0000-4000-8000-000000000291' }, null);
    expect(seen).toEqual(['00000000-0000-4000-8000-000000000291']);
  });

  it('declares no database hook at all without it (the bootstrap instance)', async () => {
    const options = await build();
    expect('databaseHooks' in options).toBe(false);
  });

  it('never rejects when onSessionCreated throws, and reports it', async () => {
    const options = await build(async () => {
      throw new Error('connection terminated');
    });
    const after = options.databaseHooks?.session?.create?.after as After | undefined;
    const reported: unknown[][] = [];
    await expect(
      after?.(
        { userId: '00000000-0000-4000-8000-000000000291' },
        { context: { logger: { error: (...args: unknown[]) => reported.push(args) } } },
      ),
    ).resolves.toBeUndefined();
    expect(reported).toEqual([['onSessionCreated failed', 'Error: connection terminated']]);
    await expect(after?.({ userId: 'x' }, null)).resolves.toBeUndefined();
  });
});

describe('the user-deactivation hook (WP-280, TD-031 §7)', () => {
  const build = async (onUserDeactivated: (userId: string) => Promise<void>) => {
    const { authOptions } = await import('./better-auth.js');
    const { loadServerConfig } = await import('../config.js');
    const config = loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'x'.repeat(40),
      APP_BASE_URL: 'http://localhost:8080',
    });
    return authOptions({ pool: {} as never, config, onUserDeactivated });
  };
  type After = (user: unknown, context: unknown) => Promise<void>;
  const USER = '00000000-0000-4000-8000-000000000280';

  it('is told about a user an update banned or disabled, and about no other update', async () => {
    const seen: string[] = [];
    const options = await build(async (userId) => {
      seen.push(userId);
    });
    // Only this hook: the session hook is absent, and so is its key.
    expect(options.databaseHooks?.session).toBeUndefined();
    const after = options.databaseHooks?.user?.update?.after as After | undefined;
    await after?.({ id: USER, banned: false, status: 'active' }, null);
    await after?.({ id: USER, name: 'renamed' }, null);
    expect(seen).toEqual([]);
    await after?.({ id: USER, banned: true, status: 'active' }, null);
    await after?.({ id: USER, banned: false, status: 'disabled' }, null);
    expect(seen).toEqual([USER, USER]);
  });

  it('never fails the update when the hook throws, and reports it', async () => {
    const options = await build(async () => {
      throw new Error('connection terminated');
    });
    const after = options.databaseHooks?.user?.update?.after as After | undefined;
    const reported: unknown[][] = [];
    await expect(
      after?.(
        { id: USER, banned: true },
        { context: { logger: { error: (...args: unknown[]) => reported.push(args) } } },
      ),
    ).resolves.toBeUndefined();
    expect(reported).toEqual([['onUserDeactivated failed', 'Error: connection terminated']]);
  });
});
