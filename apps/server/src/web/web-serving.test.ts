/**
 * The SPA served by a real `apps/server` router (WP-15j, criteria 1–4 and 6).
 *
 * ## Why half of this file talks to a socket
 *
 * `app.inject()` **normalises the request target before the server sees it**, measured here on
 * light-my-request under Fastify 5.12.3:
 *
 * | injected                        | what the handler received |
 * |---------------------------------|---------------------------|
 * | `/../outside.txt`               | `/outside.txt`            |
 * | `/%2e%2e/outside.txt`           | `/outside.txt`            |
 * | `/a/../../b`                    | `/b`                      |
 *
 * So a traversal test written with `inject` asserts that the server refuses a path **it was never
 * sent** — a green result about a request nobody can make, which is standing rule 21's
 * uncalibrated instrument in a new spelling. Node's HTTP server does no such normalisation: the raw
 * target reaches Fastify, which is what `raw()` below sends and what a scanner sends. Every
 * traversal case therefore goes over a real socket, with a **positive control on the same
 * transport** so that a broken helper cannot pass as a refusal.
 *
 * ## What this file holds that the census cannot
 *
 * `routes/client-census.test.ts` builds the app with **no bundle**, so it cannot see whether the
 * fallback answers for an unserved `/api/…` path — the very thing that would turn the census off
 * (its "not served" verdict is the not-found handler's own body). That assertion lives here, with a
 * bundle configured and the prefixes read off `app.registeredRouteUrls` rather than listed by hand,
 * so a route group added later is covered the day it is registered (standing rules 7 and 68).
 */
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import type { WebhookIngress } from '@platform/application';
import type { FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../app.js';
import type { Auth } from '../auth/better-auth.js';
import { loadServerConfig } from '../config.js';
import { createLogger } from '../logging.js';
import { createMetrics } from '../metrics.js';
import type { Database } from '../queries/identity-queries.js';
import { SseHub } from '../sse/hub.js';
import { IMMUTABLE_CACHE_CONTROL, REVALIDATE_CACHE_CONTROL } from './bundle.js';
import { reservedFirstSegments } from './fallback.js';

const SHELL = '<!doctype html><html lang="en"><body><div id="root"></div></body></html>\n';
const ASSET = 'export const version = "wp15j";\n';
const OUTSIDE = 'not-a-real-secret-but-outside-the-root\n';
const PLANTED = 'a file in the bundle whose path the router owns\n';
const PROBE_ID = '00000000-0000-4000-8000-000000000000';

/**
 * The Content-Security-Policy this server is expected to serve, written out rather than imported.
 *
 * `csp.ts` carries the measurement of the built bundle that chose each directive; this is the
 * statement that a future edit to that file has to come past.
 */
const EXPECTED_POLICY =
  "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
  "connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; " +
  "frame-ancestors 'none'";

let base: string;
let root: string;

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), 'wp15j-serving-'));
  root = join(base, 'dist');
  mkdirSync(join(root, 'assets'), { recursive: true });
  mkdirSync(join(root, 'api'), { recursive: true });
  writeFileSync(join(root, 'index.html'), SHELL);
  writeFileSync(join(root, 'assets', 'index-Wp15J000.js'), ASSET);
  // A file the bundle has no business containing, under a segment the router owns: the fallback
  // must not serve it even though it exists and no route answers that exact path.
  writeFileSync(join(root, 'api', 'planted.txt'), PLANTED);
  writeFileSync(join(root, '.env'), 'APP_SECRET_KEY=not-a-real-secret\n');
  mkdirSync(join(base, 'outside'), { recursive: true });
  writeFileSync(join(base, 'outside', 'neighbour.txt'), OUTSIDE);
  symlinkSync(join(base, 'outside', 'neighbour.txt'), join(root, 'leak.txt'));
  symlinkSync(join(base, 'outside'), join(root, 'outside-link'));
  symlinkSync('/etc/hosts', join(root, 'hosts.txt'));
});

afterAll(async () => {
  await rm(base, { recursive: true, force: true });
});

const anonymousAuth = {
  api: { getSession: async () => null },
  handler: async () => new Response('{}', { status: 200 }),
} as unknown as Auth;

interface Harness {
  readonly app: FastifyInstance;
  readonly logLines: () => Record<string, unknown>[];
}

const harnesses: FastifyInstance[] = [];

const build = async (
  options: { role?: string; webRoot?: string | null } = {},
): Promise<Harness> => {
  const chunks: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  const app = await buildApp({
    config: loadServerConfig({
      DATABASE_URL: 'postgres://app:app@db:5432/app',
      APP_SECRET_KEY: 'x'.repeat(40),
      APP_BASE_URL: 'http://localhost:8080',
      ...(options.role === undefined ? {} : { ROLE: options.role }),
    }),
    logger: createLogger({ level: 'info', format: 'json', role: 'all', destination }),
    metrics: createMetrics({ defaultMetrics: false }),
    database: {} as Database,
    auth: anonymousAuth,
    hub: new SseHub({
      bufferSize: 4,
      maxQueuedFrames: 8,
      maxTopicsPerConnection: 4,
      maxBufferedTopics: 8,
      retryMs: 1_000,
      pingIntervalMs: 0,
      maxConnections: 2,
      shutdownDrainMs: 100,
    }),
    // A stub ingress, so the `/webhooks/*` routes are registered and the prefix assertion below
    // covers them: `buildApp` registers the route only when an ingress is composed, and a prefix
    // that is absent from the router is a prefix this file would silently not be testing.
    webhooks: {
      deliver: async () => ({ accepted: false, reason: 'stub' }),
    } as unknown as WebhookIngress,
    knowledge: null,
    onboarding: null,
    // WP-34: no pipeline here, so the batch command refuses by name and the gate cannot answer.
    shadow: null,
    shadowGate: null,
    historyBootstrap: null,
    historyBootstrapGate: null,
    commands: null,
    // WP-31: no pipeline here, so the ask command refuses by name; the reads answer nothing.
    asks: {
      commands: null,
      queries: { listAsks: async () => [], taskAudit: async () => [] },
    },
    // WP-40: no pipeline store here, so the decision refuses by name and the queue reads empty.
    breakdown: null,
    webRoot: options.webRoot === undefined ? root : options.webRoot,
    version: { version: '0.0.0-test', commit: null, builtAt: null },
    readiness: async () => ({ status: 'ok', checks: {} }),
    isShuttingDown: () => false,
  });
  harnesses.push(app);
  return {
    app,
    logLines: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

afterEach(async () => {
  for (const app of harnesses.splice(0)) {
    await app.close();
  }
});

interface RawResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * One request over a real socket, with the target written **exactly** as given.
 *
 * No HTTP client is involved on purpose: `fetch` and `http.request` would normalise `..` the way
 * `inject` does, which is the whole reason this helper exists.
 */
const raw = async (app: FastifyInstance, requestLine: string): Promise<RawResponse> => {
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('the test server is not listening on a port');
  }
  const text = await new Promise<string>((resolve, reject) => {
    const socket = net.connect(address.port, '127.0.0.1', () => {
      socket.write(`${requestLine} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      data += chunk;
    });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
  const separator = text.indexOf('\r\n\r\n');
  const head = text.slice(0, separator).split('\r\n');
  const headers: Record<string, string> = {};
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':');
    headers[line.slice(0, colon).toLowerCase()] = line.slice(colon + 1).trim();
  }
  return {
    status: Number((head[0] ?? '').split(' ')[1]),
    headers,
    body: text.slice(separator + 4),
  };
};

const notFoundBody = { error: { code: 'not_found', message: 'no such endpoint' } };

describe('the shell and the assets come off disk', () => {
  it('serves index.html at / byte for byte', async () => {
    const { app } = await build();
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    // The bytes on disk, not a string this test also wrote: a route answering a hard-coded shell
    // cannot pass (standing rule 82).
    expect(response.rawPayload.equals(readFileSync(join(root, 'index.html')))).toBe(true);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['cache-control']).toBe(REVALIDATE_CACHE_CONTROL);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves a hashed asset byte for byte, cacheable for a year', async () => {
    const { app } = await build();
    const response = await app.inject({ url: '/assets/index-Wp15J000.js' });
    expect(response.statusCode).toBe(200);
    expect(
      response.rawPayload.equals(readFileSync(join(root, 'assets', 'index-Wp15J000.js'))),
    ).toBe(true);
    expect(response.headers['content-type']).toBe('text/javascript; charset=utf-8');
    expect(response.headers['cache-control']).toBe(IMMUTABLE_CACHE_CONTROL);
  });

  it('answers a conditional request with 304 and no body', async () => {
    const { app } = await build();
    const first = await app.inject({ url: '/assets/index-Wp15J000.js' });
    const etag = first.headers.etag;
    expect(etag).toBeDefined();
    const second = await app.inject({
      url: '/assets/index-Wp15J000.js',
      headers: { 'if-none-match': String(etag) },
    });
    expect(second.statusCode).toBe(304);
    expect(second.rawPayload.length).toBe(0);
  });

  it('answers a conditional request by date, in both directions', async () => {
    // `Last-Modified` was sent from the first version of this module and `If-Modified-Since` was
    // never read, so every conditional request by date was answered with the whole file (round 2,
    // nit 4). The date is second-granular, which is why the header this server sent is the one
    // sent back rather than a millisecond mtime.
    const { app } = await build();
    const first = await app.inject({ url: '/' });
    const lastModified = String(first.headers['last-modified']);
    expect(lastModified).not.toBe('undefined');

    const fresh = await app.inject({ url: '/', headers: { 'if-modified-since': lastModified } });
    expect(fresh.statusCode).toBe(304);
    expect(fresh.rawPayload.length).toBe(0);

    const stale = await app.inject({
      url: '/',
      headers: { 'if-modified-since': new Date(Date.parse(lastModified) - 60_000).toUTCString() },
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.rawPayload.equals(readFileSync(join(root, 'index.html')))).toBe(true);

    // RFC 9110 §13.1.3: with an entity tag present the date is ignored, so a client holding a
    // *different* representation gets the file even though its clock says otherwise.
    const bothValidators = await app.inject({
      url: '/',
      headers: { 'if-none-match': 'W/"nothing-like-it"', 'if-modified-since': lastModified },
    });
    expect(bothValidators.statusCode).toBe(200);

    const unparseable = await app.inject({
      url: '/',
      headers: { 'if-modified-since': 'the day before yesterday' },
    });
    expect(unparseable.statusCode).toBe(200);
  });

  it('carries the whole policy on every response the bundle answers', async () => {
    // This origin carries WP-15i's authenticated commands, so the pages that render them must not
    // be loadable inside somebody else's frame (round 2, finding 3) — and, since round 3, must not
    // load a script, a style or a connection from anywhere but themselves either. On the shell, on
    // a deep link and on an asset: the guard belongs to the response, not to one path.
    //
    // The expected value is spelled out rather than imported from `csp.ts`, so that weakening a
    // directive there is a decision somebody makes here too (standing rule 44: a test that reads
    // the constant it is checking asserts nothing).
    const { app } = await build();
    for (const url of ['/', '/projects/ACME', '/assets/index-Wp15J000.js']) {
      const response = await app.inject({ url });
      expect(response.statusCode, url).toBe(200);
      expect(response.headers['x-frame-options'], url).toBe('DENY');
      expect(response.headers['content-security-policy'], url).toBe(EXPECTED_POLICY);
      expect(response.headers.vary, url).toBe('accept-encoding');
    }
  });

  it('ships the policy the built bundle was measured to need, and no `unsafe-` escape', async () => {
    // The measurement is `csp.ts`'s docblock; what is asserted here is the shape a reader of the
    // header would check: no inline escape hatch, and the four directives that would otherwise
    // fall back to `default-src` where a fallback is not what stops the attack (`object-src`,
    // `base-uri` and `form-action` have **no** fallback at all).
    const { app } = await build();
    const policy = (await app.inject({ url: '/' })).headers['content-security-policy'];
    expect(policy).not.toContain('unsafe-inline');
    expect(policy).not.toContain('unsafe-eval');
    expect(policy).toContain("script-src 'self'");
    expect(policy).toContain("style-src 'self'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("base-uri 'self'");
    expect(policy).toContain("form-action 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
  });

  it('answers HEAD with the headers and no body', async () => {
    // Over a socket, because `inject` returns the payload for a HEAD it would never receive:
    // measured here, Node's own `ServerResponse` suppresses the body for HEAD (the response
    // carries `content-length: 73` and no body) while `inject` reports 73 bytes of payload. The
    // same divergence as the traversal cases below, in the other direction.
    const { app } = await build();
    const response = await raw(app, 'HEAD /');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.headers['content-length']).toBe(String(Buffer.byteLength(SHELL)));
    expect(response.body).toBe('');
  });
});

describe('a deep link answers the shell', () => {
  it.each([
    '/',
    '/agents',
    '/inbox',
    '/settings',
    '/onboarding',
    '/projects/ACME',
    `/projects/ACME/tasks/${PROBE_ID}`,
    `/tasks/${PROBE_ID}`,
    `/runs/${PROBE_ID}`,
    // A client route this server has never heard of: the SPA owns everything under its segments.
    '/projects/ACME/tasks/7/some/future/tab',
  ])('%s', async (path) => {
    const { app } = await build();
    const response = await app.inject({ url: path });
    expect(response.statusCode).toBe(200);
    expect(response.rawPayload.equals(readFileSync(join(root, 'index.html')))).toBe(true);
  });

  it('never answers a missing asset with the shell', async () => {
    // `assets` is not a client route, so a request for a hash that no longer exists is a 404 —
    // never HTML with a `text/javascript` expectation behind it, which a browser reports as a
    // syntax error in a file that is actually missing.
    const { app } = await build();
    const response = await app.inject({ url: '/assets/index-DeletedHash.js' });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual(notFoundBody);
  });

  it('answers a write to a client path with the API’s 404, not the shell', async () => {
    const { app } = await build();
    for (const method of ['POST', 'PUT', 'DELETE'] as const) {
      const response = await app.inject({ method, url: '/settings' });
      expect(response.statusCode, method).toBe(404);
      expect(response.json(), method).toEqual(notFoundBody);
    }
  });
});

describe('the API never falls back to the shell', () => {
  /** The first segment of every path this router answers on, read off the live route table. */
  const reserved = (app: FastifyInstance): string[] =>
    [
      ...new Set(
        app.registeredRouteUrls
          .map((url) => url.split('/')[1] ?? '')
          .filter((segment) => segment.length > 0 && !segment.startsWith(':') && segment !== '*'),
      ),
    ].sort();

  it('reserves a name and never a parameter or a wildcard', () => {
    // The derivation itself, on a synthetic table: a route mounted at `/:thing` reserves nothing,
    // because `:thing` is not a name a request can carry (rule 10 — the branch would otherwise
    // never run, no route in this server having a parameter first).
    expect(
      [...reservedFirstSegments(['/api/version', '/api/tasks/:id', '/events'])].sort(),
    ).toEqual(['api', 'events']);
    expect(reservedFirstSegments(['/:thing/x', '/*', '/']).size).toBe(0);
  });

  it('registers the prefixes this assertion is parameterised over', async () => {
    // The scope, before anything is concluded from it (standing rule 4). WP-15i added
    // `routes/commands.ts`, which is why the list is derived rather than written down here: a hand
    // list is stale the next time a route group lands.
    const { app } = await build();
    expect(reserved(app)).toEqual(
      expect.arrayContaining([
        'api',
        'events',
        'healthz',
        'metrics',
        'openapi.json',
        'readyz',
        'webhooks',
      ]),
    );
    expect(app.registeredRouteUrls).toContain('/api/auth/*');
  });

  it('answers an unmatched path under every reserved prefix with the API’s own 404', async () => {
    const { app } = await build();
    for (const segment of reserved(app)) {
      const response = await app.inject({ url: `/${segment}/wp15j-no-such-path` });
      expect(response.statusCode, segment).toBe(404);
      expect(response.json(), segment).toEqual(notFoundBody);
      expect(response.headers['content-type'], segment).toContain('application/json');
    }
  });

  it('keeps the census able to tell an unserved endpoint from a served one', async () => {
    // `routes/client-census.test.ts` classifies by this body and builds the app with no bundle, so
    // this is the assertion that the bundle does not turn its instrument off.
    //
    // The path used to be `…/steer`, which was that census's one admitted gap until **WP-27
    // served it**; a probe that is now a real route would assert nothing (standing rule 83 — the
    // sentence nearest a closed gap is the one nobody re-reads). It is an invented path now, on a
    // real prefix, which is what the case has always been about: a `/api/*` request the router does
    // not own must get the API's own 404 and never the bundle's shell.
    const { app } = await build();
    for (const method of ['GET', 'POST', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: `/api/runs/${PROBE_ID}/wp27-no-such-command`,
      });
      expect(response.statusCode, method).toBe(404);
      expect(response.json(), method).toEqual(notFoundBody);
    }
  });

  it('refuses a bundle file whose path the router owns', async () => {
    // The file exists — read it here so the refusal cannot be confused with a missing file.
    const { app } = await build();
    expect(readFileSync(join(root, 'api', 'planted.txt'), 'utf8')).toBe(PLANTED);
    const response = await app.inject({ url: '/api/planted.txt' });
    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('the router owns');
  });

  it('leaves the routes themselves untouched', async () => {
    const { app } = await build();
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/version' })).json()).toMatchObject({
      version: '0.0.0-test',
    });
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/openapi.json' })).statusCode).toBe(200);
    // `/events` without topics is a schema error from the route, never a 404 from the fallback.
    expect((await app.inject({ url: '/events' })).statusCode).toBe(400);
  });
});

describe('a path outside the bundle root is refused, over a socket that does not normalise it', () => {
  it('serves the shell over the same transport, so a refusal below is not a broken helper', async () => {
    const { app } = await build();
    const response = await raw(app, 'GET /index.html');
    expect(response.status).toBe(200);
    expect(response.body).toBe(SHELL);
  });

  it.each([
    ['a parent traversal', 'GET /../outside/neighbour.txt'],
    ['a percent-encoded traversal', 'GET /%2e%2e/outside/neighbour.txt'],
    ['a traversal deeper in', 'GET /assets/../../outside/neighbour.txt'],
    ['an encoded traversal deeper in', 'GET /assets/%2e%2e%2f%2e%2e%2foutside%2fneighbour.txt'],
    ['a symlink to a file outside the root', 'GET /leak.txt'],
    ['a symlink to a directory outside the root', 'GET /outside-link/neighbour.txt'],
    ['a dotfile', 'GET /.env'],
  ])('refuses %s', async (_name, requestLine) => {
    const { app } = await build();
    const response = await raw(app, requestLine);
    expect(response.status).toBe(404);
    expect(JSON.parse(response.body)).toEqual(notFoundBody);
    expect(response.body).not.toContain('outside-the-root');
    expect(response.body).not.toContain('not-a-real-secret');
  });

  it('refuses a symlink to a real file outside the root and serves none of it', async () => {
    // `/etc/hosts` exists on both platforms this runs on, and it is read here so the refusal is a
    // statement about the guard rather than about the file (standing rule 55).
    const hosts = readFileSync('/etc/hosts', 'utf8');
    expect(hosts.length).toBeGreaterThan(0);
    const { app } = await build();
    const response = await raw(app, 'GET /hosts.txt');
    expect(response.status).toBe(404);
    expect(response.body).not.toContain(hosts.slice(0, 20));
  });

  it('refuses an absolute path to a real file outside the root', async () => {
    const { app } = await build();
    const response = await raw(app, `GET ${join(base, 'outside', 'neighbour.txt')}`);
    expect(response.status).toBe(404);
    expect(response.body).not.toContain('outside-the-root');
  });

  it('is measured against a transport that really does deliver the raw target', async () => {
    // The measurement the docblock rests on: `inject` normalises `..` away, so the cases above
    // would pass against a server with no guard at all if they were written with it.
    const { app } = await build();
    const injected = await app.inject({ url: '/../outside/neighbour.txt' });
    expect(injected.statusCode).toBe(404);
    // …and what the socket delivered was the un-normalised target, which is why `raw` exists.
    const overSocket = await raw(app, 'GET /wp15j-raw-target/../wp15j-raw-target');
    expect(overSocket.status).toBe(404);
  });
});

describe('an absent bundle refuses by name', () => {
  it('logs the directory, serves the API, and 404s the browser application', async () => {
    const missing = join(base, 'no-such-bundle');
    const { app, logLines } = await build({ webRoot: missing });
    expect(
      logLines().some((line) => line.web_root === missing && line.variable === 'APP_WEB_ROOT'),
    ).toBe(true);

    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/healthz' })).json()).toMatchObject({ status: 'ok' });
    expect((await app.inject({ url: '/readyz' })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/version' })).statusCode).toBe(200);
  });

  it('logs the missing shell when the directory is there and index.html is not', async () => {
    const empty = join(base, 'empty-bundle');
    mkdirSync(empty, { recursive: true });
    const { app, logLines } = await build({ webRoot: empty });
    expect(logLines().some((line) => line.missing === 'index.html')).toBe(true);
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
  });

  it('serves nothing from a process that serves no API, whatever its web root', async () => {
    // The roles that serve the SPA are the ones that serve the API: a worker container is probed,
    // not browsed to.
    const { app } = await build({ role: 'worker' });
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/assets/index-Wp15J000.js' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/healthz' })).statusCode).toBe(200);
  });

  it('serves nothing when no web root was composed at all', async () => {
    // The seam the census and `app.test.ts` build under, asserted rather than assumed: those files
    // must not start depending on whether somebody ran `pnpm bundle:check` in this checkout.
    const { app } = await build({ webRoot: null });
    expect((await app.inject({ url: '/' })).statusCode).toBe(404);
    expect((await app.inject({ url: '/' })).json()).toEqual(notFoundBody);
  });
});
