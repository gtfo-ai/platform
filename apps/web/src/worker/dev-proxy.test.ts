import { describe, expect, it } from 'vitest';
import { type ProxyRequestEmitter, proxiedOrigin, workerLocalProxy } from './dev-proxy.js';
import { LOCAL_API_PREFIX } from './read-state.js';

const WORKER = 'http://127.0.0.1:7358';

describe('workerLocalProxy (S-22.16, `pnpm worker:dev ui`)', () => {
  it('adds nothing without a dev worker', () => {
    expect(workerLocalProxy(undefined)).toEqual({});
    expect(workerLocalProxy('')).toEqual({});
  });

  it("sends /api/local to the worker with the worker's own Host, and sets no fixed Origin", () => {
    const proxy = workerLocalProxy(WORKER);
    expect(Object.keys(proxy)).toEqual([LOCAL_API_PREFIX]);
    expect(proxy[LOCAL_API_PREFIX]).toMatchObject({ target: WORKER, changeOrigin: true });
    expect(proxy[LOCAL_API_PREFIX]).not.toHaveProperty('headers');
  });

  it('refuses an address that is not a URL', () => {
    expect(() => workerLocalProxy('not a url')).toThrow();
  });

  it('rewrites the Origin of a proxied request only when it is the page Vite served', () => {
    const entry = workerLocalProxy(WORKER)[LOCAL_API_PREFIX];
    let listener: Parameters<ProxyRequestEmitter['on']>[1] | undefined;
    entry?.configure({ on: (_event, registered) => (listener = registered) });
    const forward = (headers: Record<string, string>): Record<string, string> => {
      const set: Record<string, string> = {};
      listener?.({ setHeader: (name, value) => (set[name] = value) }, { headers });
      return set;
    };
    expect(forward({ host: 'localhost:5174', origin: 'http://localhost:5174' })).toEqual({
      origin: WORKER,
    });
    expect(forward({ host: 'localhost:5174', origin: 'https://evil.example' })).toEqual({
      origin: 'https://evil.example',
    });
    expect(forward({ host: 'localhost:5174' })).toEqual({});
  });
});

describe('proxiedOrigin', () => {
  it("answers the worker's origin for Vite's own, on every loopback name", () => {
    for (const host of ['localhost:5174', '127.0.0.1:5174', '[::1]:5174']) {
      expect(proxiedOrigin({ host, origin: `http://${host}` }, WORKER)).toBe(WORKER);
    }
  });

  it('forwards every other Origin unchanged, and invents none', () => {
    // A cross-site page.
    expect(proxiedOrigin({ host: 'localhost:5174', origin: 'http://evil.example' }, WORKER)).toBe(
      'http://evil.example',
    );
    // Another port on this machine is another origin.
    expect(proxiedOrigin({ host: 'localhost:5174', origin: 'http://localhost:9999' }, WORKER)).toBe(
      'http://localhost:9999',
    );
    // A rebound name: same-origin to itself, but its Host is not loopback.
    expect(
      proxiedOrigin(
        { host: 'rebound.example:5174', origin: 'http://rebound.example:5174' },
        WORKER,
      ),
    ).toBe('http://rebound.example:5174');
    expect(proxiedOrigin({ host: 'localhost:5174' }, WORKER)).toBeUndefined();
  });
});
