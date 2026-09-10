/**
 * The thin client: authentication, the status → `IntegrationErrorCode` mapping, `Retry-After`, and
 * the one property that is not about HTTP at all — **no error that leaves this file carries the
 * credential**.
 */
import { IntegrationError, IntegrationRateLimitedError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { basicAuthHeader, createJiraClient, retryAfterMs } from './client.js';

const TOKEN = 'FAKE-jira-api-token-0123456789';
const SITE = 'https://acme-example.atlassian.net';

interface Recorded {
  url: string;
  method: string;
  authorization: string | null;
  body: string | null;
}

const clientWith = (
  respond: (recorded: Recorded) => Response | Promise<Response>,
): { client: ReturnType<typeof createJiraClient>; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const client = createJiraClient({
    siteUrl: SITE,
    email: 'agentic-bot@example.test',
    apiToken: TOKEN,
    now: () => Date.parse('2026-09-02T12:05:00.000Z'),
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input as string, init);
      const recorded: Recorded = {
        url: request.url,
        method: request.method,
        authorization: request.headers.get('authorization'),
        body: request.method === 'GET' ? null : await request.text(),
      };
      calls.push(recorded);
      return respond(recorded);
    },
  });
  return { client, calls };
};

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

describe('basicAuthHeader', () => {
  it('matches the documented example', () => {
    // "the credentials fred:fred encode to ZnJlZDpmcmVk"
    // (developer.atlassian.com/cloud/jira/platform/basic-auth-for-rest-apis/, retrieved 2026-09-10)
    expect(basicAuthHeader('fred', 'fred')).toBe('Basic ZnJlZDpmcmVk');
  });
});

describe('retryAfterMs', () => {
  it('reads the documented seconds form', () => {
    expect(retryAfterMs('2', 0)).toBe(2000);
    expect(retryAfterMs('0', 0)).toBe(0);
  });

  it('reads an HTTP-date form against the injected clock, never the wall clock', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z');
    expect(retryAfterMs('Wed, 02 Sep 2026 12:00:30 GMT', now)).toBe(30_000);
    expect(retryAfterMs('Wed, 02 Sep 2026 11:59:00 GMT', now), 'never negative').toBe(0);
  });

  it('is null for an absent or unusable header, so the executor keeps its own backoff', () => {
    expect(retryAfterMs(null, 0)).toBeNull();
    expect(retryAfterMs('  ', 0)).toBeNull();
    expect(retryAfterMs('soon', 0)).toBeNull();
  });
});

describe('createJiraClient', () => {
  it('addresses /rest/api/3 and authenticates every request', async () => {
    const { client, calls } = clientWith(() => json(200, { ok: true }));
    await client.send({
      method: 'GET',
      path: 'issue/ACME-1',
      query: { fields: 'summary,labels', maxResults: 50, skip: undefined },
      action: 'read_ticket',
    });
    expect(calls[0]?.url).toBe(
      `${SITE}/rest/api/3/issue/ACME-1?fields=summary%2Clabels&maxResults=50`,
    );
    expect(calls[0]?.authorization).toBe(basicAuthHeader('agentic-bot@example.test', TOKEN));
  });

  it('sends a JSON body on a write', async () => {
    const { client, calls } = clientWith(() => json(201, { id: '1' }));
    await client.send({
      method: 'POST',
      path: 'issue/ACME-1/comment',
      body: { body: { type: 'doc', version: 1, content: [] } },
      action: 'add_comment',
    });
    expect(calls[0]?.body).toBe('{"body":{"type":"doc","version":1,"content":[]}}');
  });

  it('returns null for an empty body (a 204 from an edit or a transition)', async () => {
    const { client } = clientWith(() => new Response(null, { status: 204 }));
    expect(
      await client.send({ method: 'PUT', path: 'issue/ACME-1', body: {}, action: 'set_labels' }),
    ).toBeNull();
  });

  it('maps each documented status onto the code a caller can act on', async () => {
    const expected: readonly [number, string][] = [
      [400, 'invalid_request'],
      [401, 'unauthorised'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [409, 'conflict'],
      [413, 'conflict'],
      [422, 'invalid_request'],
      [500, 'unavailable'],
      [503, 'unavailable'],
    ];
    for (const [status, code] of expected) {
      const { client } = clientWith(() => json(status, { errorMessages: ['nope'] }));
      let caught: unknown;
      try {
        await client.send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' });
      } catch (error) {
        caught = error;
      }
      expect(caught, `HTTP ${status}`).toBeInstanceOf(IntegrationError);
      expect((caught as IntegrationError).code, `HTTP ${status}`).toBe(code);
      expect((caught as IntegrationError).action).toBe('read_ticket');
    }
  });

  it('carries the provider’s own message, truncated', async () => {
    const { client } = clientWith(() =>
      json(400, { errorMessages: ['Field labels cannot be set.'], errors: { labels: 'bad' } }),
    );
    await expect(
      client.send({ method: 'PUT', path: 'issue/ACME-1', body: {}, action: 'set_labels' }),
    ).rejects.toThrow('HTTP 400: Field labels cannot be set.; labels: bad');
  });

  it('turns a 429 into the rate-limited error with the provider’s delay', async () => {
    const { client } = clientWith(() =>
      json(429, { errorMessages: ['Rate limit exceeded.'] }, { 'retry-after': '2' }),
    );
    let caught: unknown;
    try {
      await client.send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationRateLimitedError);
    expect((caught as IntegrationRateLimitedError).retryAfterMs).toBe(2000);
    expect((caught as IntegrationRateLimitedError).retryable).toBe(true);
  });

  it('honours a Retry-After on a 5xx, which Atlassian says to treat the same way', async () => {
    const { client } = clientWith(() => json(503, {}, { 'retry-after': '5' }));
    let caught: unknown;
    try {
      await client.send({ method: 'GET', path: 'myself', action: 'test_connection' });
    } catch (error) {
      caught = error;
    }
    expect((caught as IntegrationRateLimitedError).retryAfterMs).toBe(5000);
  });

  it('treats a body that is not JSON as no body rather than failing differently', async () => {
    const { client } = clientWith(() => new Response('<html>gateway</html>', { status: 502 }));
    await expect(
      client.send({ method: 'GET', path: 'myself', action: 'test_connection' }),
    ).rejects.toThrow('HTTP 502');
  });

  describe('the credential never leaves', () => {
    /** Everything `pino-std-serializers` reaches, plus what `util.inspect` would print. */
    const everythingSerialisable = (error: unknown): string => {
      const seen = new Set<object>();
      const parts: string[] = [];
      const walk = (value: unknown): void => {
        if (value === null || typeof value !== 'object' || seen.has(value)) {
          return;
        }
        seen.add(value);
        const record = value as Record<string, unknown>;
        for (const key of ['message', 'stack']) {
          if (typeof record[key] === 'string') {
            parts.push(record[key] as string);
          }
        }
        walk(record.cause);
        for (const key in record) {
          const member: unknown = record[key];
          if (typeof member === 'string') {
            parts.push(member);
          } else if (member instanceof Request) {
            parts.push(member.url);
            for (const [name, header] of member.headers) {
              parts.push(`${name}: ${header}`);
            }
          } else {
            walk(member);
          }
        }
      };
      walk(error);
      return parts.join('\n');
    };

    it('drops ky’s NetworkError, which owns the Request and therefore the header', async () => {
      const { client } = clientWith(() => {
        throw new TypeError('fetch failed');
      });
      let caught: unknown;
      try {
        await client.send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' });
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(IntegrationError);
      expect((caught as IntegrationError).code).toBe('unavailable');
      expect((caught as IntegrationError).retryable).toBe(true);
      expect((caught as Error).cause, 'nothing is chained').toBeUndefined();
      expect(Object.keys(caught as object)).not.toContain('request');
      expect(everythingSerialisable(caught)).not.toContain(TOKEN);
    });

    it('names the failure kind, because "TimeoutError" and "fetch failed" need telling apart', async () => {
      const { client } = clientWith(() => {
        throw new TypeError('fetch failed');
      });
      await expect(
        client.send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' }),
      ).rejects.toThrow('GET issue/ACME-1 did not complete');
    });
  });
});
