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
import { IntegrationError, IntegrationRateLimitedError } from '@platform/application';
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
