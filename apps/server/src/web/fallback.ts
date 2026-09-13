/**
 * Serving the SPA from the app process (WP-15j; technical/09 § Stack, backlog 33).
 *
 * technical/09 puts the bundle, the API and the SSE stream on **one origin**, which is what makes
 * the `__Host-` session cookie reach `/api` and `/events` with no CORS question to answer. This
 * module is the serving half: the assets off disk, and `index.html` for a deep link.
 *
 * ## It is a not-found handler, not a route
 *
 * The fallback runs only when the router matched nothing, so it **cannot** shadow a registered
 * route — the ordering question a `GET /*` route would create does not exist here. What it can
 * still do wrong is answer for an `/api/…` path that no route serves, and that is the failure the
 * allow-list in `client-routes.ts` exists to prevent: the shell is returned for a path whose first
 * segment is one the SPA's own route tree declares, and for nothing else.
 *
 * There is a second, narrower guard on the file half. A request whose first segment is one the
 * **router** reserves is refused before the disk is touched, so a bundle that somehow contained
 * `api/version` could not answer an unserved `/api/version`. That set is read off the live route
 * table (`app.registeredRouteUrls`) rather than written down, so it cannot drift from the routes
 * this server actually has — a hand-written copy would be the deny-list this design rejects.
 *
 * ## Order of decisions, and what each one costs
 *
 * 1. `GET`/`HEAD` only. A `POST /projects/acme` is somebody's mistake, and answering it with HTML
 *    would make a broken client look like a working one.
 * 2. The path decodes to structurally safe segments (`bundle.ts`), or the request is refused.
 * 3. The first segment is not reserved by the router.
 * 4. A file with that exact name exists inside the root → serve it.
 * 5. Otherwise the path is a client route → serve `index.html`.
 * 6. Otherwise `false`, and the caller answers the API's own JSON 404.
 *
 * Step 4 before step 5 is what keeps `/assets/deleted-hash.js` from answering with HTML: a missing
 * asset is a 404, because `assets` is not a client route. A browser that got `index.html` with a
 * `text/javascript` content type would report a syntax error instead of a missing file.
 *
 * ## What `send` adds to every answer
 *
 * The validators (`etag`/`last-modified`, both honoured on the way back in), `vary`, the framing
 * headers, the Content-Security-Policy (`csp.ts`, which carries the bundle measurement that chose
 * each directive), `nosniff` — and the **content coding**, which is `encoding.ts` rather than
 * `@fastify/compress`: the plugin hangs its `onSend` off an `onRoute` hook and Fastify emits none
 * for a not-found context, so the plugin can compress every route of this server and never this
 * one. That measurement is in `encoding.ts`; the plugin is still registered, for everything else.
 */
import { readFile } from 'node:fs/promises';
import type { FastifyBaseLogger, FastifyReply, FastifyRequest } from 'fastify';
import {
  type BundleFile,
  decodeRequestPath,
  REVALIDATE_CACHE_CONTROL,
  resolveBundleFile,
  resolveBundleRoot,
} from './bundle.js';
import { isClientRoute } from './client-routes.js';
import { CONTENT_SECURITY_POLICY } from './csp.js';
import { type BundleEncoder, createBundleEncoder } from './encoding.js';

/** The application shell, which every deep link is answered with. */
const SHELL = 'index.html';

/** Returns `true` when it has answered the request; `false` leaves it to the not-found handler. */
export type ClientFallback = (request: FastifyRequest, reply: FastifyReply) => Promise<boolean>;

export interface ClientFallbackOptions {
  /** The bundle directory: `config.webRoot ?? BUNDLED_WEB_ROOT` in production. */
  readonly root: string;
  /** Every route URL this instance registered, in registration order. */
  readonly routeUrls: readonly string[];
  readonly logger: FastifyBaseLogger;
}

/**
 * The first segment of every path the router answers on — `api`, `events`, `healthz`, … — read off
 * the route table rather than written down.
 *
 * A parameterised or wildcard first segment (`/:thing`, `/*`) reserves nothing: it is not a name,
 * and treating it as one would reserve the string `:thing`. No route in this server has one today,
 * and `web-serving.test.ts` asserts the derived set against the live table so that a route added
 * later shows up here.
 */
export const reservedFirstSegments = (routeUrls: readonly string[]): ReadonlySet<string> => {
  const reserved = new Set<string>();
  for (const url of routeUrls) {
    const first = url.split('/')[1];
    if (first !== undefined && first.length > 0 && !first.startsWith(':') && first !== '*') {
      reserved.add(first);
    }
  }
  return reserved;
};

/** `/runs/abc?x=1#frag` → `/runs/abc`. Fastify's `request.url` is the raw request target. */
const pathnameOf = (url: string): string => {
  const cut = url.search(/[?#]/);
  return cut === -1 ? url : url.slice(0, cut);
};

/** RFC 9110 §13.1.2: a comma-separated list, `W/` on either side, `*` matches anything. */
const matchesEtag = (header: string | undefined, etag: string): boolean => {
  if (header === undefined) {
    return false;
  }
  const bare = etag.replace(/^W\//, '');
  return header
    .split(',')
    .map((candidate) => candidate.trim().replace(/^W\//, ''))
    .some((candidate) => candidate === '*' || candidate === bare);
};

/**
 * Whether the client already holds this representation.
 *
 * Both validators are honoured, in RFC 9110's order: §13.1.3 says a recipient **ignores**
 * `If-Modified-Since` when `If-None-Match` is present, because the entity tag is the stronger
 * statement and a client that sent both meant the tag. The date comparison is second-granular on
 * purpose — `file.lastModified` is the `toUTCString()` this server handed out, so parsing it back
 * compares like with like instead of comparing a millisecond mtime against a header that cannot
 * carry one. Sending `Last-Modified` and never reading `If-Modified-Since` would be an invitation
 * to a conditional request this server always answers with the whole file (round 2, nit 4).
 */
const isFresh = (request: FastifyRequest, file: BundleFile): boolean => {
  const ifNoneMatch = request.headers['if-none-match'];
  if (ifNoneMatch !== undefined) {
    return matchesEtag(ifNoneMatch, file.etag);
  }
  const ifModifiedSince = request.headers['if-modified-since'];
  if (ifModifiedSince === undefined) {
    return false;
  }
  const since = Date.parse(ifModifiedSince);
  return !Number.isNaN(since) && Date.parse(file.lastModified) <= since;
};

const send = async (
  request: FastifyRequest,
  reply: FastifyReply,
  file: BundleFile,
  cacheControl: string,
  encoder: BundleEncoder,
): Promise<void> => {
  reply
    .header('content-type', file.contentType)
    .header('cache-control', cacheControl)
    .header('etag', file.etag)
    .header('last-modified', file.lastModified)
    // The bundle's own files, but an operator may point the root anywhere: a content type this
    // server declared is a content type the browser must not second-guess.
    .header('x-content-type-options', 'nosniff')
    // The representation depends on `accept-encoding` (`encoding.ts`), so a shared cache must key
    // on it. Set on every response, including the ones this server chose not to code and the 304s,
    // because a cache that learned the header on one response and not the next is the one that
    // hands gzip to a client that cannot read it.
    .header('vary', 'accept-encoding')
    // **The framing guard, on the only HTML this platform serves** (round 2, finding 3). This
    // origin also carries WP-15i's authenticated commands, so a page of it inside somebody else's
    // frame is one click away from a state change the user meant for a different button. Both
    // spellings: `frame-ancestors` is the one that is still specified, `X-Frame-Options` the one
    // an operator's scanner and an older engine still read.
    .header('x-frame-options', 'DENY')
    // The rest of the policy is `csp.ts`, which carries the measurement of the built bundle that
    // chose each directive — including why `'unsafe-inline'` and a nonce are *not* needed, which
    // is the opposite of what this line said in round 2. It is served on every bundle response,
    // not only the shell: a policy on an SVG opened as a top-level document is the one that stops
    // its script.
    .header('content-security-policy', CONTENT_SECURITY_POLICY);
  if (isFresh(request, file)) {
    await reply.status(304).send();
    return;
  }
  const bytes = await readFile(file.path);
  const encoded = await encoder.encode(file, bytes, request.headers['accept-encoding']);
  if (encoded === null) {
    await reply.status(200).send(bytes);
    return;
  }
  await reply.header('content-encoding', encoded.encoding).status(200).send(encoded.body);
};

/**
 * Builds the fallback, or answers `null` when there is no bundle to serve.
 *
 * `null` is the "refuse by name" case of criterion 6: the directory that is missing is logged with
 * the variable that names it, the API is untouched, and `/readyz` still reads ok — a self-hoster
 * who built the image without the web stage gets a working API and one line saying which directory
 * the browser application should have been in, rather than a process that will not start.
 */
export const createClientFallback = async (
  options: ClientFallbackOptions,
): Promise<ClientFallback | null> => {
  const realRoot = await resolveBundleRoot(options.root);
  if (realRoot === null) {
    options.logger.warn(
      { web_root: options.root, variable: 'APP_WEB_ROOT' },
      'no SPA bundle directory: this process serves the API and answers 404 for the browser application',
    );
    return null;
  }
  if ((await resolveBundleFile(realRoot, [SHELL])) === null) {
    options.logger.warn(
      { web_root: realRoot, missing: SHELL, variable: 'APP_WEB_ROOT' },
      'SPA bundle directory has no index.html: this process serves the API and answers 404 for the browser application',
    );
    return null;
  }
  const reserved = reservedFirstSegments(options.routeUrls);
  const encoder = createBundleEncoder(options.logger);
  options.logger.info({ web_root: realRoot }, 'serving the browser application from disk');

  return async (request, reply) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return false;
    }
    const segments = decodeRequestPath(pathnameOf(request.url));
    if (segments === null) {
      return false;
    }
    const first = segments[0];
    if (first !== undefined && reserved.has(first)) {
      return false;
    }
    const file = await resolveBundleFile(realRoot, segments);
    if (file !== null) {
      await send(request, reply, file, file.cacheControl, encoder);
      return true;
    }
    if (!isClientRoute(segments)) {
      return false;
    }
    const shell = await resolveBundleFile(realRoot, [SHELL]);
    if (shell === null) {
      // The bundle was there at start-up and is not now: a 404 is the honest answer, and the
      // not-found handler's body is the one every other unmatched path gets.
      return false;
    }
    await send(request, reply, shell, REVALIDATE_CACHE_CONTROL, encoder);
    return true;
  };
};
