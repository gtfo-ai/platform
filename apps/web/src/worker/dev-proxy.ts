/**
 * **The worker page's dev proxy** (S-22.16) — what `vite.config.ts` adds when
 * `pnpm worker:dev ui` sets `APP_DEV_WORKER_URL` to the dev worker's published page
 * (`http://127.0.0.1:7358`). Read at config time; nothing of it reaches a bundle.
 *
 * The page is served by Vite (hot reload) and its `/api/local/*` calls go to the worker, which
 * checks two headers a proxy would otherwise get wrong (`apps/server/src/remote-worker/local-ui.ts`):
 *
 * - **`Host`** must name the worker's own published address — `changeOrigin` rewrites it to the
 *   target's (`127.0.0.1:7358`) rather than Vite's.
 * - **`Origin`** on a `POST` must equal `http://<Host>`. The page's own calls carry **Vite's**
 *   origin, so {@link proxiedOrigin} rewrites exactly that one — a loopback `Host` and an `Origin`
 *   equal to `http://<that Host>`, i.e. the page Vite served — to the worker's. **Every other
 *   `Origin` is forwarded unchanged**, so a cross-site `POST` to `localhost:<vite>/api/local/*`
 *   (or one through a rebound name, whose `Host` is not loopback) reaches the worker with its own
 *   origin and is refused there (`403 origin_refused`), exactly as it would be without the proxy.
 *   The CSRF check is therefore the worker's own, not a token's: the page may be tokenless.
 *
 * The entry must come **before** `/api` in the proxy table: Vite takes the first prefix that
 * matches, and `/api` goes to the core.
 */
import type { IncomingHttpHeaders } from 'node:http';
import { LOCAL_API_PREFIX } from './read-state.js';

/** The `Host` names a page Vite served on this machine is addressed by (Vite listens on loopback). */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]):\d{1,5}$/;

/**
 * The `Origin` to forward: the worker's when the request comes from the page Vite itself served,
 * otherwise whatever the request carried (`undefined` when it carried none) — never invented.
 */
export const proxiedOrigin = (
  headers: IncomingHttpHeaders,
  workerOrigin: string,
): string | undefined => {
  const { host, origin } = headers;
  if (typeof origin !== 'string') return undefined;
  if (typeof host === 'string' && LOOPBACK_HOST.test(host) && origin === `http://${host}`) {
    return workerOrigin;
  }
  return origin;
};

/** The slice of http-proxy's server `configure` is handed: its `proxyReq` event. */
export interface ProxyRequestEmitter {
  on(
    event: 'proxyReq',
    listener: (
      proxyRequest: { setHeader(name: string, value: string): void },
      request: { readonly headers: IncomingHttpHeaders },
    ) => void,
  ): unknown;
}

export interface WorkerLocalProxyEntry {
  readonly target: string;
  readonly changeOrigin: true;
  readonly configure: (proxy: ProxyRequestEmitter) => void;
}

/** `{}` with no worker; else the one `/api/local` entry. A URL that does not parse is refused. */
export const workerLocalProxy = (
  workerUrl: string | undefined,
): Record<string, WorkerLocalProxyEntry> => {
  if (workerUrl === undefined || workerUrl === '') return {};
  const origin = new URL(workerUrl).origin;
  return {
    [LOCAL_API_PREFIX]: {
      target: origin,
      changeOrigin: true,
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyRequest, request) => {
          const forwarded = proxiedOrigin(request.headers, origin);
          // Only Vite's own origin is replaced; any other is set back to itself, unchanged.
          if (forwarded !== undefined) proxyRequest.setHeader('origin', forwarded);
        });
      },
    },
  };
};
