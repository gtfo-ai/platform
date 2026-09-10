/**
 * The thin Jira Cloud REST client (TD-024: "small typed clients written in-repo on `fetch` + `ky`
 * … covering only the endpoints the type contracts need").
 *
 * It does three things and nothing else: it addresses `/rest/api/3/*`, it authenticates, and it
 * turns an HTTP outcome into the platform's typed failure vocabulary. It does **not** retry, does
 * not back off, does not log and does not validate a body — retries and rate limits belong to
 * `IntegrationActionExecutor` (which owns the injected timer, so a test never sleeps), and schema
 * validation belongs to the port boundary in `index.ts` (`parseProviderData`, BD-022).
 *
 * ## Authentication
 *
 * `Authorization: Basic base64(email:api_token)`, per
 * `https://developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/` (retrieved
 * 2026-09-10): "Build a string of the form `useremail:api_token`", "BASE64 encode the string".
 *
 * ## Why no provider error object ever leaves this file
 *
 * A thrown HTTP-client error is a credential leak with a stack trace attached: ky's `HTTPError`
 * and `TimeoutError` both carry the `Request`, whose headers hold the `Authorization` line, and
 * `pino-std-serializers` copies every enumerable property of an error it is given
 * (`action-executor.ts` § "What `redactErrorInPlace` covers"). The executor's redactor can only
 * remove secrets it was *told about*, and `docs/TODO.md` records that nothing yet connects a
 * binding's secrets to it. So this client:
 *
 *  - sets `throwHttpErrors: false`, so no `HTTPError` is ever constructed;
 *  - wraps the transport call so that a network or timeout failure is re-thrown as a plain
 *    `IntegrationError` **with no `cause`**, rather than passed on;
 *  - never puts a header, a URL credential or a request object into a message.
 *
 * `client.test.ts` proves it by walking every escaping error the way pino does — own enumerable
 * properties, the `cause` chain, `AggregateError.errors` — and asserting the token appears nowhere.
 */
import { IntegrationError, IntegrationRateLimitedError } from '@platform/application';
import ky, { type KyInstance } from 'ky';
import { jiraErrorCollectionSchema, PROVIDER_ID } from './mapping.js';

export type QueryValue = string | number | boolean | undefined | null;

export interface JiraRequest {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path below `/rest/api/3/`, without a leading slash: `issue/ACME-1/comment`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, QueryValue>>;
  readonly body?: unknown;
  /** Audit/action name used in the error, so a failure says which call failed. */
  readonly action: string;
}

export interface JiraClient {
  send(request: JiraRequest): Promise<unknown>;
  /** The `Authorization` value this client sends, so a redactor can be built from it (TD-012). */
  readonly authorizationHeader: string;
}

export interface JiraClientOptions {
  /** `https://acme-example.atlassian.net`, no trailing slash required. */
  readonly siteUrl: string;
  readonly email: string;
  readonly apiToken: string;
  /** Injected in tests (fixture replay) and by a proxy-aware root. Defaults to global `fetch`. */
  readonly fetch?: typeof globalThis.fetch;
  /** Per-attempt timeout. The executor decides whether there is another attempt. */
  readonly timeoutMs?: number;
  /**
   * Epoch milliseconds, for turning a `Retry-After` **date** into a delay.
   *
   * Injected so that no path through this client reads the wall clock: a test that asserts on a
   * delay computed from `Date.now()` is asserting about the machine (standing rule 2).
   */
  readonly now?: () => number;
}

export const DEFAULT_TIMEOUT_MS = 20_000;

export const basicAuthHeader = (email: string, apiToken: string): string =>
  `Basic ${Buffer.from(`${email}:${apiToken}`, 'utf8').toString('base64')}`;

/**
 * `Retry-After` in milliseconds, or `null`.
 *
 * Documented for Jira's 429 (`.../platform/rate-limiting/`, retrieved 2026-09-10) as "seconds to
 * wait"; RFC 9110 also allows an HTTP-date, and Atlassian's gateways do send one, so both forms
 * are read. A value that is neither is `null`, which leaves the executor on its own backoff.
 */
export const retryAfterMs = (header: string | null, now: number): number | null => {
  if (header === null || header.trim().length === 0) {
    return null;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? null : Math.max(0, date - now);
};

/** One line of provider text, truncated. Untrusted (BD-022) and redacted by the executor. */
const detailOf = (status: number, body: unknown): string => {
  const parsed = jiraErrorCollectionSchema.safeParse(body);
  const messages = parsed.success
    ? [
        ...(parsed.data.errorMessages ?? []),
        ...Object.entries(parsed.data.errors ?? {}).map(
          ([field, message]) => `${field}: ${message}`,
        ),
      ]
    : [];
  const joined = messages.join('; ').replace(/\s+/g, ' ').trim();
  const detail = joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
  return detail.length === 0 ? `HTTP ${status}` : `HTTP ${status}: ${detail}`;
};

const errorFor = (
  status: number,
  action: string,
  body: unknown,
  retryAfter: number | null,
): IntegrationError => {
  const message = detailOf(status, body);
  if (status === 429) {
    return new IntegrationRateLimitedError(PROVIDER_ID, message, {
      action,
      retryAfterMs: retryAfter,
    });
  }
  if (status >= 500) {
    // "Some transient 5xx responses may include a Retry-After header, which clients should handle
    // similarly" (rate-limiting page). `retryAfterMs` lives on the rate-limited error alone, and
    // both codes mean the same thing to a caller — wait this long, then try again — so a 5xx that
    // states a delay is reported as the retryable error that can carry it.
    return retryAfter === null
      ? new IntegrationError('unavailable', PROVIDER_ID, message, { action })
      : new IntegrationRateLimitedError(PROVIDER_ID, message, { action, retryAfterMs: retryAfter });
  }
  const code = (
    {
      400: 'invalid_request',
      401: 'unauthorised',
      403: 'forbidden',
      404: 'not_found',
      405: 'invalid_request',
      409: 'conflict',
      // "a per-issue limit has been breached" (comments, links) — the world is full, not the call.
      413: 'conflict',
      422: 'invalid_request',
    } as const
  )[status];
  return new IntegrationError(code ?? 'unavailable', PROVIDER_ID, message, { action });
};

export const createJiraClient = (options: JiraClientOptions): JiraClient => {
  const authorization = basicAuthHeader(options.email, options.apiToken);
  const instance: KyInstance = ky.create({
    // ky 2 renamed `prefixUrl` to `baseUrl`, which resolves the relative input the web way:
    // a trailing slash here plus a relative path below yields `…/rest/api/3/issue/ACME-1`.
    baseUrl: `${options.siteUrl.replace(/\/+$/, '')}/rest/api/3/`,
    retry: 0,
    throwHttpErrors: false,
    timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    headers: { authorization, accept: 'application/json' },
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });

  const send = async (request: JiraRequest): Promise<unknown> => {
    const searchParams: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.query ?? {})) {
      if (value !== undefined && value !== null) {
        searchParams[name] = String(value);
      }
    }

    let response: Response;
    try {
      response = await instance(request.path, {
        method: request.method,
        searchParams,
        ...(request.body === undefined ? {} : { json: request.body }),
      });
    } catch (error) {
      // No `cause`: see the module docblock. The name is kept because "TimeoutError" and
      // "TypeError: fetch failed" are the two shapes an operator needs to tell apart.
      throw new IntegrationError(
        'unavailable',
        PROVIDER_ID,
        `${request.method} ${request.path} did not complete (${(error as Error).name})`,
        { action: request.action },
      );
    }

    const text = await response.text();
    let body: unknown;
    try {
      body = text.length === 0 ? null : JSON.parse(text);
    } catch {
      body = null;
    }

    if (!response.ok) {
      throw errorFor(
        response.status,
        request.action,
        body,
        retryAfterMs(response.headers.get('retry-after'), (options.now ?? Date.now)()),
      );
    }
    return body;
  };

  return { send, authorizationHeader: authorization };
};
