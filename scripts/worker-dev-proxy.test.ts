/**
 * **`pnpm worker:dev ui`'s proxy, end to end** (S-22.16): the real Vite dev server, configured by
 * `apps/web/vite.config.ts` with `APP_DEV_WORKER_URL`, in front of the worker's real local-page
 * listener (`createLocalUiServer`) — so what is asserted is the worker's own `Host` and `Origin`
 * checks answering what the proxy forwards.
 *
 * The page Vite served is let through (its `Origin` rewritten to the worker's); a **foreign**
 * `Origin` reaches the worker unchanged and is refused `403 origin_refused`, as it is without the
 * proxy. That is the CSRF guard of a page that may carry no token (S-22.17).
 */
import type { Server } from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLocalUiServer } from '../apps/server/src/remote-worker/local-ui.js';

const REPO = join(import.meta.dirname, '..');
const TOKEN = 'a'.repeat(43);

interface ViteDevServer {
  listen(): Promise<ViteDevServer>;
  close(): Promise<void>;
  readonly httpServer: { address(): net.AddressInfo | string | null } | null;
}
/** Vite is `apps/web`'s dependency, borrowed as `coverage-budget.test.ts` borrows picomatch. */
const loadVite = async (): Promise<{
  createServer: (config: Record<string, unknown>) => Promise<ViteDevServer>;
}> =>
  import(
    pathToFileURL(createRequire(join(REPO, 'apps/web/package.json')).resolve('vite')).href
  ) as Promise<never>;

const freePort = async (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address() as net.AddressInfo;
      probe.close(() => resolve(address.port));
    });
  });

let worker: Server;
let vite: ViteDevServer;
let viteOrigin: string;
const posted: unknown[] = [];

beforeAll(async () => {
  const workerPort = await freePort();
  worker = createLocalUiServer({
    token: TOKEN,
    publishedPort: workerPort,
    webRoot: null,
    redact: (text) => text,
    api: {
      state: () => ({ stub: true }),
      pause: async (paused) => {
        posted.push({ paused });
        return { paused };
      },
      drain: async () => ({ drained: true }),
      cancel: async () => ({}),
      claimScope: async () => ({}),
      setClaimScope: async () => ({}),
      offers: async () => ({}),
      take: async () => ({}),
      checkCore: async () => ({}),
      setCore: async () => ({}),
      signIn: async () => ({}),
      claudeCode: async () => ({}),
      claudeToken: async () => ({}),
      signOut: async () => ({}),
      connectAgain: async () => ({}),
      retry: async () => ({}),
      errorReporting: async () => ({}),
      errorReportingTest: async () => ({}),
    },
  });
  await new Promise<void>((resolve) => worker.listen(workerPort, '127.0.0.1', resolve));

  const previous = process.env.APP_DEV_WORKER_URL;
  process.env.APP_DEV_WORKER_URL = `http://127.0.0.1:${workerPort}`;
  try {
    const { createServer } = await loadVite();
    vite = await createServer({
      configFile: join(REPO, 'apps/web/vite.config.ts'),
      logLevel: 'silent',
      server: { host: '127.0.0.1', port: await freePort(), strictPort: true, hmr: false },
    });
    await vite.listen();
  } finally {
    if (previous === undefined) delete process.env.APP_DEV_WORKER_URL;
    else process.env.APP_DEV_WORKER_URL = previous;
  }
  const address = vite.httpServer?.address() as net.AddressInfo;
  viteOrigin = `http://127.0.0.1:${address.port}`;
}, 60_000);

afterAll(async () => {
  await vite?.close();
  await new Promise((resolve) => worker?.close(resolve));
});

const pause = (origin: string): Promise<Response> =>
  fetch(`${viteOrigin}/api/local/pause`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      origin,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ paused: true }),
  });

describe('the worker page dev proxy, through Vite to the worker', () => {
  it('lets the page Vite served read and change the worker', async () => {
    const state = await fetch(`${viteOrigin}/api/local/state`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(state.status).toBe(200);
    expect(await state.json()).toEqual({ stub: true });

    posted.length = 0;
    const changed = await pause(viteOrigin);
    expect(changed.status).toBe(200);
    expect(posted).toEqual([{ paused: true }]);
  });

  it('forwards a foreign Origin unchanged, and the worker refuses it 403', async () => {
    posted.length = 0;
    for (const origin of ['https://evil.example', 'http://localhost:1']) {
      const refused = await pause(origin);
      expect(refused.status, origin).toBe(403);
      expect(await refused.json(), origin).toMatchObject({ error: { code: 'origin_refused' } });
    }
    expect(posted).toEqual([]);
  });
});
