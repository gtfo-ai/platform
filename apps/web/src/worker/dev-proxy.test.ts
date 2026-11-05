import { describe, expect, it } from 'vitest';
import { workerLocalProxy } from './dev-proxy.js';
import { LOCAL_API_PREFIX } from './read-state.js';

describe('workerLocalProxy (S-22.16, `pnpm worker:dev ui`)', () => {
  it('adds nothing without a dev worker', () => {
    expect(workerLocalProxy(undefined)).toEqual({});
    expect(workerLocalProxy('')).toEqual({});
  });

  it("sends /api/local to the worker with the worker's own Host and Origin", () => {
    const proxy = workerLocalProxy('http://127.0.0.1:7358');
    expect(Object.keys(proxy)).toEqual([LOCAL_API_PREFIX]);
    expect(proxy[LOCAL_API_PREFIX]).toEqual({
      target: 'http://127.0.0.1:7358',
      changeOrigin: true,
      headers: { origin: 'http://127.0.0.1:7358' },
    });
  });

  it('refuses an address that is not a URL', () => {
    expect(() => workerLocalProxy('not a url')).toThrow();
  });
});
