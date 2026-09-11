/**
 * The thin client: status mapping, `Retry-After`, pagination — and the property the whole module
 * exists to keep, which is that **no credential ever reaches an error**.
 *
 * WP-07's reviewer proved that an axios- or undici-shaped error carries `config.headers` as an own
 * enumerable property and that pino serialises exactly those. The executor scrubs what escapes it,
 * but the cheapest place to not leak a token is to never build the object that holds one. The test
 * below walks the whole error — message, own properties, and the `cause` chain — the way pino's
 * serialiser does.
 */
import {
  composeSecretRedactors,
  exactSecretRedactor,
  IntegrationError,
  IntegrationRateLimitedError,
  noSecretsRedactor,
  type SecretRedactor,
} from '@platform/application';
import { describe, expect, it } from 'vitest';
import { createGitLabHttp, encodeProjectId, type GitLabFetch, parseRetryAfterMs } from './http.js';

const TOKEN = 'FAKE-binding-api-token-DO-NOT-USE';

interface Recorded {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

const httpWith = (
  responder: (recorded: Recorded) => Response | Promise<Response>,
  redaction: {
    readonly redactor?: SecretRedactor;
    readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
  } = {},
): { http: ReturnType<typeof createGitLabHttp>; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const fetchImpl: GitLabFetch = async (url, init) => {
    const recorded = {
      url,
      method: init.method,
      headers: { ...init.headers },
      body: init.body,
    };
    calls.push(recorded);
    return responder(recorded);
  };
  return {
    calls,
    http: createGitLabHttp({
      baseUrl: 'https://gitlab.example.test',
      token: TOKEN,
      fetchImpl,
      timeoutMs: 0,
      maxPages: 3,
      // Required (standing rule 31): a test that does not care still says which redactor it means.
      redactor: redaction.redactor ?? noSecretsRedactor(),
      ...(redaction.onRedaction === undefined ? {} : { onRedaction: redaction.onRedaction }),
    }),
  };
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

/** Everything pino would serialise out of an error: message, own keys, and the whole cause chain. */
const serialiseLikePino = (error: unknown): string => {
  const parts: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current !== null && current !== undefined && typeof current === 'object') {
    if (seen.has(current)) {
      break;
    }
    seen.add(current);
    const record = current as Record<string, unknown>;
    parts.push(String(record.message ?? ''), String(record.stack ?? ''));
    for (const key of Object.keys(record)) {
      try {
        parts.push(key, JSON.stringify(record[key]) ?? String(record[key]));
      } catch {
        parts.push(key, String(record[key]));
      }
    }
    current = record.cause;
  }
  return parts.join('\n');
};

describe('createGitLabHttp — requests', () => {
  it('sends PRIVATE-TOKEN and builds the /api/v4 URL with a sorted-free query', async () => {
    const { http, calls } = httpWith(() => json(200, { ok: true }));
    await http.request({
      method: 'GET',
      path: '/projects/acme%2Fapi/pipelines',
      query: { sha: 'abc1234', per_page: 1, ignored: undefined },
      action: 'probe',
    });
    expect(calls[0]?.url).toBe(
      'https://gitlab.example.test/api/v4/projects/acme%2Fapi/pipelines?sha=abc1234&per_page=1',
    );
    expect(calls[0]?.headers['private-token']).toBe(TOKEN);
    expect(calls[0]?.headers.accept).toBe('application/json');
  });

  it('sends a JSON body with a content type only when there is one', async () => {
    const { http, calls } = httpWith(() => json(201, {}));
    await http.request({ method: 'POST', path: '/x', json: { a: 1 }, action: 'probe' });
    expect(calls[0]?.body).toBe('{"a":1}');
    expect(calls[0]?.headers['content-type']).toBe('application/json');

    await http.request({ method: 'GET', path: '/x', action: 'probe' });
    expect(calls[1]?.body).toBeUndefined();
    expect(calls[1]?.headers['content-type']).toBeUndefined();
  });

  it('encodes a namespaced project path the way GitLab documents', () => {
    expect(encodeProjectId('acme/api')).toBe('acme%2Fapi');
    expect(encodeProjectId('acme/group/api')).toBe('acme%2Fgroup%2Fapi');
  });

  it('returns null for a 404 when the caller says a 404 is an answer', async () => {
    const { http } = httpWith(() => json(404, { message: '404 Not found' }));
    expect(
      await http.request({ method: 'GET', path: '/x', action: 'probe', notFoundIsNull: true }),
    ).toBeNull();
  });

  it('reads an empty 204 body without complaining about JSON', async () => {
    const { http } = httpWith(() => new Response(null, { status: 204 }));
    const response = await http.request({ method: 'DELETE', path: '/x', action: 'probe' });
    expect(response?.status).toBe(204);
    expect(response?.body).toBeNull();
  });
});

describe('createGitLabHttp — the documented status table', () => {
  it.each([
    [400, 'invalid_request'],
    [401, 'unauthorised'],
    [403, 'forbidden'],
    [404, 'not_found'],
    [405, 'invalid_request'],
    [409, 'conflict'],
    [412, 'invalid_request'],
    [422, 'invalid_request'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ])('maps %i to %s', async (status, code) => {
    const { http } = httpWith(() => json(status, { message: 'nope' }));
    try {
      await http.request({ method: 'GET', path: '/x', action: 'probe' });
      expect.unreachable(`status ${status} must throw`);
    } catch (error) {
      expect((error as IntegrationError).code).toBe(code);
      expect((error as IntegrationError).action).toBe('probe');
    }
  });

  it('turns a transport failure into unavailable, which the executor may retry', async () => {
    const { http } = httpWith(() => {
      throw new TypeError('fetch failed');
    });
    try {
      await http.request({ method: 'GET', path: '/x', action: 'probe' });
      expect.unreachable('a transport failure must throw');
    } catch (error) {
      expect((error as IntegrationError).code).toBe('unavailable');
      expect((error as IntegrationError).retryable).toBe(true);
    }
  });

  it('turns a non-JSON 200 into invalid_response rather than undefined', async () => {
    const { http } = httpWith(() => new Response('<html>maintenance</html>', { status: 200 }));
    try {
      await http.request({ method: 'GET', path: '/x', action: 'probe' });
      expect.unreachable('a non-JSON body must throw');
    } catch (error) {
      expect((error as IntegrationError).code).toBe('invalid_response');
    }
  });
});

describe('createGitLabHttp — rate limiting', () => {
  it('raises IntegrationRateLimitedError with Retry-After converted to milliseconds', async () => {
    const { http } = httpWith(() =>
      json(429, { message: 'Retry later' }, { 'retry-after': '2', 'ratelimit-remaining': '0' }),
    );
    try {
      await http.request({ method: 'GET', path: '/x', action: 'probe' });
      expect.unreachable('a 429 must throw');
    } catch (error) {
      expect(error).toBeInstanceOf(IntegrationRateLimitedError);
      expect((error as IntegrationRateLimitedError).retryAfterMs).toBe(2000);
      expect((error as IntegrationRateLimitedError).retryable).toBe(true);
    }
  });

  it('leaves retryAfterMs null when GitLab sent no Retry-After', async () => {
    const { http } = httpWith(() => json(429, { message: 'Retry later' }));
    try {
      await http.request({ method: 'GET', path: '/x', action: 'probe' });
      expect.unreachable('a 429 must throw');
    } catch (error) {
      expect((error as IntegrationRateLimitedError).retryAfterMs).toBeNull();
    }
  });

  it('does not retry by itself — that is the executor’s timer, not a wall clock here', async () => {
    const { http, calls } = httpWith(() => json(429, {}, { 'retry-after': '1' }));
    await http.request({ method: 'GET', path: '/x', action: 'probe' }).catch(() => undefined);
    expect(calls.length, 'exactly one attempt left this module').toBe(1);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads the documented seconds form', () => {
    expect(parseRetryAfterMs('30', 0)).toBe(30_000);
    expect(parseRetryAfterMs('0', 0)).toBe(0);
  });

  it('reads an HTTP-date form relative to the caller’s clock', () => {
    const now = Date.parse('2026-06-01T08:00:00.000Z');
    expect(parseRetryAfterMs('Mon, 01 Jun 2026 08:00:30 GMT', now)).toBe(30_000);
  });

  it('never returns a negative wait for a date in the past', () => {
    const now = Date.parse('2026-06-01T08:00:00.000Z');
    expect(parseRetryAfterMs('Mon, 01 Jun 2026 07:00:00 GMT', now)).toBe(0);
  });

  it('answers null for nothing usable', () => {
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs(undefined, 0)).toBeNull();
    expect(parseRetryAfterMs('  ', 0)).toBeNull();
    expect(parseRetryAfterMs('soon', 0)).toBeNull();
  });
});

describe('createGitLabHttp — pagination', () => {
  it('follows x-next-page and concatenates the pages', async () => {
    let page = 0;
    const { http, calls } = httpWith(() => {
      page += 1;
      return page === 1
        ? json(200, [1, 2], { 'x-next-page': '2' })
        : json(200, [3], { 'x-next-page': '' });
    });
    expect(await http.paginate({ method: 'GET', path: '/x', action: 'probe' }, 2)).toEqual([
      1, 2, 3,
    ]);
    expect(calls.map((call) => new URL(call.url).search)).toEqual([
      '?per_page=2&page=1',
      '?per_page=2&page=2',
    ]);
  });

  it('stops at maxPages rather than following a provider for ever', async () => {
    const { http, calls } = httpWith(() => json(200, [1], { 'x-next-page': '99' }));
    await http.paginate({ method: 'GET', path: '/x', action: 'probe' }, 1);
    expect(calls.length, 'bounded by maxPages').toBe(3);
  });

  it('refuses a page that is not an array', async () => {
    const { http } = httpWith(() => json(200, { not: 'an array' }));
    await expect(
      http.paginate({ method: 'GET', path: '/x', action: 'probe' }, 10),
    ).rejects.toBeInstanceOf(IntegrationError);
  });
});

describe('no credential ever reaches an error (BD-002, TD-012)', () => {
  it('keeps the token out of a 401 error, even when the body echoes it', async () => {
    const { http } = httpWith(() =>
      json(401, {
        message: '401 Unauthorized',
        // A provider that quoted the request back at us is the realistic bad case.
        request: { headers: { 'PRIVATE-TOKEN': TOKEN } },
      }),
    );
    let caught: unknown;
    try {
      await http.request({ method: 'GET', path: '/projects/acme%2Fapi', action: 'probe' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationError);
    expect(
      serialiseLikePino(caught),
      'nothing pino would print may contain the token',
    ).not.toContain(TOKEN);
  });

  it('keeps the token out of a transport error and its cause chain', async () => {
    const { http } = httpWith(() => {
      // An undici-shaped error: own enumerable properties, and a cause.
      const error = new TypeError('fetch failed');
      Object.assign(error, {
        config: { headers: { 'PRIVATE-TOKEN': TOKEN } },
        cause: new Error(`connect ECONNREFUSED while sending ${TOKEN}`),
      });
      throw error;
    });
    let caught: unknown;
    try {
      await http.request({ method: 'GET', path: '/x', action: 'probe' });
    } catch (error) {
      caught = error;
    }
    // The adapter's own error is clean; whatever the transport attached to the cause is the
    // executor's to scrub (`redactErrorInPlace`), and this asserts the boundary rather than
    // pretending the adapter can fix somebody else's object.
    expect((caught as IntegrationError).message).not.toContain(TOKEN);
    for (const key of Object.keys(caught as object)) {
      expect(
        JSON.stringify((caught as Record<string, unknown>)[key]) ?? '',
        `own property ${key} must not carry the token`,
      ).not.toContain(TOKEN);
    }
  });

  it('never puts the response body in the message', async () => {
    const { http } = httpWith(() => json(422, { message: 'unprocessable: secret-looking-detail' }));
    try {
      await http.request({ method: 'GET', path: '/x', action: 'probe' });
      expect.unreachable('a 422 must throw');
    } catch (error) {
      expect((error as Error).message).toBe('gitlab: GET /x answered 422');
    }
  });
});

/**
 * Property 4 of the module docblock, at the transport rather than at a call site.
 *
 * The redactor here knows only `PLANTED`, so nothing in these tests can be discharged by the
 * `PRIVATE-TOKEN` handling that the block above asserts: what is proved is that the *document*
 * crossing this transport went through the redactor it was given, in both directions and on both
 * branches (standing rule 35 — being handed a redactor is not using one).
 */
describe('every document that crosses the transport is redacted (TD-012, property 4)', () => {
  const PLANTED = 'FAKE-planted-binding-credential-0123456789';
  const PLACEHOLDER = '[REDACTED:integration:planted]';
  const planted = (): SecretRedactor => exactSecretRedactor([{ name: 'planted', value: PLANTED }]);

  it('redacts the request document before it is serialised onto the wire', async () => {
    const { http, calls } = httpWith(() => json(201, { iid: 1 }), { redactor: planted() });
    await http.request({
      method: 'POST',
      path: '/projects/acme%2Fapi/merge_requests',
      action: 'open_merge_request',
      json: { title: 'fix', description: `see ${PLANTED} for the token` },
    });
    expect(calls[0]?.body, 'the request body is published to humans').not.toContain(PLANTED);
    expect(calls[0]?.body).toContain(PLACEHOLDER);
  });

  /**
   * The pass the *other* two cannot discharge, which is why the secret is escaped rather than
   * merely present (standing rules 9 and 41: a value bounded twice has two untestable guards).
   *
   * `\u0046` is `F`. The raw response text therefore does **not** contain the credential, so the
   * pre-parse text pass provably finds nothing; `JSON.parse` reconstitutes it, and only the pass
   * over the parsed document can catch it. Deleting that pass leaves the other two green.
   */
  it('redacts the response document, including a secret the provider JSON-escaped', async () => {
    const escaped = `\\u0046${PLANTED.slice(1)}`;
    const raw = `{"title":"a","description":"token ${escaped}"}`;
    expect(raw, 'the arbiter: the text pass cannot see this one').not.toContain(PLANTED);

    const { http } = httpWith(
      () => new Response(raw, { status: 200, headers: { 'content-type': 'application/json' } }),
      { redactor: planted() },
    );
    const response = await http.request({ method: 'GET', path: '/x', action: 'get_merge_request' });
    expect(JSON.stringify(response?.body)).not.toContain(PLANTED);
    expect(JSON.stringify(response?.body)).toContain(PLACEHOLDER);
  });

  /**
   * The pass that has to come **before** `JSON.parse`, not after it.
   *
   * V8 quotes the offending input in a parse error — `Unexpected token 'F', "FAKE-plant"… is not
   * valid JSON` — and that error is re-thrown on `cause`, which pino walks (standing rule 13). The
   * quote is a **fragment**, so an exact-match redactor applied to the message afterwards would
   * find nothing: this is the "redact before any cut" rule at the smallest scale there is.
   */
  it('redacts the response text before parsing it, so a parse error carries no fragment', async () => {
    const { http } = httpWith(
      () =>
        new Response(`${PLANTED} is not JSON`, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      { redactor: planted() },
    );
    let caught: unknown;
    try {
      await http.request({ method: 'GET', path: '/x', action: 'get_merge_request' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationError);
    const serialised = serialiseLikePino(caught);
    expect(serialised, 'the whole error, cause chain included').not.toContain(PLANTED);
    expect(
      serialised,
      'not even the first ten characters V8 quotes into a parse error',
    ).not.toContain(PLANTED.slice(0, 10));
  });

  it('redacts a text response before the caller can cut a tail out of it', async () => {
    const { http } = httpWith(
      () => new Response(`$ glab repo push https://oauth2:${PLANTED}@gitlab.example.test\nfatal\n`),
      { redactor: planted() },
    );
    const response = await http.requestText({
      method: 'GET',
      path: '/projects/acme%2Fapi/jobs/1/trace',
      action: 'get_job_log',
    });
    expect(response?.body).not.toContain(PLANTED);
    expect(response?.body).toContain(PLACEHOLDER);
  });

  /**
   * The fourth pass. `GitLabResponse.headers` leaves this module, and a header is where a webhook
   * secret really travels — `X-Gitlab-Token` *is* the secret token. The **name** is redacted too:
   * a record key is emitted text, which is the lesson `emitted-bounds.test.ts` learned from a 2 MB
   * tag name and the one `jira-cloud/client.ts` learned from an `errors` key.
   */
  it('redacts a response header value', async () => {
    const { http } = httpWith(() => json(200, { ok: true }, { 'x-echo': `bearer ${PLANTED}` }), {
      redactor: planted(),
    });
    const response = await http.request({ method: 'GET', path: '/x', action: 'get_merge_request' });
    expect(JSON.stringify(response?.headers)).not.toContain(PLANTED);
    expect(response?.headers['x-echo']).toBe(`bearer ${PLACEHOLDER}`);
  });

  /**
   * The name too — and the honest bound on what that buys, measured rather than assumed.
   *
   * `Headers` canonicalises a field name to **lower case** before this module ever sees it, so an
   * exact-match redactor can only match a secret that is itself lower case. `LOWER` below is; the
   * mixed-case `PLANTED` is not, and the second assertion pins that limitation instead of leaving
   * a docblock to imply it is covered (standing rule 3).
   */
  it('redacts a header name, as far as case-folding lets it', async () => {
    const LOWER = 'fake-planted-lowercase-credential-0123456789';
    const { http } = httpWith(
      () => json(200, { ok: true }, { [`x-${LOWER}`]: 'a', [`x-${PLANTED}`]: 'b' }),
      { redactor: exactSecretRedactor([{ name: 'planted', value: LOWER }]) },
    );
    const response = await http.request({ method: 'GET', path: '/x', action: 'get_merge_request' });
    expect(Object.keys(response?.headers ?? {}), 'a name is emitted text too').toContain(
      `x-${PLACEHOLDER}`,
    );
    expect(
      Object.keys(response?.headers ?? {}),
      'and the one it cannot match: `Headers` lower-cased the name out of exact-match range',
    ).toContain(`x-${PLANTED.toLowerCase()}`);
  });

  it('keeps the first of two header names that redact to the same string', async () => {
    // Two distinct names on the wire, one name after redaction, because both secrets share a
    // placeholder. The answer must not depend on which the server happened to send second.
    //
    // The collision is built through `composeSecretRedactors` because that is the only way left to
    // build one: `exactSecretRedactor` refuses two secrets sharing a placeholder name outright,
    // and compose cannot see across its arguments (`SecretRedactor` is two methods and no
    // inventory). That gap is not hypothetical — `composeSecretRedactors(caller, binding)` is what
    // every adapter here constructs, including this one — so this is the shape the accounting
    // below actually has to survive.
    const FIRST = 'fake-planted-lowercase-credential-0123456789';
    const SECOND = 'fake-planted-lowercase-credential-9876543210';
    const { http } = httpWith(
      () => json(200, { ok: true }, { [`x-${FIRST}`]: 'first', [`x-${SECOND}`]: 'second' }),
      {
        redactor: composeSecretRedactors(
          exactSecretRedactor([{ name: 'planted', value: FIRST }]),
          exactSecretRedactor([{ name: 'planted', value: SECOND }]),
        ),
      },
    );
    const response = await http.request({ method: 'GET', path: '/x', action: 'get_merge_request' });
    expect(
      Object.keys(response?.headers ?? {}).filter((name) => name === `x-${PLACEHOLDER}`),
      'the two names collapsed into one',
    ).toHaveLength(1);
    expect(response?.headers[`x-${PLACEHOLDER}`], 'and the first value survived').toBe('first');
  });

  it('reports the count and never the text, and stays silent when there was nothing to do', async () => {
    const events: { action: string; count: number }[] = [];
    const { http } = httpWith(() => json(200, { a: PLANTED, b: PLANTED }), {
      redactor: planted(),
      onRedaction: (event) => events.push(event),
    });
    await http.request({ method: 'GET', path: '/x', action: 'get_merge_request' });
    expect(events).toEqual([{ action: 'get_merge_request', count: 2 }]);

    const quiet: { action: string; count: number }[] = [];
    const clean = httpWith(() => json(200, { a: 'ordinary' }), {
      redactor: planted(),
      onRedaction: (event) => quiet.push(event),
    });
    await clean.http.request({ method: 'GET', path: '/x', action: 'get_merge_request' });
    expect(quiet, 'a call that carried no secret is not an event').toEqual([]);
  });
});
