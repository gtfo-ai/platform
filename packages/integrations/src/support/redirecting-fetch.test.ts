/**
 * The instrument behind backlog 129's five provider cases, shown able to see what it is for
 * (standing rule 4): a client that follows a redirect produces a `followed` entry naming the
 * headers that went with it, so an empty `followed` in a provider's case means something.
 */
import { describe, expect, it } from 'vitest';
import { createRedirectingFetch, REDIRECT_TARGET } from './redirecting-fetch.js';

const HEADERS = {
  'private-token': 'FAKE-private-token',
  authorization: 'Bearer FAKE-authorization',
  cookie: 'c=FAKE',
  'x-custom': 'FAKE',
};

describe('createRedirectingFetch', () => {
  it('follows by default and forwards what the standard does not strip on a cross-origin hop', async () => {
    const double = createRedirectingFetch();
    const response = await double.fetchImpl('https://declared.example.test/api', {
      headers: HEADERS,
    });
    expect(response.status).toBe(200);
    expect(double.asked).toEqual([
      { url: 'https://declared.example.test/api', redirect: undefined },
    ]);
    // What Node's own `fetch` did in the WP-59 measurement: the provider-specific header went on,
    // `authorization` and `cookie` did not.
    expect(double.followed).toEqual([
      { url: REDIRECT_TARGET, headerNames: ['private-token', 'x-custom'] },
    ]);
  });

  it('rejects the way Node does when the request says error, and follows nothing', async () => {
    const double = createRedirectingFetch();
    const outcome = await double
      .fetchImpl('https://declared.example.test/api', { headers: HEADERS, redirect: 'error' })
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(outcome).toBeInstanceOf(TypeError);
    expect(((outcome as TypeError).cause as Error).message).toBe('unexpected redirect');
    expect(double.followed).toEqual([]);
  });

  it('hands a manual caller the redirect itself', async () => {
    const double = createRedirectingFetch({ status: 301 });
    const response = await double.fetchImpl('https://declared.example.test/api', {
      redirect: 'manual',
    });
    expect(response.status).toBe(301);
    expect(response.headers.get('location')).toBe(REDIRECT_TARGET);
    expect(double.followed).toEqual([]);
  });

  it('reads the mode off a Request, which is the shape ky sends', async () => {
    const double = createRedirectingFetch();
    await expect(
      double.fetchImpl(
        new Request('https://declared.example.test/api', { headers: HEADERS, redirect: 'error' }),
      ),
    ).rejects.toBeInstanceOf(TypeError);
    await double.fetchImpl(new Request('https://declared.example.test/api', { headers: HEADERS }));
    expect(double.asked.map((entry) => entry.redirect)).toEqual(['error', 'follow']);
    expect(double.followed).toHaveLength(1);
  });
});
