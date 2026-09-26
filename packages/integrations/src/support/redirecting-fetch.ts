/**
 * A `fetch` double that answers `302` to a host nobody declared, and honours `redirect` the way
 * the WHATWG fetch standard does — the instrument behind PROGRESS backlog **129**'s five cases
 * (WP-59).
 *
 * ## Why a double and not the replay transport
 *
 * The replayed fixtures cannot express a redirect: a replay answers the request it was asked and
 * has no second host to send one to, which is exactly how five provider clients followed redirects
 * with every tier green. This double has two hosts. Its first answer is a `302` whose `Location`
 * is {@link REDIRECT_TARGET}; what it does next is decided by the request's own `redirect` mode,
 * so a client is judged on the option it **sent**, not on a promise in its docblock:
 *
 *  - `'error'` — rejects with a `TypeError`, whose `cause` says *"unexpected redirect"*: the shape
 *    Node's own `fetch` rejects with (measured on Node v25.1.0 against a local server, WP-59 —
 *    `TypeError: fetch failed`, cause `unexpected redirect`);
 *  - `'manual'` — answers the `302` itself, which is what a client asking for it would get;
 *  - `'follow'` or absent (the default) — **makes the second request**, to the target host, with
 *    the request's headers minus the three the standard strips on a cross-origin hop
 *    (`authorization`, `cookie`, `proxy-authorization`), and records it in
 *    {@link RedirectingFetch.followed}. That is what Node did in the same measurement: a
 *    `private-token` header and a custom header reached the second host, `authorization` and
 *    `cookie` did not.
 *
 * So a client that sets `redirect: 'error'` rejects and leaves `followed` empty, and a client that
 * does not produces a `followed` entry naming the headers that went with it — the two facts each
 * provider's case asserts.
 *
 * It accepts both call shapes a client in this repository uses: `(url, init)` for the four
 * hand-written clients and `(Request)` for `ky`, which builds a `Request` and hands it over whole.
 */

/** Where the double's redirect points: a host no binding in any test declares. */
export const REDIRECT_TARGET = 'https://not-allow-listed.example.invalid/landed';

const STRIPPED_CROSS_ORIGIN = new Set(['authorization', 'cookie', 'proxy-authorization']);

export interface FollowedRequest {
  readonly url: string;
  /** Header names that reached the second host, lower-case and sorted. */
  readonly headerNames: readonly string[];
}

export interface RedirectingFetch {
  /** Drop-in for any client's injected `fetch`. */
  readonly fetchImpl: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Every first request, with the `redirect` mode it carried (`undefined` when it set none). */
  readonly asked: readonly { readonly url: string; readonly redirect: string | undefined }[];
  /** Every request the double was made to send to {@link REDIRECT_TARGET}. Empty is the pass. */
  readonly followed: readonly FollowedRequest[];
}

const headerNamesOf = (headers: Headers): string[] => {
  const names: string[] = [];
  headers.forEach((_value, name) => {
    names.push(name.toLowerCase());
  });
  return names.sort();
};

export const createRedirectingFetch = (
  options: { readonly status?: 301 | 302 | 303 | 307 | 308 } = {},
): RedirectingFetch => {
  const asked: { url: string; redirect: string | undefined }[] = [];
  const followed: FollowedRequest[] = [];
  const status = options.status ?? 302;

  const fetchImpl: RedirectingFetch['fetchImpl'] = async (input, init) => {
    // A `Request` carries its own mode, and `Request.redirect` is always set ('follow' when the
    // caller said nothing), so an absent mode is only observable on the `(url, init)` shape.
    const isRequest = typeof input === 'object' && 'redirect' in input && !(input instanceof URL);
    const url = isRequest ? (input as Request).url : String(input);
    const redirect = isRequest ? (input as Request).redirect : init?.redirect;
    const headers = new Headers(isRequest ? (input as Request).headers : init?.headers);
    asked.push({ url, redirect });

    if (redirect === 'error') {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
    }
    if (redirect === 'manual') {
      return new Response(null, { status, headers: { location: REDIRECT_TARGET } });
    }
    for (const name of STRIPPED_CROSS_ORIGIN) {
      headers.delete(name);
    }
    followed.push({ url: REDIRECT_TARGET, headerNames: headerNamesOf(headers) });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };

  return { fetchImpl, asked, followed };
};
