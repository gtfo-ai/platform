/**
 * The thin client: Slack's "200 with `ok: false`" convention, its 429, and the two properties the
 * adapter's whole error story rests on — it never retries, and it never builds an error carrying
 * the token.
 */
import {
  exactSecretRedactor,
  IntegrationError,
  IntegrationRateLimitedError,
  noSecretsRedactor,
  type SecretRedactor,
} from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  codeForSlackError,
  createSlackHttp,
  encodeForm,
  parseRetryAfterMs,
  type SlackFetch,
  type SlackRequestInit,
} from './http.js';

/** Obviously fake, shaped like nothing Slack issues (BD-002). */
const TOKEN = 'xoxb-FAKE-bot-token-DO-NOT-USE';

/** The value the redaction cases plant in both directions. */
const PLANTED = 'FAKE-injected-secret-value-0123456789';
const PLACEHOLDER = '[REDACTED:integration:planted]';
const plantedRedactor = (): SecretRedactor =>
  exactSecretRedactor([{ name: 'planted', value: PLANTED }]);

interface Call {
  readonly url: string;
  readonly init: SlackRequestInit;
}

const httpWith = (
  responder: (call: Call) => Response,
  redactor: SecretRedactor = noSecretsRedactor(),
): {
  http: ReturnType<typeof createSlackHttp>;
  calls: Call[];
  redactions: { action: string; count: number }[];
} => {
  const calls: Call[] = [];
  const redactions: { action: string; count: number }[] = [];
  const fetchImpl: SlackFetch = async (url, init) => {
    calls.push({ url, init });
    return responder({ url, init });
  };
  return {
    calls,
    redactions,
    http: createSlackHttp({
      baseUrl: 'https://slack.example.test/api',
      token: TOKEN,
      fetchImpl,
      timeoutMs: 0,
      // Required, never defaulted (standing rule 31): a test that does not care still says which
      // redactor it means.
      redactor,
      onRedaction: (event) => {
        redactions.push({ ...event });
      },
    }),
  };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const post = { method: 'chat.postMessage', action: 'post_message', encoding: 'json' } as const;

describe('createSlackHttp', () => {
  it('sends the bearer token and the declared encoding', async () => {
    const { http, calls } = httpWith(() => json({ ok: true, channel: 'C1', ts: '1.0' }));
    await http.call({ ...post, body: { channel: 'C1', text: 'hi' } });
    await http.call({
      method: 'users.info',
      action: 'resolve_identity',
      encoding: 'form',
      body: { user: 'U1' },
    });

    expect(calls[0]?.url).toBe('https://slack.example.test/api/chat.postMessage');
    expect(calls[0]?.init.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(calls[0]?.init.headers['content-type']).toContain('application/json');
    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({ channel: 'C1', text: 'hi' });
    expect(calls[1]?.init.headers['content-type']).toContain('x-www-form-urlencoded');
    expect(calls[1]?.init.body).toBe('user=U1');
  });

  it('uses the per-request token when one is given, so the app token never leaks into a bot call', async () => {
    const { http, calls } = httpWith(() => json({ ok: true, url: 'wss://x.example.test/' }));
    await http.call({
      method: 'apps.connections.open',
      action: 'open_socket',
      encoding: 'form',
      body: {},
      token: 'xapp-FAKE-app-token-DO-NOT-USE',
    });
    expect(calls[0]?.init.headers.authorization).toBe('Bearer xapp-FAKE-app-token-DO-NOT-USE');
  });

  it('maps Slack error slugs onto action-shaped codes', async () => {
    const cases: [string, string][] = [
      ['channel_not_found', 'not_found'],
      ['message_not_found', 'not_found'],
      ['users_not_found', 'not_found'],
      ['invalid_auth', 'unauthorised'],
      ['token_revoked', 'unauthorised'],
      ['missing_scope', 'forbidden'],
      ['not_in_channel', 'forbidden'],
      ['is_archived', 'forbidden'],
      ['invalid_blocks', 'invalid_request'],
      ['msg_too_long', 'invalid_request'],
      ['fatal_error', 'unavailable'],
    ];
    for (const [slug, code] of cases) {
      const { http } = httpWith(() => json({ ok: false, error: slug }));
      await expect(http.call({ ...post, body: {} }), slug).rejects.toMatchObject({ code });
    }
    expect(codeForSlackError('channel_not_found')).toBe('not_found');
  });

  it('treats an unrecognised slug as a caller error that is never retried', async () => {
    // Fail closed on a mutation (standing rule 20): retrying a failure nobody has classified risks
    // a second message in a channel.
    const { http } = httpWith(() => json({ ok: false, error: 'a_slug_slack_added_last_week' }));
    const error = await http.call({ ...post, body: {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).code).toBe('invalid_request');
    expect((error as IntegrationError).retryable, 'an unknown failure is not retried').toBe(false);
  });

  it('refuses a body with no `ok` at all rather than reading it as success', async () => {
    const { http } = httpWith(() => json({ channel: 'C1', ts: '1.0' }));
    await expect(http.call({ ...post, body: {} })).rejects.toThrow(/not a Slack response/);
  });

  it('turns a 429 into a rate-limit error carrying Retry-After in milliseconds', async () => {
    const { http, calls } = httpWith(
      () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    );
    const error = await http.call({ ...post, body: {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntegrationRateLimitedError);
    expect((error as IntegrationRateLimitedError).retryAfterMs).toBe(30_000);
    expect((error as IntegrationRateLimitedError).retryable).toBe(true);
    // The client does not retry: backoff belongs to IntegrationActionExecutor's injected timer.
    expect(calls, 'exactly one request was made').toHaveLength(1);
  });

  it('turns a body-level ratelimited into a rate-limit error with no Retry-After', async () => {
    const { http } = httpWith(() => json({ ok: false, error: 'ratelimited' }));
    const error = await http.call({ ...post, body: {} }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(IntegrationRateLimitedError);
    expect((error as IntegrationRateLimitedError).retryAfterMs).toBeNull();
  });

  it('never puts the token in an error it builds', async () => {
    const responders: [string, () => Response][] = [
      ['a 500', () => new Response('upstream said no', { status: 500 })],
      ['an ok:false body', () => json({ ok: false, error: 'invalid_auth', token: TOKEN })],
      ['a body that is not JSON', () => new Response('<html>nope</html>', { status: 200 })],
    ];
    for (const [name, responder] of responders) {
      const { http } = httpWith(responder);
      const error = await http.call({ ...post, body: { text: TOKEN } }).catch((e: unknown) => e);
      expect(String((error as Error).message), name).not.toContain(TOKEN);
      expect(String((error as Error).stack ?? ''), name).not.toContain(TOKEN);
    }
  });

  it('bounds the provider text it echoes', async () => {
    const { http } = httpWith(() => json({ ok: false, error: 'x'.repeat(500) }));
    const error = await http.call({ ...post, body: {} }).catch((caught: unknown) => caught);
    expect((error as Error).message.length).toBeLessThan(160);
  });

  it('returns null for a slug the caller declared an answer', async () => {
    const { http } = httpWith(() => json({ ok: false, error: 'users_not_found' }));
    await expect(
      http.call({
        method: 'users.lookupByEmail',
        action: 'resolve_identity',
        encoding: 'form',
        body: { email: 'nobody@example.test' },
        nullOnError: ['users_not_found'],
      }),
    ).resolves.toBeNull();
    // …and still throws for a slug it did not declare.
    const { http: strict } = httpWith(() => json({ ok: false, error: 'missing_scope' }));
    await expect(
      strict.call({
        method: 'users.lookupByEmail',
        action: 'resolve_identity',
        encoding: 'form',
        body: {},
        nullOnError: ['users_not_found'],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('reports a transport failure as unavailable, keeping the original on cause', async () => {
    const boom = new TypeError('fetch failed');
    const http = createSlackHttp({
      baseUrl: 'https://slack.example.test/api',
      token: TOKEN,
      fetchImpl: async () => {
        throw boom;
      },
      timeoutMs: 0,
      redactor: noSecretsRedactor(),
    });
    const error = await http.call({ ...post, body: {} }).catch((caught: unknown) => caught);
    expect((error as IntegrationError).code).toBe('unavailable');
    expect((error as IntegrationError).cause).toBe(boom);
  });

  it('maps an HTTP status when Slack does not answer its own envelope', async () => {
    for (const [status, code] of [
      [401, 'unauthorised'],
      [403, 'forbidden'],
      [404, 'not_found'],
      [503, 'unavailable'],
      [418, 'invalid_request'],
    ] as const) {
      const { http } = httpWith(() => new Response('', { status }));
      await expect(http.call({ ...post, body: {} }), String(status)).rejects.toMatchObject({
        code,
      });
    }
  });
});

/**
 * Property 4, from both sides and on both branches.
 *
 * The failure branch has its own case on purpose: WP-07's review found redaction present on a
 * success path and missing on the failure path three times in one file, and this transport quotes
 * Slack's own `error` slug into an `IntegrationError` message that becomes a log line and an
 * `integration_actions` row.
 */
describe('createSlackHttp redacts every document that crosses it', () => {
  it('redacts the request body before it is encoded, in both encodings', async () => {
    const { http, calls, redactions } = httpWith(
      () => json({ ok: true, channel: 'C1', ts: '1780000000.000100' }),
      plantedRedactor(),
    );
    await http.call({ ...post, body: { channel: 'C1', text: `token=${PLANTED}` } });
    await http.call({
      method: 'users.lookupByEmail',
      action: 'resolve_identity',
      encoding: 'form',
      body: { email: `${PLANTED}@example.test` },
    });

    expect(JSON.parse(calls[0]?.init.body ?? '{}')).toEqual({
      channel: 'C1',
      text: `token=${PLACEHOLDER}`,
    });
    expect(calls[0]?.init.body).not.toContain(PLANTED);
    expect(calls[1]?.init.body).toBe(
      `email=${encodeURIComponent(`${PLACEHOLDER}@example.test`)}`.replace(/%20/g, '+'),
    );
    expect(redactions.filter((event) => event.action === 'post_message')).toEqual([
      { action: 'post_message', count: 1 },
    ]);
  });

  it('redacts the response document before the success branch reads it', async () => {
    const { http } = httpWith(
      () => json({ ok: true, channel: `C-${PLANTED}`, ts: '1780000000.000100' }),
      plantedRedactor(),
    );
    const body = (await http.call({ ...post, body: {} })) as { channel: string };
    expect(body.channel).toBe(`C-${PLACEHOLDER}`);
    expect(JSON.stringify(body)).not.toContain(PLANTED);
  });

  it("redacts the response document before the *failure* branch quotes Slack's slug", async () => {
    const { http, redactions } = httpWith(
      () => json({ ok: false, error: PLANTED }),
      plantedRedactor(),
    );
    const error = (await http
      .call({ ...post, body: {} })
      .catch((caught: unknown) => caught)) as IntegrationError;
    expect(error.code, 'an unknown slug is not retryable').toBe('invalid_request');
    expect(error.message).toContain(PLACEHOLDER);
    expect(error.message, 'the failure branch reads the same redacted document').not.toContain(
      PLANTED,
    );
    expect(redactions).toEqual([{ action: 'post_message', count: 1 }]);
  });

  it('reports nothing when there was nothing to redact', async () => {
    const { http, redactions } = httpWith(
      () => json({ ok: true, channel: 'C1', ts: '1780000000.000100' }),
      plantedRedactor(),
    );
    await http.call({ ...post, body: { channel: 'C1', text: 'hello' } });
    expect(redactions, 'a count of 0 is not an event').toEqual([]);
  });
});

describe('parseRetryAfterMs', () => {
  it('reads the documented seconds form, and an HTTP-date as a fallback', () => {
    expect(parseRetryAfterMs('30', 0)).toBe(30_000);
    expect(parseRetryAfterMs(' 0 ', 0)).toBe(0);
    expect(parseRetryAfterMs(null, 0)).toBeNull();
    expect(parseRetryAfterMs('', 0)).toBeNull();
    expect(parseRetryAfterMs('nonsense', 0)).toBeNull();
    const at = Date.parse('2026-06-01T09:00:30.000Z');
    expect(parseRetryAfterMs('Mon, 01 Jun 2026 09:00:30 GMT', at - 30_000)).toBe(30_000);
  });
});

describe('encodeForm', () => {
  it('drops absent values and JSON-encodes the rest', () => {
    expect(encodeForm({ a: 'x', b: undefined, c: null, d: 3, e: { f: 1 } })).toBe(
      'a=x&d=3&e=%7B%22f%22%3A1%7D',
    );
  });
});
