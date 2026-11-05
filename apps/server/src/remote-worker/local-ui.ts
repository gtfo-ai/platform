/**
 * **The worker's local page — its listener** — WP-292 (1), TD-031's 2026-11-04 worker-UI amendment
 * §1–2.
 *
 * A second `node:http` listener, separate from `/internal/*`, on container port 7357 —
 * `compose.worker.yml` publishes it `127.0.0.1:${APP_WORKER_UI_PORT:-7357}:7357` only. It serves
 * `apps/web`'s second entry (`worker.html` and its `/assets/*`) and the JSON verbs under
 * `/api/local/*`. In this order, on every request:
 *
 * 1. **`Host`** must be exactly `localhost`, `127.0.0.1` or `[::1]` with the published port —
 *    anything else is `421` (DNS rebinding: a page on another name that resolves to 127.0.0.1 sends
 *    its own name; `[unverified]` V-WM9 is the residual the token covers).
 * 2. **`/api/local/*`** needs `Authorization: Bearer <ui-token>`, compared in constant time — `401`.
 *    **No cookie** is ever read or set, so a cross-site request carries no credential and CSRF has
 *    nothing to ride; **no CORS header** is ever sent, so no other origin may read an answer.
 * 3. **A mutating call** (`POST`) must also carry an `Origin` equal to `http://<Host>` — `403`.
 * 4. Every answer: `Cache-Control: no-store`, the core's CSP (`default-src 'self'`, `frame-ancestors
 *    'none'`, …), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
 *
 * The static files are public (they hold no secret) but behind the `Host` check. Which file a path
 * names is decided by the core's own guard (`web/bundle.ts`: realpath containment, no dotfile, no
 * encoded separator); only `/` (the page) and `/assets/*` are served — nothing of the SPA.
 */
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  WORKER_LOCAL_API_PREFIX,
  WORKER_LOCAL_PATHS,
  workerLocalCancelRequestSchema,
  workerLocalClaimScopeRequestSchema,
  workerLocalPauseRequestSchema,
  workerLocalTakeRequestSchema,
} from '@platform/contracts';
import { ASSET_DIRECTORY, decodeRequestPath, resolveBundleFile } from '../web/bundle.js';
import { CONTENT_SECURITY_POLICY } from '../web/csp.js';
import { isUiToken } from './ui-token.js';

/** The page's own file in the web bundle (`apps/web/worker.html`, Vite's second entry). */
export const WORKER_PAGE_FILE = 'worker.html';

/** A request body past this is refused: every local verb's body is a handful of fields. */
export const LOCAL_BODY_MAX_BYTES = 16 * 1024;

/** A refusal the API answers with its envelope. */
export class LocalUiError extends Error {
  override readonly name = 'LocalUiError';
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/**
 * What the listener asks of the worker: the page's state, the three controls — and, since WP-293,
 * the claim scope and *take this one*.
 */
export interface LocalUiApi {
  /** The page's whole state, already redacted (`runtime.ts`). */
  state(): unknown;
  pause(paused: boolean): Promise<unknown>;
  drain(): Promise<unknown>;
  cancel(input: {
    readonly runId: string;
    readonly reason: string | undefined;
    readonly idempotencyKey: string;
  }): Promise<unknown>;
  /** The claim scope and the projects it may name — the core's `GET claim-scope` (WP-293). */
  claimScope(): Promise<unknown>;
  /** Set the claim scope — the core's `PUT claim-scope` — and answer it read back (WP-293). */
  setClaimScope(projectIds: readonly string[] | null): Promise<unknown>;
  /** The offers this worker could take now — the core's `GET offers` (WP-293). */
  offers(): Promise<unknown>;
  /** *Take this one* — the core's pick, then the run starts here (WP-293). */
  take(runId: string): Promise<unknown>;
}

export interface LocalUiOptions {
  readonly token: string;
  /** The host port the page is published on (`APP_WORKER_UI_PORT`); `Host` must name it. */
  readonly publishedPort: number;
  /** The web bundle's realpath (`resolveBundleRoot`), or `null`: the page answers `503` by name. */
  readonly webRoot: string | null;
  readonly api: LocalUiApi;
  /** Redacts an error message before it is answered (the worker's exact-value redactor). */
  readonly redact: (text: string) => string;
}

const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'cache-control': 'no-store',
  'content-security-policy': CONTENT_SECURITY_POLICY,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
};

/** The three `Host` values the page answers to (amendment §2). */
export const allowedHosts = (publishedPort: number): readonly string[] => [
  `localhost:${publishedPort}`,
  `127.0.0.1:${publishedPort}`,
  `[::1]:${publishedPort}`,
];

const bearerOf = (request: IncomingMessage): string | null => {
  const header = request.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9_-]{1,128})$/.exec(header.trim());
  return match?.[1] ?? null;
};

const readBody = async (request: IncomingMessage): Promise<unknown> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > LOCAL_BODY_MAX_BYTES) {
      throw new LocalUiError(413, 'body_too_large', 'a local request body is at most 16 KiB');
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new LocalUiError(400, 'invalid_body', 'the body is not JSON');
  }
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

export const createLocalUiServer = (options: LocalUiOptions): Server => {
  const hosts = new Set(allowedHosts(options.publishedPort));

  const send = (
    response: ServerResponse,
    status: number,
    body: unknown,
    extra: Readonly<Record<string, string>> = {},
  ): void => {
    response.writeHead(status, {
      ...SECURITY_HEADERS,
      'content-type': 'application/json; charset=utf-8',
      ...extra,
    });
    response.end(JSON.stringify(body));
  };
  const refuse = (response: ServerResponse, error: LocalUiError): void =>
    send(response, error.status, {
      error: { code: error.code, message: options.redact(error.message).slice(0, 2_000) },
    });

  const serveFile = async (
    request: IncomingMessage,
    response: ServerResponse,
    segments: readonly string[],
  ): Promise<void> => {
    if (options.webRoot === null) {
      throw new LocalUiError(
        503,
        'page_unavailable',
        'this image carries no web bundle, so the local page cannot be served',
      );
    }
    const file = await resolveBundleFile(options.webRoot, segments);
    if (file === null) {
      throw new LocalUiError(404, 'not_found', 'nothing is served at this path');
    }
    const bytes = await readFile(file.path);
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': file.contentType,
      // The page and its assets: `no-store` like everything here — a local page has no CDN to help.
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  };

  const api = async (
    request: IncomingMessage,
    response: ServerResponse,
    verb: string,
    host: string,
  ): Promise<void> => {
    if (!isUiToken(options.token, bearerOf(request))) {
      throw new LocalUiError(
        401,
        'unauthenticated',
        'open the page from the address the worker logged (it carries the token after #token=)',
      );
    }
    if (request.method === 'GET' && verb === WORKER_LOCAL_PATHS.state) {
      send(response, 200, options.api.state());
      return;
    }
    if (request.method === 'GET' && verb === WORKER_LOCAL_PATHS.claimScope) {
      send(response, 200, await options.api.claimScope());
      return;
    }
    if (request.method === 'GET' && verb === WORKER_LOCAL_PATHS.offers) {
      send(response, 200, await options.api.offers());
      return;
    }
    if (request.method !== 'POST') {
      throw new LocalUiError(405, 'method_not_allowed', `${request.method} is not served here`);
    }
    // A mutation names this page's own origin — exactly, and present (amendment §2).
    if (request.headers.origin !== `http://${host}`) {
      throw new LocalUiError(
        403,
        'origin_refused',
        'a change is accepted only from this page itself (its Origin header)',
      );
    }
    const body = await readBody(request);
    if (verb === WORKER_LOCAL_PATHS.pause) {
      const parsed = workerLocalPauseRequestSchema.safeParse(body);
      if (!parsed.success) throw new LocalUiError(400, 'invalid_body', 'expected { paused }');
      send(response, 200, await options.api.pause(parsed.data.paused));
      return;
    }
    if (verb === WORKER_LOCAL_PATHS.drain) {
      send(response, 202, await options.api.drain());
      return;
    }
    if (verb === WORKER_LOCAL_PATHS.claimScope) {
      const parsed = workerLocalClaimScopeRequestSchema.safeParse(body);
      if (!parsed.success) {
        throw new LocalUiError(400, 'invalid_body', 'expected { claim_project_ids: null | [ids] }');
      }
      send(response, 200, await options.api.setClaimScope(parsed.data.claim_project_ids));
      return;
    }
    const take = /^offers\/([0-9a-f-]{36})\/take$/.exec(verb);
    if (take !== null) {
      if (!workerLocalTakeRequestSchema.safeParse(body).success) {
        throw new LocalUiError(400, 'invalid_body', 'a take carries no field');
      }
      send(response, 200, await options.api.take(take[1] as string));
      return;
    }
    const cancel = /^runs\/([0-9a-f-]{36})\/cancel$/.exec(verb);
    if (cancel !== null) {
      const parsed = workerLocalCancelRequestSchema.safeParse(body);
      if (!parsed.success) throw new LocalUiError(400, 'invalid_body', 'expected { reason? }');
      const key = request.headers['idempotency-key'];
      if (typeof key !== 'string' || !IDEMPOTENCY_KEY.test(key)) {
        throw new LocalUiError(
          400,
          'idempotency_key_required',
          'a cancel needs an Idempotency-Key',
        );
      }
      send(
        response,
        200,
        await options.api.cancel({
          runId: cancel[1] as string,
          reason: parsed.data.reason,
          idempotencyKey: key,
        }),
      );
      return;
    }
    throw new LocalUiError(404, 'not_found', 'no such local verb');
  };

  const handle = async (request: IncomingMessage, response: ServerResponse): Promise<void> => {
    const host = request.headers.host ?? '';
    if (!hosts.has(host)) {
      // DNS rebinding: a page under another name that resolves here sends that name.
      throw new LocalUiError(
        421,
        'misdirected_request',
        `this page answers only to ${[...hosts].join(', ')}`,
      );
    }
    const pathname = (request.url ?? '/').split('?')[0] ?? '/';
    const prefix = `${WORKER_LOCAL_API_PREFIX}/`;
    if (pathname.startsWith(prefix)) {
      await api(request, response, pathname.slice(prefix.length), host);
      return;
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new LocalUiError(405, 'method_not_allowed', `${request.method} is not served here`);
    }
    if (pathname === '/' || pathname === `/${WORKER_PAGE_FILE}`) {
      await serveFile(request, response, [WORKER_PAGE_FILE]);
      return;
    }
    const segments = decodeRequestPath(pathname);
    if (segments === null || segments[0] !== ASSET_DIRECTORY || segments.length < 2) {
      throw new LocalUiError(404, 'not_found', 'nothing is served at this path');
    }
    await serveFile(request, response, segments);
  };

  return createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      refuse(
        response,
        error instanceof LocalUiError
          ? error
          : new LocalUiError(500, 'internal', (error as Error).message ?? 'failed'),
      );
    });
  });
};
