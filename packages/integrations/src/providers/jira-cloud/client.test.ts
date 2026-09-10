/**
 * The thin client: authentication, the status → `IntegrationErrorCode` mapping, `Retry-After`, and
 * the one property that is not about HTTP at all — **no error that leaves this file carries the
 * credential**.
 */
import {
  exactSecretRedactor,
  IntegrationError,
  IntegrationRateLimitedError,
  noSecretsRedactor,
  type SecretRedactor,
} from '@platform/application';
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
  redaction: {
    readonly redactor?: SecretRedactor;
    readonly onRedaction?: (event: { readonly action: string; readonly count: number }) => void;
  } = {},
): { client: ReturnType<typeof createJiraClient>; calls: Recorded[] } => {
  const calls: Recorded[] = [];
  const client = createJiraClient({
    siteUrl: SITE,
    email: 'agentic-bot@example.test',
    apiToken: TOKEN,
    now: () => Date.parse('2026-09-02T12:05:00.000Z'),
    // Required (standing rule 31): a test that does not care still says which redactor it means.
    redactor: redaction.redactor ?? noSecretsRedactor(),
    ...(redaction.onRedaction === undefined ? {} : { onRedaction: redaction.onRedaction }),
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

/**
 * TD-012 at the transport, in both directions and on both branches.
 *
 * The redactor here knows only `PLANTED` — not the binding's own token — so nothing below can be
 * satisfied by the "no error carries the credential" property the block above asserts. What is
 * proved is that the *document* went through the redactor the client was given (standing rule 35).
 */
describe('every document that crosses the transport is redacted (TD-012)', () => {
  const PLANTED = 'FAKE-planted-binding-credential-0123456789';
  const PLACEHOLDER = '[REDACTED:integration:planted]';
  const planted = (): SecretRedactor => exactSecretRedactor([{ name: 'planted', value: PLANTED }]);

  it('redacts the request body, which Jira publishes to humans', async () => {
    const { client, calls } = clientWith(() => new Response('{}', { status: 201 }), {
      redactor: planted(),
    });
    await client.send({
      method: 'POST',
      path: 'issue/ACME-1/comment',
      action: 'add_comment',
      body: { body: { text: `the token is ${PLANTED}` } },
    });
    expect(calls[0]?.body, 'a comment is published to a ticket').not.toContain(PLANTED);
    expect(calls[0]?.body).toContain(PLACEHOLDER);
  });

  it('redacts the response body before the caller maps it', async () => {
    const { client } = clientWith(
      () =>
        new Response(JSON.stringify({ fields: { summary: `see ${PLANTED}` } }), { status: 200 }),
      { redactor: planted() },
    );
    const body = await client.send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' });
    expect(JSON.stringify(body)).not.toContain(PLANTED);
    expect(JSON.stringify(body)).toContain(PLACEHOLDER);
  });

  /**
   * The failure branch, which is the half WP-07's review found missing three times in one file —
   * and here it is also the branch with a **cut** in it: `detailOf` keeps 300 characters, so a
   * redactor running after it would have nothing but a fragment to match against.
   */
  it('redacts an error body before it is quoted and cut into the message', async () => {
    const { client } = clientWith(
      () =>
        new Response(JSON.stringify({ errorMessages: [`Basic auth failed for ${PLANTED}`] }), {
          status: 401,
        }),
      { redactor: planted() },
    );
    let caught: unknown;
    try {
      await client.send({ method: 'GET', path: 'myself', action: 'test_connection' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationError);
    expect((caught as Error).message).not.toContain(PLANTED);
    expect((caught as Error).message).toContain(PLACEHOLDER);
  });

  /**
   * The reviewer's exploit, shipped as a test.
   *
   * `redactJson` walks string **values** and leaves object **keys** alone (`redaction.ts` says
   * why), and `detailOf` interpolates every key of Jira's `ErrorCollection.errors` — which are
   * field names Jira chose. Before `detailOf` took a `redactText` of its own this body produced
   * `jira-cloud: HTTP 400: FAKE-planted-binding-credential-0123456789: is not a valid field`,
   * which falsified the module docblock's claim that every string crossing the transport is
   * redacted here (standing rules 3 and 44).
   */
  it('redacts a provider-chosen key, not only the value beside it', async () => {
    const { client } = clientWith(
      () =>
        new Response(JSON.stringify({ errors: { [PLANTED]: 'is not a valid field' } }), {
          status: 400,
        }),
      { redactor: planted() },
    );
    let caught: unknown;
    try {
      await client.send({ method: 'PUT', path: 'issue/ACME-1', body: {}, action: 'set_labels' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(IntegrationError);
    expect(
      (caught as Error).message,
      'an `errors` key is provider text on its way into an error message',
    ).not.toContain(PLANTED);
    expect((caught as Error).message).toBe(
      `jira-cloud: HTTP 400: ${PLACEHOLDER}: is not a valid field`,
    );
  });

  it('reports the count for a key it redacted, so the second pass is visible', async () => {
    const events: { action: string; count: number }[] = [];
    const { client } = clientWith(
      () =>
        new Response(JSON.stringify({ errors: { [PLANTED]: 'is not a valid field' } }), {
          status: 400,
        }),
      { redactor: planted(), onRedaction: (event) => events.push(event) },
    );
    await client
      .send({ method: 'PUT', path: 'issue/ACME-1', body: {}, action: 'set_labels' })
      .catch(() => undefined);
    expect(events, 'the document pass found nothing; the composed line found the key').toEqual([
      { action: 'set_labels', count: 1 },
    ]);
  });

  it('redacts a long error body before the 300-character cut, leaving no fragment', async () => {
    const { client } = clientWith(
      () =>
        new Response(JSON.stringify({ errorMessages: [`${'x'.repeat(290)}${PLANTED} trailing`] }), {
          status: 400,
        }),
      { redactor: planted() },
    );
    let caught: unknown;
    try {
      await client.send({ method: 'POST', path: 'issue', action: 'create_ticket' });
    } catch (error) {
      caught = error;
    }
    expect(
      (caught as Error).message,
      'the cut must not be able to leave a prefix of the credential',
    ).not.toContain(PLANTED.slice(0, 12));
  });

  it('reports the count and never the text, and stays silent when there was nothing to do', async () => {
    const events: { action: string; count: number }[] = [];
    const { client } = clientWith(
      () => new Response(JSON.stringify({ a: PLANTED, b: PLANTED }), { status: 200 }),
      { redactor: planted(), onRedaction: (event) => events.push(event) },
    );
    await client.send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' });
    expect(events).toEqual([{ action: 'read_ticket', count: 2 }]);

    const quiet: { action: string; count: number }[] = [];
    const clean = clientWith(
      () => new Response(JSON.stringify({ a: 'ordinary' }), { status: 200 }),
      {
        redactor: planted(),
        onRedaction: (event) => quiet.push(event),
      },
    );
    await clean.client.send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' });
    expect(quiet, 'a call that carried no secret is not an event').toEqual([]);
  });
});
