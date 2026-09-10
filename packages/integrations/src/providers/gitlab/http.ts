/**
 * The thin HTTP client under the GitLab adapter (TD-024: "small typed clients written in-repo on
 * `fetch`, covering only the endpoints the type contracts need").
 *
 * Four properties are load-bearing and each is asserted by a test rather than promised here.
 *
 *  1. **No error this module *builds* carries a credential.** The token travels in a
 *     `PRIVATE-TOKEN` header, and every `IntegrationError` constructed here holds the method, the
 *     path and the status — never the request headers, the request body or the response body.
 *     WP-07's reviewer showed that an axios- or undici-shaped error carries
 *     `config.headers.Authorization` as an own enumerable property, which pino then serialises;
 *     the fix is not to build such an error in the first place.
 *
 *     The claim stops there, and deliberately (WP-09 review round 1): a transport failure is
 *     re-thrown with the original on `cause`, and **this module does not control what a `fetch`
 *     implementation puts there.** Node's undici rejects with a plain `TypeError` whose cause
 *     chain carries no headers, so the property holds for the transport the platform ships; an
 *     injected axios-shaped `fetch` would leave the token reachable through the chain. What makes
 *     that safe is not this module — it is WP-07's `redactErrorInPlace`, which recurses into
 *     `cause` before anything is serialised (standing rule 13). Two lines, and only one of them
 *     is here.
 *  2. **This client does not retry.** Backoff, `Retry-After` and the rate-limit budget belong to
 *     `IntegrationActionExecutor`, which owns the injected timer; a retry loop here would be a
 *     second, wall-clock one. A 429 is therefore translated into `IntegrationRateLimitedError`
 *     with the provider's own `Retry-After` (documented in seconds) converted to milliseconds, and
 *     thrown for the executor to act on.
 *  3. **`fetch` is injected.** Production passes `globalThis.fetch`; the contract runner passes a
 *     transport that replays recorded fixtures. That is what "contract suite in replay" means
 *     here, and it needs no HTTP interception library — see
 *     `test/contract/support/integrations/gitlab-replay.ts`.
 *  4. **Every document that crosses this transport is redacted here, once, before anything reads
 *     it** (TD-012; standing rules 31 and 35 for why the redactor is required and why being
 *     *handed* one is not the same as *using* it). Both directions, and four passes rather than
 *     one, because each covers something the others cannot:
 *
 *      - the **request** document, because an MR description, a review reply and a discussion note
 *        are published to humans and stored on the provider — the platform's own emission;
 *      - the **response text**, before `JSON.parse`, because V8 quotes the offending input in a
 *        parse error (`Unexpected token 'g', "glpat-PLANT"... is not valid JSON`) and that error
 *        travels on `cause`, which pino walks (standing rule 13). It is a **fragment**, so
 *        redacting the message afterwards would not match it — the cut has to come second;
 *      - the **response document**, after parsing, because a secret JSON-escaped by the provider
 *        is not a substring of the raw text, and because everything the adapter maps is derived
 *        from it. This pass is what puts redaction strictly *before* every cap downstream:
 *        `getJobLog`'s 1 MiB tail and `readCodeowners`'s byte bound both cut text that has already
 *        been through it, so a cut can never leave a fragment of a credential behind;
 *      - the **response headers**, name and value, because `GitLabResponse.headers` leaves this
 *        module and a header is the one place a webhook secret genuinely travels (`X-Gitlab-Token`
 *        *is* the secret token). Nothing emits them to a caller today — `paginate` reads
 *        `x-next-page` and puts it back on the wire — so this pass is the cheap half of a promise
 *        rather than a fix for a live leak, and it is the half that stays true when a later
 *        `detail` quotes a header. Names are redacted as well as values, and a name that collides
 *        with an earlier one after redaction keeps the **first** entry — the rule
 *        `loki/provider.ts` settled for the same situation, stated here because a silent overwrite
 *        would make which value survives depend on the order the server sent them in.
 *        **What the name pass cannot do**, measured in `http.test.ts` rather than assumed:
 *        `Headers` canonicalises a field name to lower case before this module sees it, so an
 *        exact-match redactor matches a secret in a *name* only when the secret is itself lower
 *        case. Values are untouched by that and are matched in full.
 *
 *     **Where each pass sits relative to the success test, corrected:** the *request* pass runs
 *     before the call, so it covers every branch. The three response passes run in `request()` and
 *     `requestText()`, which `send()` reaches **only on a 2xx** — the failure branch never gets
 *     them. That is not a gap because of what the failure branch emits: every error built here
 *     carries the method, the constant path and the status and **never a byte of the body**
 *     (property 1), which is the stronger guarantee and the one the tests assert. The claim that
 *     stood here until review round 2 — "all three sit above the success test" — was simply
 *     false, and a false sentence about a security property is worse than no sentence
 *     (standing rule 3). Jira's client is the one that genuinely redacts above its `ok` test,
 *     because its failure branch *does* quote the body.
 *
 * Sources: <https://docs.gitlab.com/api/rest/> (namespaced paths, `PRIVATE-TOKEN`),
 * <https://docs.gitlab.com/api/rest/troubleshooting/#status-codes> (the status table),
 * <https://docs.gitlab.com/administration/settings/user_and_ip_rate_limits/#response-headers>
 * (`Retry-After`, "seconds until the quota is reset"). Retrieved 2026-09-10.
 */
import {
  IntegrationError,
  type IntegrationErrorCode,
  IntegrationRateLimitedError,
  type SecretRedactor,
} from '@platform/application';
import type { JsonObject } from '@platform/contracts';

export const GITLAB_PROVIDER_ID = 'gitlab';

/**
 * The subset of `fetch` this client uses. Deliberately structural: `globalThis.fetch` satisfies
 * it, and so does a replay transport that never opens a socket.
 */
export type GitLabFetch = (url: string, init: GitLabRequestInit) => Promise<Response>;

export interface GitLabRequestInit {
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body?: string;
  readonly signal?: AbortSignal;
}

export interface GitLabHttpOptions {
  readonly baseUrl: string;
  /** `PRIVATE-TOKEN`. Never logged, never put in an error (BD-002). */
  readonly token: string;
  readonly fetchImpl: GitLabFetch;
  /** 0 disables the per-request timeout. */
  readonly timeoutMs: number;
  readonly maxPages: number;
  /**
   * TD-012, **required and never defaulted** (standing rule 31). See property 4 for the four
   * passes it performs and why each exists.
   */
  readonly redactor: SecretRedactor;
  /** Where a redaction count is reported. The redacted text is never reported (TD-012). */
  readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
}

export interface GitLabRequestSpec {
  readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path below `/api/v4`, already URL-encoded where it embeds a project path. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  readonly json?: unknown;
  /** The port method this call serves, recorded on any error (`get_merge_request`, …). */
  readonly action: string;
  /** 404 is an expected answer rather than a failure — used by "is it protected", "is there a file". */
  readonly notFoundIsNull?: boolean;
}

export interface GitLabResponse<TBody> {
  readonly status: number;
  readonly body: TBody;
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * GitLab's documented status table, mapped onto the platform's action-shaped codes.
 *
 * 404 deserves its note: GitLab documents it as "an ID for a resource couldn't be found, **or the
 * user isn't authorized to access the resource**", so a missing scope and a missing project are
 * indistinguishable from the outside. The adapter does not guess between them; `not_found` is what
 * the caller can act on either way, and the setup guide is where the scope list lives.
 */
const STATUS_CODES: Readonly<Record<number, IntegrationErrorCode>> = {
  400: 'invalid_request',
  401: 'unauthorised',
  403: 'forbidden',
  404: 'not_found',
  405: 'invalid_request',
  409: 'conflict',
  412: 'invalid_request',
  422: 'invalid_request',
};

const codeForStatus = (status: number): IntegrationErrorCode => {
  const mapped = STATUS_CODES[status];
  if (mapped !== undefined) {
    return mapped;
  }
  return status >= 500 ? 'unavailable' : 'invalid_request';
};

/**
 * `Retry-After` in milliseconds, or `null` when GitLab sent nothing usable.
 *
 * The header is documented in seconds. An HTTP-date form is legal by RFC 9110 and GitLab does not
 * document sending one, so it is parsed too rather than silently read as `NaN` seconds — but only
 * relative to a clock the caller supplies, because this module has none.
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
  if (Number.isNaN(at)) {
    return null;
  }
  return Math.max(0, at - nowMs);
};

/**
 * Property 4's fourth pass. `redact` is the transport's own `redactText`; the count it reports is
 * the caller's business, not this function's.
 *
 * A collision keeps the first entry: two header names that redact to the same string are two names
 * that both carried the same credential, and dropping the earlier one would make the answer depend
 * on the order the server sent them in.
 */
const headersToRecord = (
  headers: Headers,
  redact: (text: string) => { readonly value: string; readonly count: number },
): { readonly record: Record<string, string>; readonly count: number } => {
  const record: Record<string, string> = {};
  let count = 0;
  headers.forEach((value, key) => {
    const name = redact(key.toLowerCase());
    count += name.count;
    if (!Object.hasOwn(record, name.value)) {
      const redacted = redact(value);
      count += redacted.count;
      record[name.value] = redacted.value;
    }
  });
  // One pass, one event: the caller reports this sum, rather than an event per header, so the
  // count on the wire stays "how many replacements this pass made" like the other three.
  return { record, count };
};

const buildUrl = (baseUrl: string, spec: GitLabRequestSpec): string => {
  const query = Object.entries(spec.query ?? {})
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
  return `${baseUrl}/api/v4${spec.path}${query === '' ? '' : `?${query}`}`;
};

export interface GitLabHttp {
  /** JSON request. `notFoundIsNull` turns a 404 into `null` instead of an error. */
  request<TBody = unknown>(spec: GitLabRequestSpec): Promise<GitLabResponse<TBody> | null>;
  /** `text/plain` request, for the job trace and the raw file endpoints. */
  requestText(spec: GitLabRequestSpec): Promise<GitLabResponse<string> | null>;
  /** Follows `x-next-page` up to `maxPages`, concatenating JSON arrays. */
  paginate<TItem>(spec: GitLabRequestSpec, perPage: number): Promise<TItem[]>;
  readonly maxPages: number;
}

/** URL-encodes a project path so `acme/api` becomes the `:id` GitLab's namespaced paths want. */
export const encodeProjectId = (project: string): string => encodeURIComponent(project);

export const createGitLabHttp = (options: GitLabHttpOptions): GitLabHttp => {
  /** Reports a count, never the text (TD-012). Silent at zero, so a call that carried no secret is not an event. */
  const report = (action: string, count: number): void => {
    if (count > 0) {
      options.onRedaction?.({ action, count });
    }
  };

  /** Property 4's fourth pass, with its single count reported. */
  const redactedHeaders = (action: string, headers: Headers): Record<string, string> => {
    const outcome = headersToRecord(headers, (text) => options.redactor.redactText(text));
    report(action, outcome.count);
    return outcome.record;
  };

  const redactText = (action: string, text: string): string => {
    const outcome = options.redactor.redactText(text);
    report(action, outcome.count);
    return outcome.value;
  };

  /** Property 4 over a document of unknown shape: an array and a scalar are wrapped, as Slack does. */
  const redactDocument = (action: string, value: unknown): unknown => {
    const outcome = options.redactor.redactJson({ body: value } as unknown as JsonObject);
    report(action, outcome.count);
    return (outcome.value as { body: unknown }).body;
  };

  const send = async (
    spec: GitLabRequestSpec,
    accept: string,
  ): Promise<{ response: Response; text: string } | null> => {
    const headers: Record<string, string> = {
      accept,
      'private-token': options.token,
    };
    let body: string | undefined;
    if (spec.json !== undefined) {
      // Property 4, outbound half: the document the platform *publishes* — an MR title and
      // description, a review reply, a diff note — redacted at the transport rather than in the
      // six port methods that build one, so there is no unredacted twin for a seventh to forget.
      body = JSON.stringify(redactDocument(spec.action, spec.json));
      headers['content-type'] = 'application/json';
    }
    const init: GitLabRequestInit = {
      method: spec.method,
      headers,
      ...(body === undefined ? {} : { body }),
      ...(options.timeoutMs > 0 ? { signal: AbortSignal.timeout(options.timeoutMs) } : {}),
    };

    let response: Response;
    try {
      response = await options.fetchImpl(buildUrl(options.baseUrl, spec), init);
    } catch (error) {
      // A transport failure. `cause` keeps the original for a debugger. What it carries is the
      // injected `fetch`'s business, not this module's: undici's rejection has no headers on it,
      // and TD-012's redactor is what recurses into a `cause` that does.
      throw new IntegrationError(
        'unavailable',
        GITLAB_PROVIDER_ID,
        `${spec.method} ${spec.path} could not be reached`,
        { action: spec.action, cause: error },
      );
    }

    if (response.status === 404 && spec.notFoundIsNull === true) {
      return null;
    }
    const text = await response.text();
    if (response.status >= 200 && response.status < 300) {
      return { response, text };
    }
    if (response.status === 429) {
      throw new IntegrationRateLimitedError(
        GITLAB_PROVIDER_ID,
        `${spec.method} ${spec.path} was rate limited`,
        {
          action: spec.action,
          retryAfterMs: parseRetryAfterMs(response.headers.get('retry-after'), Date.now()),
        },
      );
    }
    // The body is deliberately absent from the message: a GitLab error body quotes the request,
    // and the request carried a token.
    throw new IntegrationError(
      codeForStatus(response.status),
      GITLAB_PROVIDER_ID,
      `${spec.method} ${spec.path} answered ${response.status}`,
      { action: spec.action },
    );
  };

  const request = async <TBody>(spec: GitLabRequestSpec): Promise<GitLabResponse<TBody> | null> => {
    const result = await send(spec, 'application/json');
    if (result === null) {
      return null;
    }
    let parsed: unknown = null;
    if (result.text.trim() !== '') {
      // Property 4, inbound half, first pass: **before** `JSON.parse`, because the parse error
      // quotes the input and is re-thrown on `cause`.
      const text = redactText(spec.action, result.text);
      try {
        parsed = JSON.parse(text) as unknown;
      } catch (error) {
        throw new IntegrationError(
          'invalid_response',
          GITLAB_PROVIDER_ID,
          `${spec.method} ${spec.path} did not answer JSON`,
          { action: spec.action, cause: error },
        );
      }
    }
    return {
      status: result.response.status,
      // Second pass: a secret the provider JSON-escaped is not a substring of the raw text.
      body: redactDocument(spec.action, parsed) as TBody,
      headers: redactedHeaders(spec.action, result.response.headers),
    };
  };

  const requestText = async (spec: GitLabRequestSpec): Promise<GitLabResponse<string> | null> => {
    const result = await send(spec, 'text/plain, */*');
    if (result === null) {
      return null;
    }
    return {
      status: result.response.status,
      // Property 4 on the text endpoints — the job trace and the raw file. It is the *only* pass
      // they get, and it runs here rather than at the caller so that it precedes the caller's cut:
      // `getJobLog` keeps a 1 MiB tail and `readCodeowners` keeps `max_codeowners_bytes`, and a
      // cut applied to unredacted text leaves the leading bytes of a credential behind.
      body: redactText(spec.action, result.text),
      headers: redactedHeaders(spec.action, result.response.headers),
    };
  };

  const paginate = async <TItem>(spec: GitLabRequestSpec, perPage: number): Promise<TItem[]> => {
    const items: TItem[] = [];
    let page: string | undefined = '1';
    for (let visited = 0; visited < options.maxPages && page !== undefined && page !== ''; ) {
      const response: GitLabResponse<TItem[]> | null = await request<TItem[]>({
        ...spec,
        query: { ...spec.query, per_page: perPage, page },
      });
      if (response === null) {
        break;
      }
      if (!Array.isArray(response.body)) {
        throw new IntegrationError(
          'invalid_response',
          GITLAB_PROVIDER_ID,
          `${spec.method} ${spec.path} answered a page that is not an array`,
          { action: spec.action },
        );
      }
      items.push(...response.body);
      visited += 1;
      page = response.headers['x-next-page'];
    }
    return items;
  };

  return { request, requestText, paginate, maxPages: options.maxPages };
};
