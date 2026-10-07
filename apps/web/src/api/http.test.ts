import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { createIntentKeys } from '../app/idempotency.js';
import {
  ApiError,
  ATTEMPT_UNKNOWN_MESSAGE,
  CSRF_HEADER,
  CSRF_HEADER_VALUE,
  createApiClient,
  IN_FLIGHT_RETRY_DELAY_MS,
  IN_FLIGHT_RETRY_LIMIT,
  isRetiredIdempotencyKey,
  NetworkError,
  PLATFORM_UPDATED_MESSAGE,
  PlatformUpdatedError,
} from './http.js';

const schema = z.strictObject({ ok: z.boolean() });

/** The exact shape of `fetch`, so `mock.calls` keeps its argument types. */
type FetchMock = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const respondWith = (body: unknown, init: ResponseInit = {}) =>
  vi.fn<FetchMock>(
    async () =>
      new Response(body === undefined ? null : JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
        ...init,
      }),
  );

/** The init of the nth call, which the assertions below always expect to exist. */
const initOf = (
  mock: { mock: { calls: [string | URL | Request, (RequestInit | undefined)?][] } },
  index: number,
): RequestInit => {
  const init = mock.mock.calls[index]?.[1];
  if (init === undefined) {
    throw new Error(`fetch call ${index} was made without an init object`);
  }
  return init;
};

describe('the API client', () => {
  it('parses a response with the published schema', async () => {
    const fetchImpl = respondWith({ ok: true });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.get('/api/thing', { schema })).resolves.toEqual({ ok: true });
  });

  /**
   * WP-154 (d), PROGRESS backlog 487: before an answer is called a schema error, the client asks
   * whether the server is a different build — and says *reload* only when it is. Never about
   * `/api/version`, which is what the question reads (a loop otherwise).
   */
  it('answers an invalid response from a different build as PlatformUpdatedError, and only then', async () => {
    const updated = createApiClient({
      fetchImpl: respondWith({ ok: 'yes' }) as unknown as typeof fetch,
      isPlatformUpdated: async () => true,
    });
    const error = await updated.get('/api/thing', { schema }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PlatformUpdatedError);
    expect((error as ApiError).code).toBe('platform_updated');
    expect(String(error)).toContain(PLATFORM_UPDATED_MESSAGE);
    expect(String(error)).not.toContain('did not match the published schema');

    const same = createApiClient({
      fetchImpl: respondWith({ ok: 'yes' }) as unknown as typeof fetch,
      isPlatformUpdated: async () => false,
    });
    const schemaError = await same.get('/api/thing', { schema }).catch((caught: unknown) => caught);
    expect((schemaError as ApiError).code).toBe('invalid_response');

    // A valid answer never asks, and `/api/version` is never asked about.
    const asked = vi.fn(async () => true);
    const valid = createApiClient({
      fetchImpl: respondWith({ ok: true }) as unknown as typeof fetch,
      isPlatformUpdated: asked,
    });
    await valid.get('/api/thing', { schema });
    const version = createApiClient({
      fetchImpl: respondWith({ ok: 'yes' }) as unknown as typeof fetch,
      isPlatformUpdated: asked,
    });
    const versionError = await version
      .get('/api/version', { schema })
      .catch((caught: unknown) => caught);
    expect((versionError as ApiError).code).toBe('invalid_response');
    expect(asked).not.toHaveBeenCalled();
  });

  it('refuses a response that does not match, rather than handing it to a component', async () => {
    const fetchImpl = respondWith({ ok: 'yes', extra: 1 });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await client.get('/api/thing', { schema }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('invalid_response');
    expect((error as ApiError).details.length).toBeGreaterThan(0);
  });

  it('builds the query string from defined values only', async () => {
    const fetchImpl = respondWith({ ok: true });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.get('/api/thing', { schema, query: { a: 1, b: undefined, c: 'x y' } });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe('/api/thing?a=1&c=x+y');
  });

  it('sends TD-022’s CSRF header and same-origin credentials on a mutation', async () => {
    const fetchImpl = respondWith({ ok: true });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await client.command('/api/thing', { schema, body: { a: 1 } });

    const init = initOf(fetchImpl, 0);
    const headers = init.headers as Record<string, string>;
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('same-origin');
    expect(headers[CSRF_HEADER]).toBe(CSRF_HEADER_VALUE);
    expect(init.body).toBe('{"a":1}');
  });

  it('adds an Idempotency-Key only when the command asks for one', async () => {
    const fetchImpl = respondWith({ ok: true });
    const client = createApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      newIdempotencyKey: () => 'fixed-key',
    });

    await client.command('/api/a', { schema, idempotent: true });
    await client.command('/api/b', { schema });

    const first = initOf(fetchImpl, 0).headers as Record<string, string>;
    const second = initOf(fetchImpl, 1).headers as Record<string, string>;
    expect(first['Idempotency-Key']).toBe('fixed-key');
    expect(second['Idempotency-Key']).toBeUndefined();
  });

  it('turns the documented problem shape into a typed error', async () => {
    const fetchImpl = respondWith(
      {
        error: {
          code: 'forbidden',
          message: 'not allowed',
          details: [{ path: 'a', message: 'b' }],
        },
      },
      { status: 403 },
    );
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = (await client
      .get('/api/thing', { schema })
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.status).toBe(403);
    expect(error.code).toBe('forbidden');
    expect(error.message).toBe('not allowed');
    expect(error.details).toEqual([{ path: 'a', message: 'b' }]);
  });

  it('never shows a body that is not the documented problem shape', async () => {
    const fetchImpl = vi.fn<FetchMock>(
      async () => new Response('<html>502 from a proxy</html>', { status: 502 }),
    );
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = (await client
      .get('/api/thing', { schema })
      .catch((caught: unknown) => caught)) as ApiError;

    expect(error.code).toBe('unexpected_response');
    expect(error.message).not.toContain('<html>');
  });

  it('reports a transport failure as a NetworkError', async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => {
      throw new TypeError('failed to fetch');
    });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    await expect(client.get('/api/thing', { schema })).rejects.toBeInstanceOf(NetworkError);
  });

  it('lets an abort stay an abort, so Query can tell it from a failure', async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => {
      throw new DOMException('aborted', 'AbortError');
    });
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });

    const error = await client.get('/api/thing', { schema }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
  });
});

/**
 * WP-67's two in-flight refusals (WP-73, PROGRESS backlog 242): one case per code, each read off
 * what the requests carried rather than off the client's answer alone.
 */
describe('a keyed command the server says is in flight or unknown', () => {
  const problem = (code: string) =>
    new Response(JSON.stringify({ error: { code, message: `server says ${code}` } }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    });
  const ok = () =>
    new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  const keysSent = (mock: ReturnType<typeof vi.fn<FetchMock>>) =>
    mock.mock.calls.map((_call, index) =>
      new Headers(initOf(mock, index).headers).get('Idempotency-Key'),
    );

  it('sends an in-flight command again under the same key until the first has answered', async () => {
    const answers = [
      problem('idempotency_key_in_flight'),
      problem('idempotency_key_in_flight'),
      ok(),
    ];
    const fetchImpl = vi.fn<FetchMock>(async () => answers.shift() ?? ok());
    const sleep = vi.fn(async () => {});
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep });

    await expect(
      client.command('/api/tasks/t/feedback', {
        schema,
        body: { text: 'x' },
        idempotencyKey: 'k-1',
      }),
    ).resolves.toEqual({ ok: true });
    expect(keysSent(fetchImpl)).toEqual(['k-1', 'k-1', 'k-1']);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(IN_FLIGHT_RETRY_DELAY_MS);
  });

  it('stops after the bound and reports the in-flight refusal then', async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => problem('idempotency_key_in_flight'));
    const client = createApiClient({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async () => {},
    });
    await expect(
      client.command('/api/tasks/t/feedback', { schema, idempotencyKey: 'k-2' }),
    ).rejects.toMatchObject({ code: 'idempotency_key_in_flight' });
    expect(fetchImpl).toHaveBeenCalledTimes(IN_FLIGHT_RETRY_LIMIT);
  });

  it('stops retrying an in-flight command once its caller aborts, as an abort', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn<FetchMock>(async () => {
      controller.abort();
      return problem('idempotency_key_in_flight');
    });
    const sleep = vi.fn(async () => {});
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch, sleep });
    const error = await client
      .command('/api/tasks/t/feedback', {
        schema,
        idempotencyKey: 'k-abort',
        signal: controller.signal,
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe('AbortError');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retires the key after idempotency_attempt_unknown, and the intent gets a new one', async () => {
    const fetchImpl = vi.fn<FetchMock>(async () => problem('idempotency_attempt_unknown'));
    const client = createApiClient({ fetchImpl: fetchImpl as unknown as typeof fetch });
    const minted = ['intent-key-1', 'intent-key-2'];
    const intents = createIntentKeys(() => minted.shift() ?? 'intent-key-n');
    const key = intents.keyFor(['task.feedback', 'x']);
    expect(isRetiredIdempotencyKey(key)).toBe(false);

    const error = await client
      .command('/api/tasks/t/feedback', { schema, idempotencyKey: key })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('idempotency_attempt_unknown');
    expect((error as ApiError).message).toBe(ATTEMPT_UNKNOWN_MESSAGE);
    // Sent once: an unknown outcome is not retried under the same key.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(isRetiredIdempotencyKey(key)).toBe(true);
    // Until WP-73 the register released a key only on success, so this was the same key again.
    expect(intents.keyFor(['task.feedback', 'x'])).not.toBe(key);
  });
});
