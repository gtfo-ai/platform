/**
 * **What the two observability adapters put on the wire when the caller is hostile** — WP-11a,
 * standing rule 44 (technical/10 unit tier).
 *
 * ## Why this file exists
 *
 * `loki/provider.ts` and `sentry/client.ts` each splice a caller-supplied string into a request
 * path, and each says in a comment that the encoder makes a hostile one inert — "spliced into the
 * request path", "keeps a hostile one inert". Neither claim was checkable. Replacing
 * `` `/label/${encodeURIComponent(name)}/values` `` with `` `/label/${name}/values` ``, and making
 * `segment` the identity function, each left **3000 of 3000 tests green**, while the LogQL escaper
 * sitting beside them dies loudly: making `escapeLogQLString` return its argument fails **9** tests
 * across two files. *A docblock claim must be enforced by the same check that enforces the thing,
 * or it is decoration.* The two mutations above now fail 1 and 2 of the tests below, by assertions
 * that print the reshaped path.
 *
 * The strings are not hypothetical. `labels(name)` is validated for **length only** — the cap is
 * `max_label_bytes`, and `a/../../admin` is thirteen bytes — and a Sentry issue id is not validated
 * at all: `getIssue`, `getLatestEvent` and `resolve` pass `ref.id` straight through. Both arrive
 * from an agent's tool call, which is untrusted text (BD-022), on a request that carries the
 * binding's `Authorization` header. What the encoder buys is measured rather than asserted in
 * prose, and each case below carries the path the *unencoded* form resolves to.
 *
 * ## Why the transport here answers everything
 *
 * The contract runners replay recorded fixtures, so an unencoded path would miss its key and the
 * replay would throw before any assertion ran: the mutation would die by a transport error naming a
 * fixture key rather than by an assertion naming the defect (standing rule 3, "by a named
 * assertion rather than a timeout"). The stubs below answer *any* URL, so the only thing that can
 * fail is the assertion on the path.
 *
 * ## What is asserted is the **resolved** path, not the string the adapter built
 *
 * `new URL()` performs RFC 3986 dot-segment removal, and so does every HTTP client and every
 * router that will see this request — Node's `fetch` included. So the assertion reads the path the
 * way a server would route on it, which is the only reading in which `..` is dangerous:
 * `/loki/api/v1/label/a/../../admin/values` *is* `GET /loki/api/v1/admin/values`. A percent-encoded
 * `%2F` is not a separator and survives that normalisation, which is the whole property.
 *
 * ## What this file does not cover
 *
 *  - **Query strings and headers.** `buildUrl` encodes both parameter names and values in each
 *    transport, and the tenant header is asserted in `loki.contract.test.ts`; the sweep of those is
 *    recorded in `docs/TODO.md` rather than half-done here.
 *  - **Whether the vendor accepts the encoded form.** That is a recorded-fixture question, and
 *    `test/fixtures/http/<provider>/SOURCES.md` is where it lives.
 *  - **What the ports emit.** `providers/emitted-bounds.test.ts` enumerates that; this file is the
 *    mirror image, the strings going *out* rather than coming *in*.
 */
import { noSecretsRedactor, type ObservabilityErrorsPort } from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createLokiRegistration } from './loki/index.js';
import { createSentryRegistration } from './sentry/index.js';

const NOW = '2026-06-01T10:30:00.000Z' as const;
const LOKI_BASE_URL = 'https://loki.example.test:3100';
const SENTRY_BASE_URL = 'https://sentry.example.test';
const SENTRY_ORGANIZATION = 'acme-example';

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** The path a server would route on, or a loud placeholder when nothing was ever sent. */
const routedPath = (url: string | undefined): string =>
  new URL(url ?? 'https://nothing-was-sent.invalid/').pathname;

// ── Loki ─────────────────────────────────────────────────────────────────────

/**
 * The reviewer's own example, and it is inside `max_label_bytes` (1024) — so the refusal that
 * guards that cap is *not* what is being exercised here (standing rule 10: assert which branch
 * ran; the request log below is that assertion).
 */
const HOSTILE_LABEL_NAME = 'a/../../admin';

const lokiPort = (urls: string[]) =>
  createLokiRegistration({
    clock: fixedClock(NOW),
    fetch: (url: string) => {
      urls.push(url);
      return Promise.resolve(json({ status: 'success', data: ['api'] }));
    },
  }).create({
    integrationId: '00000000-0000-4000-8000-0000000000a7',
    config: {
      base_url: LOKI_BASE_URL,
      auth_mode: 'bearer',
      // No network, so no timeout timer either.
      request_timeout_ms: 0,
    },
    secrets: { bearer_token: 'FAKE-loki-bearer-token-DO-NOT-USE' },
    redactor: noSecretsRedactor(),
  });

describe('Loki: a hostile label name is one encoded path segment', () => {
  it('sends GET /label/<encoded>/values, never a path the name reshaped', async () => {
    const urls: string[] = [];
    const port = lokiPort(urls);

    const answer = await port.labels(HOSTILE_LABEL_NAME);

    expect(
      urls,
      'the call reached the transport, so the path below is the one Loki routes on',
    ).toHaveLength(1);
    expect(
      routedPath(urls[0]),
      'the name stays one segment: `/` is `%2F`, which dot-segment removal does not touch',
    ).toBe('/loki/api/v1/label/a%2F..%2F..%2Fadmin/values');
    expect(
      routedPath(urls[0]),
      'unencoded it climbs out of /label/<name>/values and asks a different endpoint — with the Authorization header attached',
    ).not.toBe('/loki/api/v1/admin/values');
    expect(answer.name, 'and the name is echoed back unchanged, not the encoded form').toBe(
      HOSTILE_LABEL_NAME,
    );
  });
});

// ── Sentry ───────────────────────────────────────────────────────────────────

const sentryPort = (urls: string[], organization = SENTRY_ORGANIZATION): ObservabilityErrorsPort =>
  createSentryRegistration({
    clock: fixedClock(NOW),
    fetch: (url: string) => {
      urls.push(url);
      if (url.includes('/events/latest/')) {
        // The documented 404 of an issue past its retention window: `getLatestEvent` answers
        // `null`, so the case needs no event document to be about the path.
        return Promise.resolve(json({ detail: 'not found' }, 404));
      }
      if (url.includes('/projects/')) {
        return Promise.resolve(json([]));
      }
      return Promise.resolve(json({ id: '7', slug: SENTRY_ORGANIZATION, name: 'Acme Example' }));
    },
  }).create({
    integrationId: '00000000-0000-4000-8000-0000000000a6',
    config: { base_url: SENTRY_BASE_URL, organization, request_timeout_ms: 0 },
    secrets: { auth_token: 'FAKE-sentry-auth-token-DO-NOT-USE' },
    redactor: noSecretsRedactor(),
  });

/**
 * The caller-supplied strings `sentry/client.ts` puts in a path, with the path the **unencoded**
 * form resolves to beside each — measured, not imagined. One `segment` function encodes both, so
 * one identity mutation kills both cases; two rows are here because the *sources* differ (an
 * agent's tool call, a pipeline's project) and a later reader deciding "is this input trusted?"
 * needs the list rather than the function.
 *
 * The **third** string `segment` encodes — the organization — is not here, and that is standing
 * rule 22 stated at the line rather than a gap: `sentryConfigSchema` refuses anything that is not a
 * slug, so a hostile organization cannot reach the client at all. The test below drives that outer
 * guard and names it, so this omission stays a decision rather than becoming an oversight.
 */
const SENTRY_CASES = [
  {
    what: 'an issue id, straight from an agent tool call',
    hostile: '4242/../../../../organizations/evil-corp/issues/1',
    port: (urls: string[]) => sentryPort(urls),
    call: async (port: ObservabilityErrorsPort, hostile: string) => {
      expect(
        await port.getLatestEvent({ id: hostile }),
        'the 404 is the documented null',
      ).toBeNull();
    },
    routed:
      '/api/0/organizations/acme-example/issues/4242%2F..%2F..%2F..%2F..%2Forganizations%2Fevil-corp%2Fissues%2F1/events/latest/',
    escaped: '/api/0/organizations/evil-corp/issues/1/events/latest/',
  },
  {
    what: 'a project slug, from the search a pipeline stage issues',
    hostile: 'api/../../../organizations/evil-corp/issues/1',
    port: (urls: string[]) => sentryPort(urls),
    call: async (port: ObservabilityErrorsPort, hostile: string) => {
      expect(await port.searchIssues({ project: hostile, query: '' })).toEqual([]);
    },
    routed:
      '/api/0/projects/acme-example/api%2F..%2F..%2F..%2Forganizations%2Fevil-corp%2Fissues%2F1/issues/',
    escaped: '/api/0/organizations/evil-corp/issues/1/issues/',
  },
] as const;

describe('Sentry: every caller-supplied path segment is encoded', () => {
  it.each(SENTRY_CASES)(
    'sends $what as one encoded segment',
    async ({ hostile, port: build, call, routed, escaped }) => {
      const urls: string[] = [];
      const port = build(urls);

      await call(port, hostile);

      expect(
        urls,
        'the call reached the transport, so the path below is the one Sentry routes on',
      ).toHaveLength(1);
      expect(
        routedPath(urls[0]),
        'the hostile string stays inside the segment it was spliced into',
      ).toBe(routed);
      expect(
        routedPath(urls[0]),
        `unencoded it resolves to ${escaped} — a different resource, asked with this binding's token`,
      ).not.toBe(escaped);
    },
  );

  /**
   * The organization is the one path segment the encoder is *defence in depth* for, and this names
   * the guard in front of it (standing rule 22: an unreachable branch says so at the line and names
   * what makes it so). It is also the case that would otherwise look untested: `segment(org)` runs
   * on every request this client makes, and nothing hostile can ever be passed to it.
   */
  it('refuses a hostile organization in the binding, before the encoder is reached', () => {
    expect(() => sentryPort([], 'acme/../../evil')).toThrow(/expected a Sentry slug/);
  });
});
