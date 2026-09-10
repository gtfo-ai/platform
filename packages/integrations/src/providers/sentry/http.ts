/**
 * The thin HTTP client under the Sentry adapter (TD-024: "small typed clients written in-repo on
 * `fetch`, covering only the endpoints the type contracts need").
 *
 * It is deliberately **not** shared with the Loki client next door. The two vendors differ in the
 * base path, the auth header set (Loki adds `X-Scope-OrgID` and may be unauthenticated at all),
 * the rate-limit signalling (Sentry publishes `X-Sentry-Rate-Limit-*` on *every* response; Loki
 * publishes nothing) and in whether a body is ever text. A single client parameterised over those
 * four differences would be a module whose divergence register describes neither provider.
 *
 * Four properties are load-bearing, and each is asserted by a test rather than promised here.
 *
 *  1. **No error this module builds carries a credential.** The token travels in an
 *     `Authorization: Bearer` header, and every `IntegrationError` constructed here holds the
 *     method, the path and the status — never the request headers, the request body or the
 *     response body. A Sentry error body is `{"detail": "…"}` and the detail can quote the request.
 *     A transport failure is re-thrown with the original on `cause`, and what an injected `fetch`
 *     puts *there* is not this module's to control — WP-07's `redactErrorInPlace` recurses into
 *     `cause` before anything is serialised (standing rule 13).
 *  2. **This client does not retry.** Backoff, `Retry-After` and the rate-limit budget belong to
 *     `IntegrationActionExecutor`, which owns the injected timer.
 *  3. **`fetch` is injected**, so replay needs no HTTP interception library, and a test can assert
 *     that a shadow-mode call issued *zero* requests.
 *  4. **Every response body is redacted here, once, before anything reads it** (TD-012, and
 *     standing rule 31 for why the redactor is required rather than optional). This is the single
 *     choke point the review asked for: `environment` read the *unredacted* `tags` while
 *     `redactedTags` sat on the next line, and `release` and `assigned_to` were never enumerated at
 *     all. With the whole document redacted at the edge there is no unredacted twin to read by
 *     mistake, and the order is fixed too — redaction strictly precedes every byte cap, so a secret
 *     straddling a cap boundary cannot survive as a cut fragment.
 *  5. **An absent, empty or whitespace-only token is a refusal, not a request** (standing rule 18,
 *     earned at WP-08 by a verifier that accepted `HMAC('', body)`). Sentry has no anonymous mode:
 *     an unauthenticated `GET /api/0/organizations/<org>/` answers 401, so sending one would turn
 *     a misconfigured binding into a network round trip whose failure reads like an expired token.
 *     The refusal happens before `fetchImpl` is called, and the contract runner asserts the
 *     request log is empty.
 *
 * Sources, retrieved 2026-09-10:
 *  - <https://docs.sentry.io/api/> — `/api/0/` paths, `Authorization: Bearer <auth_token>`.
 *  - <https://docs.sentry.io/api/ratelimits/> — "the server will respond with a 429 HTTP status
 *    code … comes with a Retry-After header", and the `X-Sentry-Rate-Limit-Limit` /
 *    `-Remaining` / `-Reset` / `-ConcurrentLimit` / `-ConcurrentRemaining` response headers, where
 *    `-Reset` is "the time when the next rate limit window begins … measured in UTC seconds from
 *    epoch".
 */
import {
  IntegrationError,
  type IntegrationErrorCode,
  IntegrationRateLimitedError,
  type SecretRedactor,
} from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import type { Clock } from '@platform/domain';

export const SENTRY_PROVIDER_ID = 'sentry';

/** The `/api/0` prefix every documented Sentry endpoint sits under. */
export const SENTRY_API_BASE = '/api/0';

/**
 * The subset of `fetch` this client uses. Deliberately structural: `globalThis.fetch` satisfies
 * it, and so does a replay transport that never opens a socket.
 */
export type SentryFetch = (url: string, init: SentryRequestInit) => Promise<Response>;

export interface SentryRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface SentryHttpOptions {
  readonly baseUrl: string;
  /** `Authorization: Bearer`. Never logged, never put in an error (BD-002). */
  readonly token: string | null;
  readonly fetchImpl: SentryFetch;
  /** 0 disables the per-request timeout. */
  readonly timeoutMs: number;
  /** TD-012, **required** (standing rule 31). See property 4: the one place redaction happens. */
  readonly redactor: SecretRedactor;
  /** Where the redaction count for one response is reported. The text is never reported. */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
  /** Injected: `X-Sentry-Rate-Limit-Reset` is an absolute instant, and a wall clock is a
   * hardware assertion (standing rule 2). */
  readonly clock: Clock;
}

export interface SentryRequestSpec {
  readonly method: 'GET' | 'PUT' | 'POST' | 'DELETE';
  /** Path below `/api/0`, already URL-encoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  readonly json?: unknown;
  /** The port method this call serves, recorded on any error (`get_issue`, …). */
  readonly action: string;
  /** 404 is an expected answer rather than a failure — the retention window on an event. */
  readonly notFoundIsNull?: boolean;
}

export interface SentryResponse<TBody> {
  readonly status: number;
  readonly body: TBody;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Sentry's documented statuses, mapped onto the platform's action-shaped codes.
 *
 * 403 deserves its note: Sentry answers 403 both for a token whose scopes are too narrow and for
 * an organization the token cannot see, so `forbidden` is what the caller can act on either way
 * and the setup guide is where the scope list lives.
 */
const STATUS_CODES: Readonly<Record<number, IntegrationErrorCode>> = {
  400: 'invalid_request',
  401: 'unauthorised',
  403: 'forbidden',
  404: 'not_found',
  409: 'conflict',
  413: 'invalid_request',
};

const codeForStatus = (status: number): IntegrationErrorCode => {
  const mapped = STATUS_CODES[status];
  if (mapped !== undefined) {
    return mapped;
  }
  return status >= 500 ? 'unavailable' : 'invalid_request';
};

/**
 * `true` when the configured token is something that could authenticate.
 *
 * Standing rule 18: "every configuration value whose empty or absent case silently produces a
 * *permissive* result is this defect". Here the permissive result would be an anonymous request.
 */
export const isUsableToken = (token: string | null | undefined): token is string =>
  typeof token === 'string' && token.trim().length > 0;

/**
 * How long to wait, in milliseconds, or `null` when Sentry sent nothing usable.
 *
 * `Retry-After` is documented in seconds. `X-Sentry-Rate-Limit-Reset` is an absolute instant in
 * UTC epoch **seconds**, so it is only meaningful against a clock — which is why this takes one
 * rather than reading `Date.now()`. A reset in the past yields 0 (retry immediately), never a
 * negative delay the executor would have to defend against.
 */
export const parseSentryRetryAfterMs = (
  headers: Readonly<Record<string, string>>,
  nowMs: number,
): number | null => {
  const retryAfter = headers['retry-after'];
  if (retryAfter !== undefined && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter.trim());
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.round(seconds * 1000);
    }
    const at = Date.parse(retryAfter);
    if (!Number.isNaN(at)) {
      return Math.max(0, at - nowMs);
    }
  }
  const reset = headers['x-sentry-rate-limit-reset'];
  if (reset !== undefined && reset.trim() !== '') {
    const epochSeconds = Number(reset.trim());
    if (Number.isFinite(epochSeconds) && epochSeconds >= 0) {
      return Math.max(0, Math.round(epochSeconds * 1000 - nowMs));
    }
  }
  return null;
};

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
};

const buildUrl = (baseUrl: string, spec: SentryRequestSpec): string => {
  const query = Object.entries(spec.query ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${baseUrl}${SENTRY_API_BASE}${spec.path}${query === '' ? '' : `?${query}`}`;
};

export interface SentryHttp {
  /** JSON request. `notFoundIsNull` turns a 404 into `null` instead of an error. */
  request<TBody = unknown>(spec: SentryRequestSpec): Promise<SentryResponse<TBody> | null>;
}

export const createSentryHttp = (options: SentryHttpOptions): SentryHttp => {
  const request = async <TBody>(spec: SentryRequestSpec): Promise<SentryResponse<TBody> | null> => {
    if (!isUsableToken(options.token)) {
      // Rule 18. Before `fetchImpl`, so the request log stays empty and the contract runner can
      // assert positively that nothing was sent.
      throw new IntegrationError(
        'unauthorised',
        SENTRY_PROVIDER_ID,
        'no auth token is configured for this binding; set the secret before using it',
        { action: spec.action },
      );
    }

    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${options.token}`,
    };
    let body: string | undefined;
    if (spec.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(spec.json);
    }
    const init: SentryRequestInit = {
      method: spec.method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.timeoutMs > 0 ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    };

    let response: Response;
    try {
      response = await options.fetchImpl(buildUrl(options.baseUrl, spec), init);
    } catch (error) {
      throw new IntegrationError(
        'unavailable',
        SENTRY_PROVIDER_ID,
        `${spec.method} ${spec.path} could not be reached`,
        { action: spec.action, cause: error },
      );
    }

    if (response.status === 404 && spec.notFoundIsNull === true) {
      return null;
    }
    const text = await response.text();
    const responseHeaders = headersToRecord(response.headers);
    if (response.status === 429) {
      throw new IntegrationRateLimitedError(
        SENTRY_PROVIDER_ID,
        `${spec.method} ${spec.path} was rate limited`,
        {
          action: spec.action,
          retryAfterMs: parseSentryRetryAfterMs(responseHeaders, Date.parse(options.clock.now())),
        },
      );
    }
    if (response.status < 200 || response.status >= 300) {
      // The body is deliberately absent from the message: Sentry's `{"detail": …}` quotes the
      // request, and the request carried a token.
      throw new IntegrationError(
        codeForStatus(response.status),
        SENTRY_PROVIDER_ID,
        `${spec.method} ${spec.path} answered ${response.status}`,
        { action: spec.action },
      );
    }

    let parsed: unknown = null;
    if (text.trim() !== '') {
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        throw new IntegrationError(
          'invalid_response',
          SENTRY_PROVIDER_ID,
          `${spec.method} ${spec.path} did not answer JSON`,
          { action: spec.action, cause: error },
        );
      }
    }
    // Property 4: one redaction pass over the whole document, at the ring's edge. Everything the
    // mapper reads below is therefore already redacted — there is no second, raw copy.
    const redacted = options.redactor.redactJson({ body: parsed } as unknown as JsonObject);
    if (redacted.count > 0) {
      options.onRedaction?.({ action: spec.action, count: redacted.count });
    }
    return {
      status: response.status,
      body: (redacted.value as { body: TBody }).body,
      headers: responseHeaders,
    };
  };

  return { request };
};
