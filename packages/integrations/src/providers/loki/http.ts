/**
 * The thin HTTP client under the Loki adapter (TD-024: "small typed clients written in-repo on
 * `fetch`, covering only the endpoints the type contracts need").
 *
 * It is deliberately **not** shared with the Sentry client next door, and the difference is not
 * cosmetic: Loki may be *unauthenticated*, adds a tenant header, publishes no rate-limit headers
 * at all and answers a syntax error with a `text/plain` body. A client parameterised over those
 * four differences would be a module whose divergence register described neither provider, which
 * is exactly the leak this work package was told to avoid.
 *
 * The four load-bearing properties are the same as every other adapter's, and each is asserted:
 *
 *  1. **No error this module builds carries a credential.** A Loki error body is plain text such
 *     as `parse error at line 1, col 1: syntax error: unexpected IDENTIFIER` — usually harmless,
 *     and "usually" is not a security property, since the body echoes the query and the query is
 *     built from platform input. So the message holds the method, the path and the status, and the
 *     body is dropped.
 *  2. **This client does not retry.** Backoff and the rate-limit budget belong to
 *     `IntegrationActionExecutor`, which owns the injected timer.
 *  3. **`fetch` is injected**, so replay needs no HTTP interception library.
 *  4. **An empty credential is a refusal, not an anonymous request** — but only when the binding
 *     said it authenticates (standing rule 18; see `config.ts` on why `auth_mode` is explicit).
 *  5. **Every response body is redacted here, once, before anything reads it** (TD-012, and
 *     standing rule 31 for why the redactor is required rather than optional). Downstream code
 *     therefore has no redacted/unredacted pair to choose the wrong half of — the mistake the
 *     review found at `sentry/provider.ts:323`, where `environment` read the raw `tags` while
 *     `redactedTags` sat next to it.
 *
 * Sources, retrieved 2026-09-10:
 *  - <https://grafana.com/docs/loki/latest/reference/loki-http-api/> — the `/loki/api/v1` paths and
 *    "set the `X-Scope-OrgID` header to identify the tenant you want to query".
 *  - <https://grafana.com/docs/loki/latest/query/logcli/getting-started/> — `LOKI_BEARER_TOKEN`
 *    "adds the Authorization header to API requests", `LOKI_USERNAME`/`LOKI_PASSWORD` "for HTTP
 *    basic auth", `LOKI_ORG_ID` "adds X-Scope-OrgID".
 */
import { Buffer } from 'node:buffer';
import {
  IntegrationError,
  type IntegrationErrorCode,
  IntegrationRateLimitedError,
  type SecretRedactor,
} from '@platform/application';
import type { JsonObject } from '@platform/contracts';
import type { Clock } from '@platform/domain';
import { LOKI_PROVIDER_ID } from './logql.js';

export { LOKI_PROVIDER_ID };

/** The prefix every documented query endpoint sits under. */
export const LOKI_API_BASE = '/loki/api/v1';

export type LokiFetch = (url: string, init: LokiRequestInit) => Promise<Response>;

export interface LokiRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly signal?: AbortSignal;
}

/** Resolved credentials for one binding, already checked for emptiness by `lokiAuthHeaders`. */
export interface LokiAuth {
  readonly mode: 'none' | 'bearer' | 'basic';
  readonly bearerToken: string | null;
  readonly username: string | null;
  readonly password: string | null;
  readonly tenantId: string | null;
}

export interface LokiHttpOptions {
  readonly baseUrl: string;
  readonly auth: LokiAuth;
  readonly fetchImpl: LokiFetch;
  /** 0 disables the per-request timeout. */
  readonly timeoutMs: number;
  /** Injected: a `Retry-After` in HTTP-date form is relative to now (standing rule 2). */
  readonly clock: Clock;
  /**
   * TD-012, **required** (standing rule 31) and applied here rather than field by field upstream.
   *
   * This is the single choke point property 5 names: every string the adapter can ever emit comes
   * out of `body`, so redacting the parsed document once — before a schema sees it, before any cap
   * cuts it — makes "which fields were redacted?" a question with one answer instead of a list to
   * keep in step. It also fixes the *order*: redaction strictly precedes every byte cap, so a
   * placeholder can never be cut in half and a secret straddling a cap boundary cannot survive as a
   * fragment (the review's M2/M4).
   */
  readonly redactor: SecretRedactor;
  /** Where the redaction count for one response is reported. The text is never reported (TD-012). */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
}

export interface LokiRequestSpec {
  /** Path below `/loki/api/v1`, already URL-encoded. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | undefined>>;
  /** The port method this call serves, recorded on any error (`query_range`, `labels`, …). */
  readonly action: string;
}

export interface LokiResponse<TBody> {
  readonly status: number;
  readonly body: TBody;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * Loki's HTTP API reference publishes **no status-code table**, so this mapping is stated as a
 * choice rather than a transcription. `400` is the status the page does name (for a malformed
 * timestamp on `/push`) and is what a LogQL parse error answers; the rest follow HTTP's own
 * meanings, which is the honest thing to do when the vendor documents nothing narrower.
 */
const STATUS_CODES: Readonly<Record<number, IntegrationErrorCode>> = {
  400: 'invalid_request',
  401: 'unauthorised',
  403: 'forbidden',
  404: 'not_found',
  413: 'invalid_request',
  422: 'invalid_request',
};

const codeForStatus = (status: number): IntegrationErrorCode => {
  const mapped = STATUS_CODES[status];
  if (mapped !== undefined) {
    return mapped;
  }
  return status >= 500 ? 'unavailable' : 'invalid_request';
};

const isUsable = (value: string | null): value is string =>
  typeof value === 'string' && value.trim().length > 0;

/**
 * The headers a binding's `auth_mode` implies, or a refusal.
 *
 * Standing rule 18, in the shape a product with a legitimate anonymous mode needs it: the empty
 * case is only permissive when the operator *chose* `auth_mode: none`. A `bearer` binding whose
 * token is missing, empty or whitespace refuses here — before `fetchImpl` — so the request log
 * stays empty and a test can assert that positively.
 *
 * @throws {IntegrationError} `unauthorised`.
 */
export const lokiAuthHeaders = (auth: LokiAuth, action: string): Record<string, string> => {
  const headers: Record<string, string> = {};
  if (auth.mode === 'bearer') {
    if (!isUsable(auth.bearerToken)) {
      throw new IntegrationError(
        'unauthorised',
        LOKI_PROVIDER_ID,
        'auth_mode is "bearer" but no bearer token is configured for this binding',
        { action },
      );
    }
    headers.authorization = `Bearer ${auth.bearerToken}`;
  } else if (auth.mode === 'basic') {
    if (!isUsable(auth.username) || !isUsable(auth.password)) {
      throw new IntegrationError(
        'unauthorised',
        LOKI_PROVIDER_ID,
        'auth_mode is "basic" but the username or the password is missing for this binding',
        { action },
      );
    }
    headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`, 'utf8').toString('base64')}`;
  }
  if (isUsable(auth.tenantId)) {
    headers['x-scope-orgid'] = auth.tenantId;
  }
  return headers;
};

/** `Retry-After` in milliseconds, or `null`. Loki documents no rate-limit header; if a proxy in
 * front of it sends one, honouring it costs nothing and ignoring it costs a retry storm. */
export const parseRetryAfterMs = (
  value: string | null | undefined,
  nowMs: number,
): number | null => {
  if (value === null || value === undefined || value.trim() === '') {
    return null;
  }
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
};

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key.toLowerCase()] = value;
  });
  return record;
};

const buildUrl = (baseUrl: string, spec: LokiRequestSpec): string => {
  const query = Object.entries(spec.query ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${baseUrl}${LOKI_API_BASE}${spec.path}${query === '' ? '' : `?${query}`}`;
};

export interface LokiHttp {
  request<TBody = unknown>(spec: LokiRequestSpec): Promise<LokiResponse<TBody>>;
}

export const createLokiHttp = (options: LokiHttpOptions): LokiHttp => ({
  request: async <TBody>(spec: LokiRequestSpec): Promise<LokiResponse<TBody>> => {
    const headers: Record<string, string> = {
      accept: 'application/json',
      ...lokiAuthHeaders(options.auth, spec.action),
    };
    const init: LokiRequestInit = {
      method: 'GET',
      headers,
      ...(options.timeoutMs > 0 ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    };

    let response: Response;
    try {
      response = await options.fetchImpl(buildUrl(options.baseUrl, spec), init);
    } catch (error) {
      throw new IntegrationError(
        'unavailable',
        LOKI_PROVIDER_ID,
        `GET ${spec.path} could not be reached`,
        { action: spec.action, cause: error },
      );
    }

    const text = await response.text();
    const responseHeaders = headersToRecord(response.headers);
    if (response.status === 429) {
      throw new IntegrationRateLimitedError(LOKI_PROVIDER_ID, `GET ${spec.path} was rate limited`, {
        action: spec.action,
        retryAfterMs: parseRetryAfterMs(
          responseHeaders['retry-after'],
          Date.parse(options.clock.now()),
        ),
      });
    }
    if (response.status < 200 || response.status >= 300) {
      // The body is deliberately absent: Loki echoes the query it failed to parse, and the query
      // is built by the platform.
      throw new IntegrationError(
        codeForStatus(response.status),
        LOKI_PROVIDER_ID,
        `GET ${spec.path} answered ${response.status}`,
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
          LOKI_PROVIDER_ID,
          `GET ${spec.path} did not answer JSON`,
          { action: spec.action, cause: error },
        );
      }
    }
    // Property 5: one redaction pass over the whole document, at the ring's edge. `redactJson`
    // walks string leaves only, so numbers and the nanosecond timestamp strings are untouched
    // unless they *are* a secret. Object **keys** are left alone by design (`redaction.ts`), and
    // Loki is the one provider whose keys are provider-controlled: a label *name* is redacted in
    // `capLabelSet`, the single place this adapter emits one (provider.ts, divergence 9).
    const redacted = options.redactor.redactJson({ body: parsed } as unknown as JsonObject);
    if (redacted.count > 0) {
      options.onRedaction?.({ action: spec.action, count: redacted.count });
    }
    return {
      status: response.status,
      body: (redacted.value as { body: TBody }).body,
      headers: responseHeaders,
    };
  },
});
