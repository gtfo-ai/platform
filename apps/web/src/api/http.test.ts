import { describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { ApiError, CSRF_HEADER, CSRF_HEADER_VALUE, createApiClient, NetworkError } from './http.js';

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
