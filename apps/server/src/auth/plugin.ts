/**
 * Mounting Better Auth on Fastify, plus the two hooks every authenticated route depends on.
 *
 * Better Auth speaks the Web `Request`/`Response` types; Fastify speaks Node's. The bridge is
 * mechanical and its three sharp edges are all here:
 *
 * 1. **The body must reach Better Auth unparsed.** Fastify's JSON parser would hand it an object,
 *    and re-serialising that object is not the same bytes. A raw-string content-type parser is
 *    registered *inside this plugin*, so it applies to the auth mount and to nothing else —
 *    Fastify scopes content-type parsers to the plugin instance that adds them.
 * 2. **`Set-Cookie` is not one header.** `Headers.forEach` joins repeated headers with `", "`,
 *    which produces one corrupt cookie out of two good ones. `getSetCookie()` returns them as a
 *    list and Fastify writes a list as repeated headers.
 * 3. **CSRF is ours to enforce on our own routes.** Better Auth checks the origin on its endpoints;
 *    every *other* mutating endpoint is protected here, by TD-022's rule: SameSite=Lax on the
 *    cookie, plus an `Origin` that must match a trusted origin, plus a custom header that a form
 *    post or an `<img>` cannot set.
 */
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyPluginAsync, FastifyRequest } from 'fastify';
import fastifyPlugin from 'fastify-plugin';
import { ForbiddenError, UnauthorizedError } from '../errors.js';
import type { Database } from '../queries/identity-queries.js';
import { findUserById } from '../queries/identity-queries.js';
import type { Auth } from './better-auth.js';
import type { Actor } from './rbac.js';

/** Methods that cannot change state, so they need no CSRF defence. */
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The header a browser will not attach to a cross-site form post or image load, and which a
 * `fetch` from our own SPA sets deliberately. TD-022 calls it "custom header on mutations".
 */
export const CSRF_HEADER = 'x-requested-with';
export const CSRF_HEADER_VALUE = 'XMLHttpRequest';

export interface AuthPluginOptions {
  readonly auth: Auth;
  readonly database: Database;
  /** `APP_BASE_URL`. Normalised to an origin here, so a trailing slash cannot 403 every mutation. */
  readonly baseUrl: string;
  /** `APP_TRUST_PROXY`. Decides whether `X-Forwarded-For` is believed; see `toWebRequest`. */
  readonly trustProxy: boolean;
}

/**
 * Decides whether a mutating request may proceed.
 *
 * Exported and pure so the rule can be tested without a server: reverting either half of it must
 * fail a test, which is the only thing that makes the guard evidence rather than a comment.
 */
export const csrfViolation = (input: {
  readonly method: string;
  readonly origin: string | undefined;
  readonly requestedWith: string | undefined;
  readonly hasSessionCookie: boolean;
  readonly trustedOrigins: readonly string[];
}): string | null => {
  if (SAFE_METHODS.has(input.method.toUpperCase())) {
    return null;
  }
  // A request with no cookie cannot be a cross-site *authenticated* request: there is nothing for
  // the browser to attach. It is either anonymous (and will fail authorisation) or a bearer client.
  if (!input.hasSessionCookie) {
    return null;
  }
  if (input.origin === undefined || !input.trustedOrigins.includes(input.origin)) {
    return `Origin ${input.origin ?? '(absent)'} is not a trusted origin`;
  }
  if (input.requestedWith !== CSRF_HEADER_VALUE) {
    return `the ${CSRF_HEADER} header is required on mutating requests`;
  }
  return null;
};

/**
 * Fastify request -> Web `Request`, with the client address decided by this deployment rather than
 * by the caller.
 *
 * Better Auth reads the client IP out of `x-forwarded-for` (and stores it on the session, and keys
 * its login rate limit on it). Passing the raw headers through therefore handed an attacker both:
 * a rotating `X-Forwarded-For` gave every sign-in attempt its own rate-limit bucket, so twelve
 * failures produced no 429, and it wrote an address of the attacker's choosing into
 * `sessions.ip_address`, which is meant to be evidence. With no such header at all, every login in
 * the instance shared one bucket and three failures locked everybody out.
 *
 * Fastify's `request.ip` is exactly the right value: it is the socket address when
 * `APP_TRUST_PROXY` is false, and the proxy-resolved client address when it is true. So the header
 * is *overwritten* with it — never merely trusted — and the other forwarding headers a proxy or a
 * CDN might set are dropped when the deployment does not sit behind one.
 */
export const FORWARDING_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'x-client-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'forwarded',
] as const;

export const applyClientAddress = (
  headers: Headers,
  clientIp: string,
  trustProxy: boolean,
): Headers => {
  if (!trustProxy) {
    for (const header of FORWARDING_HEADERS) {
      headers.delete(header);
    }
  }
  // Set last, and unconditionally: `request.ip` already *is* the answer to "who is the client,
  // given this deployment's proxy configuration".
  headers.set('x-forwarded-for', clientIp);
  return headers;
};

const toWebRequest = (request: FastifyRequest, baseUrl: string, trustProxy: boolean): Request => {
  const url = new URL(request.url, baseUrl);
  const headers = applyClientAddress(fromNodeHeaders(request.raw.headers), request.ip, trustProxy);
  const method = request.method.toUpperCase();
  const body = typeof request.body === 'string' ? request.body : undefined;
  return new Request(url, {
    method,
    headers,
    ...(method === 'GET' || method === 'HEAD' || body === undefined ? {} : { body }),
  });
};

const plugin: FastifyPluginAsync<AuthPluginOptions> = async (
  app: FastifyInstance,
  options: AuthPluginOptions,
) => {
  // `new URL(...).origin` drops a trailing slash, a default port and any path. An exact string
  // comparison against a raw `APP_BASE_URL` meant that `http://localhost:8080/` — which is what a
  // browser's address bar and most copy-pastes produce — matched no `Origin` header ever sent, and
  // 403'd every mutating request in the instance.
  const origin = new URL(options.baseUrl).origin;
  const trustedOrigins = [origin];

  /**
   * Resolves the session on every request, so a route only has to declare the permission it needs.
   *
   * The **role comes from the `users` row**, not from the session's cached copy: a role changed by
   * an administrator has to bite the next request, not the next sign-in. The extra read is a
   * primary-key lookup on a table with one row per human.
   */
  app.addHook('onRequest', async (request) => {
    const session = await options.auth.api
      .getSession({ headers: fromNodeHeaders(request.raw.headers) })
      .catch(() => null);
    if (session === null) {
      return;
    }
    const user = await findUserById(options.database, session.user.id);
    if (user === null || user.banned || user.status === 'disabled') {
      // The session exists but the account behind it may not act. Leaving `actor` unset makes
      // every guarded route answer 401, which is what a revoked account should look like.
      return;
    }
    const actor: Actor = {
      userId: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      sessionId: session.session.id,
    };
    request.actor = actor;
  });

  /**
   * TD-022's CSRF rule, applied to every route in the application except Better Auth's own.
   *
   * **The e2e tier cannot exercise the other half of this.** `@better-auth/core`'s `isTest()` sets
   * `skipOriginCheck = true`, so every request to `/api/auth/*` in a Vitest process bypasses Better
   * Auth's own origin check. The green e2e tests are therefore evidence about *this* hook and about
   * the routes it guards — nothing more. Verifying Better Auth's own check needs an instance
   * started outside a test runner; it was done by hand at WP-06's review (evil Origin 403, absent
   * Origin 403, `text/plain` 415, cross-origin `admin/create-user` / `set-role` / `sign-out` all
   * 403, no wildcard matching), and it has to be redone by hand whenever this mount changes.
   */
  app.addHook('onRequest', async (request) => {
    if (request.url.startsWith('/api/auth/')) {
      return;
    }
    const violation = csrfViolation({
      method: request.method,
      origin: request.headers.origin,
      requestedWith: request.headers[CSRF_HEADER] as string | undefined,
      hasSessionCookie: request.headers.cookie !== undefined,
      trustedOrigins,
    });
    if (violation !== null) {
      throw new ForbiddenError(
        `${request.method} ${request.url}`,
        `cross-site request: ${violation}`,
      );
    }
  });

  await app.register(async (scope) => {
    // Scoped to this child instance only — see note 1 in the module comment.
    scope.addContentTypeParser(
      ['application/json', 'application/x-www-form-urlencoded', 'text/plain'],
      { parseAs: 'string' },
      (_request, body, done) => {
        done(null, body);
      },
    );

    scope.route({
      method: ['GET', 'POST'],
      url: '/api/auth/*',
      // Better Auth documents its own OpenAPI through its `openAPI` plugin; describing its routes
      // a second time here would be a copy that drifts.
      schema: { hide: true },
      handler: async (request, reply) => {
        const response = await options.auth.handler(
          toWebRequest(request, origin, options.trustProxy),
        );
        reply.status(response.status);
        for (const [key, value] of response.headers) {
          if (key.toLowerCase() !== 'set-cookie') {
            reply.header(key, value);
          }
        }
        const cookies = response.headers.getSetCookie();
        if (cookies.length > 0) {
          reply.header('set-cookie', cookies);
        }
        return reply.send(response.body === null ? null : await response.text());
      },
    });
  });
};

/** `fastify-plugin` keeps the hooks in the parent scope; only the auth mount is encapsulated. */
export const authPlugin = fastifyPlugin(plugin, {
  fastify: '5.x',
  name: 'platform-auth',
});

/** Guard for routes that need a session but no particular permission. */
export const requireSession = async (request: FastifyRequest): Promise<Actor> => {
  if (request.actor === undefined) {
    throw new UnauthorizedError('this endpoint needs an authenticated session');
  }
  return request.actor;
};
