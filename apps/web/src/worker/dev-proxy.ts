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
 * - **`Origin`** on a `POST` must equal `http://<Host>` — the browser sends Vite's, so it is
 *   rewritten to the worker's. That is a dev-only loosening of a CSRF check, and it costs nothing
 *   the check was for: every `/api/local` call still needs the page token as `Authorization:
 *   Bearer`, which no other page holds, and Vite listens on loopback.
 *
 * The entry must come **before** `/api` in the proxy table: Vite takes the first prefix that
 * matches, and `/api` goes to the core.
 */
import { LOCAL_API_PREFIX } from './read-state.js';

export interface WorkerLocalProxyEntry {
  readonly target: string;
  readonly changeOrigin: true;
  readonly headers: { readonly origin: string };
}

/** `{}` with no worker; else the one `/api/local` entry. A URL that does not parse is refused. */
export const workerLocalProxy = (
  workerUrl: string | undefined,
): Record<string, WorkerLocalProxyEntry> => {
  if (workerUrl === undefined || workerUrl === '') return {};
  const origin = new URL(workerUrl).origin;
  return { [LOCAL_API_PREFIX]: { target: origin, changeOrigin: true, headers: { origin } } };
};
