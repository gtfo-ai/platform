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
 *
 * ## Where redaction happens, and why it is here
 *
 * TD-012, and standing rules 31 and 35: **every string this transport carries is redacted here,
 * once, before anything reads it**, in both directions and above the `response.ok` test.
 *
 *  - The **request** body, because a workpad, a comment and a created ticket are published to
 *    humans and stored on the provider — the platform's own emission, not Jira's.
 *  - The **response** body, because everything the port emits is derived from it: a ticket's
 *    description, every comment, an epic, a sibling, a transition's status names. Until this line
 *    existed the adapter applied its redactor to `HealthProbe.detail` **only**, and a reviewer
 *    building it through the real registration read a planted credential straight out of
 *    `readTicket` — the executor does not compensate, because `action-executor.ts` redacts the
 *    audit **row**, not the value it returns to the caller.
 *  - Above `response.ok`, because the failure branch quotes Jira's own `errorMessages` into an
 *    `IntegrationError` **and cuts them to 300 characters** (`detailOf`). A cut applied to
 *    unredacted text leaves the leading bytes of a credential in the message, which is why the
 *    order is redact-then-cut and not the reverse.
 *
 * **The exception, stated because a claim of totality has to survive being tested** (standing
 * rules 3 and 44): `redactJson` walks a document's string **values** and leaves its **keys**
 * alone, deliberately and for the reason `application/src/integrations/redaction.ts` records —
 * rewriting a key can collide two fields into one, and the platform never builds a key out of
 * secret material. Jira's keys are not the platform's, and this file turns a provider-chosen key
 * into emitted text in exactly one place: `detailOf` interpolates every entry of a Jira
 * `ErrorCollection.errors`, whose keys are field names Jira chose. A reviewer sent
 * `{"errors": {"<the binding token>": "is not a valid field"}}` and read the token out of the
 * `IntegrationError` message. So `detailOf` takes a **`redactText` of its own** and runs the line
 * it composed — keys, values and separators — through it before the 300-character cut. That is the
 * same rule Loki applies to a label name (`loki/provider.ts`, `capLabelSet`): *a key that the
 * provider chose is redacted where it is emitted, by the code that emits it*. The check that
 * enforces the claim is the check that enforces the redaction — `client.test.ts` replays the
 * reviewer's body, and `providers/emitted-secrets.test.ts` walks record keys as strings of their
 * own.
 */
import {
  IntegrationError,
  IntegrationRateLimitedError,
  type SecretRedactor,
} from '@platform/application';
import type { JsonObject } from '@platform/contracts';
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
  /**
   * TD-012, **required and never defaulted** (standing rule 31). See the module docblock for the
   * two passes and why they sit above the `response.ok` test.
   *
   * It is the *composed* redactor — the caller's plus this binding's own credentials — which
   * `index.ts` builds and this client is constructed with. This interface used to publish an
   * `authorizationHeader` field instead, "so a redactor can be built from it"; nothing ever read
   * it, which is why the header is now one of the values `index.ts` puts *into* the redactor it
   * passes down here (standing rule 44: a claim nothing discharges is decoration).
   */
  readonly redactor: SecretRedactor;
  /** Where a redaction count is reported. The redacted text is never reported (TD-012). */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
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

/**
 * One line of provider text, truncated. Untrusted (BD-022).
 *
 * The body it reads has **already** been through this client's redactor (see the module docblock),
 * which is the order that matters: the 300-character cut below would otherwise leave the leading
 * bytes of a credential in an error message that becomes a log line and an `integration_actions`
 * row. It said "redacted by the executor" until WP-11's follow-up; the executor redacts the audit
 * row, not the error a caller sees.
 *
 * That earlier pass covers the `errors` **values** and not its **keys**, which are Jira's field
 * names — so the line this function composes goes through `redactText` before the cut. `redactText`
 * is exact-match and therefore idempotent: a value the transport already replaced is a placeholder
 * by the time it gets here, so the second pass costs a scan and reports nothing.
 */
const detailOf = (status: number, body: unknown, redactText: (text: string) => string): string => {
  const parsed = jiraErrorCollectionSchema.safeParse(body);
  const messages = parsed.success
    ? [
        ...(parsed.data.errorMessages ?? []),
        ...Object.entries(parsed.data.errors ?? {}).map(
          ([field, message]) => `${field}: ${message}`,
        ),
      ]
    : [];
  const joined = redactText(messages.join('; ').replace(/\s+/g, ' ').trim());
  const detail = joined.length > 300 ? `${joined.slice(0, 300)}…` : joined;
  return detail.length === 0 ? `HTTP ${status}` : `HTTP ${status}: ${detail}`;
};

const errorFor = (
  status: number,
  action: string,
  body: unknown,
  retryAfter: number | null,
  redactText: (text: string) => string,
): IntegrationError => {
  const message = detailOf(status, body, redactText);
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

  /** One pass over a document of unknown shape; the count is reported, the text never is. */
  const redact = (action: string, value: unknown): unknown => {
    const outcome = options.redactor.redactJson({ body: value } as unknown as JsonObject);
    if (outcome.count > 0) {
      options.onRedaction?.({ action, count: outcome.count });
    }
    return (outcome.value as { body: unknown }).body;
  };

  /** The same, over a string this client *composed* — the one that carries Jira's field names. */
  const redactLine = (action: string, text: string): string => {
    const outcome = options.redactor.redactText(text);
    if (outcome.count > 0) {
      options.onRedaction?.({ action, count: outcome.count });
    }
    return outcome.value;
  };

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
        // Outbound half: what the platform publishes to a Jira ticket, redacted at the transport
        // rather than in the five port methods that build a body.
        ...(request.body === undefined
          ? {}
          : { json: redact(request.action, request.body) as unknown }),
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
    let parsed: unknown;
    try {
      // A parse failure is swallowed rather than reported: a `SyntaxError` quotes the input it
      // choked on, so the message is a fragment of the body and `null` is the safe answer.
      parsed = text.length === 0 ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    // Inbound half, and **above** the `ok` test so that the failure branch — which quotes Jira's
    // `errorMessages` into an error message and cuts them at 300 characters — is covered by the
    // same line as the success branch (WP-07's review found exactly that asymmetry three times).
    const body = redact(request.action, parsed);

    if (!response.ok) {
      throw errorFor(
        response.status,
        request.action,
        body,
        retryAfterMs(response.headers.get('retry-after'), (options.now ?? Date.now)()),
        (text) => redactLine(request.action, text),
      );
    }
    return body;
  };

  return { send };
};
