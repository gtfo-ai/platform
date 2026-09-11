/**
 * The thin HTTP client under the Slack adapter.
 *
 * Three properties are load-bearing, each asserted by a test rather than promised here, and the
 * first one is why this module exists at all rather than `@slack/web-api` (Q42):
 *
 *  1. **This client does not retry.** `WebClient` retries a failed call "up to 10 times, spaced
 *     out over about 30 minutes" by default and waits out a 429 itself
 *     (<https://docs.slack.dev/tools/node-slack-sdk/web-api/>, retrieved 2026-09-10) — a second
 *     backoff loop on a wall clock, beside the one `IntegrationActionExecutor` owns on an injected
 *     timer. Here a 429 becomes an `IntegrationRateLimitedError` carrying Slack's own
 *     `Retry-After` (documented in seconds) converted to milliseconds, and the executor decides.
 *  2. **`fetch` is injected.** Production passes `globalThis.fetch`; the contract runner passes a
 *     transport that replays recorded fixtures, so replay needs no HTTP interception library and a
 *     test can assert that a shadow-mode call issued *zero* requests.
 *  3. **No error this module builds carries a credential.** The token travels in an
 *     `Authorization` header and never appears in a message; the message holds the method, the
 *     status and Slack's own error slug, truncated. A transport failure keeps the original on
 *     `cause`, and what *that* carries is the injected `fetch`'s business — TD-012's
 *     `redactErrorInPlace` is the line that walks a cause chain (standing rule 13).
 *  4. **Every document that crosses this transport is redacted here, once, before anything reads
 *     it** (TD-012, and standing rule 31 for why the redactor is required rather than optional).
 *     Both directions, because Slack is the one provider whose *request* is an emission: the text
 *     and the Block Kit the platform posts are published to a channel full of humans. The response
 *     pass is above the `ok` test, so the failure branch — which quotes Slack's `error` slug into
 *     an error message — is covered by the same line as the success branch.
 *
 * ## Slack answers 200 for most failures
 *
 * > Slack answers `200 { ok: false, error: "channel_not_found" }` rather than a 4xx, so the
 * > adapter maps the *error string*, not the status
 *
 * — the `CommunicationPort` docblock, and it is the whole reason `SLACK_ERRORS` exists. Posting
 * into the void would make a lost notification look delivered.
 *
 * Sources, all retrieved 2026-09-10:
 * <https://docs.slack.dev/reference/methods/chat.postMessage>,
 * <https://docs.slack.dev/reference/methods/chat.update>,
 * <https://docs.slack.dev/reference/methods/auth.test>,
 * <https://docs.slack.dev/reference/methods/users.info>,
 * <https://docs.slack.dev/reference/methods/users.lookupByEmail>,
 * <https://docs.slack.dev/reference/methods/apps.connections.open>,
 * <https://docs.slack.dev/apis/web-api/rate-limits>.
 */
import {
  IntegrationError,
  type IntegrationErrorCode,
  IntegrationRateLimitedError,
  type SecretRedactor,
} from '@platform/application';
import type { JsonObject } from '@platform/contracts';

export const SLACK_PROVIDER_ID = 'slack';

/**
 * The subset of `fetch` this client uses. Structural on purpose: `globalThis.fetch` satisfies it,
 * and so does a replay transport that never opens a socket.
 */
export type SlackFetch = (url: string, init: SlackRequestInit) => Promise<Response>;

export interface SlackRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface SlackHttpOptions {
  readonly baseUrl: string;
  /** `xoxb-…`. Never logged, never put in an error (BD-002). */
  readonly token: string;
  readonly fetchImpl: SlackFetch;
  /** 0 disables the per-request timeout. */
  readonly timeoutMs: number;
  /**
   * TD-012, **required** (standing rule 31). See property 4: the two places redaction happens for
   * everything that crosses this transport in either direction.
   */
  readonly redactor: SecretRedactor;
  /** Where the redaction count for one call is reported. The redacted text is never reported. */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
}

export interface SlackRequestSpec {
  /** Web API method name: `chat.postMessage`, `auth.test`. */
  readonly method: string;
  /** The port method this call serves, recorded on any error (`post_question`, …). */
  readonly action: string;
  readonly body: Readonly<Record<string, unknown>>;
  /**
   * `json` for the methods documented to accept `application/json` — the ones that carry
   * `blocks`. Everything else goes as `application/x-www-form-urlencoded`, which every Web API
   * method accepts.
   */
  readonly encoding: 'json' | 'form';
  /**
   * Overrides the bot token for this one call. `apps.connections.open` is authenticated with the
   * **app-level** token and nothing else is.
   */
  readonly token?: string;
  /**
   * Slack error slugs that are an answer rather than a failure, mapped to `null`.
   *
   * "No such user" is what `resolveIdentity` returns `null` for rather than throwing about, and
   * Slack spells it **two** ways: `client.ts` passes `users_not_found` for
   * `users.lookupByEmail` and `['user_not_found', 'users_not_found']` for `users.info`. This
   * docblock claimed `users_not_found` was "the only one the adapter uses" while the second call
   * site said otherwise — the same standing rule 63 defect as the two the redaction round left
   * behind, found by the sweep for them. The call sites are the truth; a count of them does not
   * belong in the type they are passed to.
   */
  readonly nullOnError?: readonly string[];
}

/**
 * Slack's documented error slugs, mapped onto the platform's action-shaped codes.
 *
 * The lists are transcribed from the method reference pages above. Three judgements worth naming:
 *
 *  - **`not_in_channel` is `forbidden`, not `not_found`.** The channel exists and the operator's
 *    fix is `/invite @agentic`, which is a different action from "fix the channel id". The port's
 *    docblock names only the `channel_not_found` case, so this is written down in the adapter's
 *    divergence register rather than assumed.
 *  - **`is_archived` is `forbidden`** for the same reason: the conversation exists.
 *  - **an unknown slug is `invalid_request`, which is *not* retryable.** Slack adds error slugs;
 *    retrying a failure nobody has classified risks a second message in a channel, and the
 *    executor retries exactly the two codes it is told to. Fail closed on a mutation (standing
 *    rule 20) — the inbound direction, where the same rule points the other way, is `inbound.ts`.
 */
const SLACK_ERRORS: Readonly<Record<string, IntegrationErrorCode>> = {
  // Not there.
  channel_not_found: 'not_found',
  message_not_found: 'not_found',
  thread_not_found: 'not_found',
  user_not_found: 'not_found',
  users_not_found: 'not_found',
  // Authentication.
  invalid_auth: 'unauthorised',
  not_authed: 'unauthorised',
  token_revoked: 'unauthorised',
  token_expired: 'unauthorised',
  account_inactive: 'unauthorised',
  not_allowed_token_type: 'unauthorised',
  // Authorisation.
  missing_scope: 'forbidden',
  no_permission: 'forbidden',
  access_denied: 'forbidden',
  restricted_action: 'forbidden',
  not_in_channel: 'forbidden',
  is_archived: 'forbidden',
  cant_update_message: 'forbidden',
  user_not_visible: 'forbidden',
  ekm_access_denied: 'forbidden',
  enterprise_is_restricted: 'forbidden',
  forbidden_team: 'forbidden',
  team_access_not_granted: 'forbidden',
  // Quota.
  ratelimited: 'rate_limited',
  rate_limited: 'rate_limited',
  accesslimited: 'rate_limited',
  // The request was wrong.
  invalid_blocks: 'invalid_request',
  invalid_blocks_format: 'invalid_request',
  msg_too_long: 'invalid_request',
  no_text: 'invalid_request',
  too_many_attachments: 'invalid_request',
  message_limit_exceeded: 'invalid_request',
  edit_window_closed: 'invalid_request',
  invalid_arguments: 'invalid_request',
  invalid_arg_name: 'invalid_request',
  invalid_array_arg: 'invalid_request',
  invalid_charset: 'invalid_request',
  invalid_form_data: 'invalid_request',
  invalid_post_type: 'invalid_request',
  missing_post_type: 'invalid_request',
  missing_args: 'invalid_request',
  deprecated_endpoint: 'invalid_request',
  method_deprecated: 'invalid_request',
  // Slack's problem.
  fatal_error: 'unavailable',
  internal_error: 'unavailable',
  service_unavailable: 'unavailable',
  request_timeout: 'unavailable',
};

/** An error slug is provider text (BD-022): bounded and quoted, never interpolated raw. */
const quoteSlug = (value: unknown): string => JSON.stringify(String(value).slice(0, 64));

export const codeForSlackError = (slug: string): IntegrationErrorCode =>
  SLACK_ERRORS[slug] ?? 'invalid_request';

const codeForStatus = (status: number): IntegrationErrorCode => {
  if (status === 401) {
    return 'unauthorised';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 404) {
    return 'not_found';
  }
  return status >= 500 ? 'unavailable' : 'invalid_request';
};

/**
 * `Retry-After` in milliseconds, or `null` when Slack sent nothing usable.
 *
 * Documented in seconds ("the number of seconds until you can retry"). The HTTP-date form is legal
 * by RFC 9110 and Slack does not document sending one, so it is parsed too — relative to a clock
 * the caller supplies, because this module has none.
 */
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

/** Slack's form encoding: every value a string, `undefined` dropped, arrays JSON-encoded. */
export const encodeForm = (body: Readonly<Record<string, unknown>>): string => {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(body)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.set(name, typeof value === 'string' ? value : JSON.stringify(value));
  }
  return params.toString();
};

export interface SlackHttp {
  /** The parsed body of a successful call, or `null` for a slug in `nullOnError`. */
  call(spec: SlackRequestSpec): Promise<unknown>;
}

export const createSlackHttp = (options: SlackHttpOptions): SlackHttp => ({
  call: async (spec) => {
    /**
     * Property 4, outbound half. A Slack message is the one provider call the platform makes whose
     * *request* is published to humans, so the request document is redacted here as well as the
     * response — and at the transport rather than in the three port methods that build one, so
     * there is no unredacted twin for a fourth to forget.
     *
     * The provider redacts the message body **before** it renders and caps it (`provider.ts`), so
     * a secret straddling a Block Kit limit cannot survive as a cut fragment. This pass is what
     * covers everything else a body carries, and it is idempotent: a value the first pass replaced
     * is a placeholder by the time this one looks.
     */
    const outbound = options.redactor.redactJson({ body: spec.body } as unknown as JsonObject);
    if (outbound.count > 0) {
      options.onRedaction?.({ action: spec.action, count: outbound.count });
    }
    const requestBody = (outbound.value as { body: Readonly<Record<string, unknown>> }).body;
    const token = spec.token ?? options.token;
    const headers: Record<string, string> = {
      accept: 'application/json',
      authorization: `Bearer ${token}`,
      'content-type':
        spec.encoding === 'json'
          ? 'application/json; charset=utf-8'
          : 'application/x-www-form-urlencoded; charset=utf-8',
    };
    const init: SlackRequestInit = {
      method: 'POST',
      headers,
      body: spec.encoding === 'json' ? JSON.stringify(requestBody) : encodeForm(requestBody),
      ...(options.timeoutMs > 0 ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    };

    let response: Response;
    try {
      response = await options.fetchImpl(`${options.baseUrl}/${spec.method}`, init);
    } catch (error) {
      throw new IntegrationError(
        'unavailable',
        SLACK_PROVIDER_ID,
        `${spec.method} could not be reached`,
        { action: spec.action, cause: error },
      );
    }

    if (response.status === 429) {
      throw new IntegrationRateLimitedError(SLACK_PROVIDER_ID, `${spec.method} was rate limited`, {
        action: spec.action,
        retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), Date.now()),
      });
    }
    const text = await response.text();
    if (response.status < 200 || response.status >= 300) {
      // The body is deliberately absent from the message: a Slack error body echoes the request.
      throw new IntegrationError(
        codeForStatus(response.status),
        SLACK_PROVIDER_ID,
        `${spec.method} answered ${response.status}`,
        { action: spec.action },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch (error) {
      throw new IntegrationError(
        'invalid_response',
        SLACK_PROVIDER_ID,
        `${spec.method} did not answer JSON`,
        { action: spec.action, cause: error },
      );
    }

    /**
     * Property 4, inbound half: one redaction pass over the whole document, before **any** branch
     * reads it — which is why it sits above the `ok` test rather than beside the `return`.
     *
     * WP-07's review found redaction on a success path and missing on the failure path three times
     * in one file, and this transport has exactly that shape: the failure branch quotes Slack's own
     * `error` slug into an `IntegrationError` message that becomes a log line and an
     * `integration_actions` row. Redacting the parsed document rather than the raw text is what
     * makes the two branches share one guarantee — and it survives JSON escaping, where a pass over
     * the response text would miss a secret Slack had escaped.
     */
    const inbound = options.redactor.redactJson({ body: parsed } as unknown as JsonObject);
    if (inbound.count > 0) {
      options.onRedaction?.({ action: spec.action, count: inbound.count });
    }
    const document = (inbound.value as { body: unknown }).body;

    const envelope = document as { ok?: unknown; error?: unknown };
    if (envelope?.ok === true) {
      return document;
    }
    // `ok` missing or not `true` — both are "this did not work", and a body with no `ok` at all is
    // not a Slack response. Neither may be read as success.
    const slug = typeof envelope?.error === 'string' ? envelope.error : '';
    if (slug !== '' && spec.nullOnError?.includes(slug) === true) {
      return null;
    }
    const code = codeForSlackError(slug);
    if (code === 'rate_limited') {
      throw new IntegrationRateLimitedError(
        SLACK_PROVIDER_ID,
        `${spec.method} answered ${quoteSlug(slug)}`,
        { action: spec.action, retryAfterMs: null },
      );
    }
    throw new IntegrationError(
      code,
      SLACK_PROVIDER_ID,
      slug === ''
        ? `${spec.method} answered a body that is not a Slack response`
        : `${spec.method} answered ${quoteSlug(slug)}`,
      { action: spec.action },
    );
  },
});
