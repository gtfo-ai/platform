/**
 * **No provider HTTP client follows a redirect** — WP-59, PROGRESS backlog 129 (technical/10 unit
 * tier).
 *
 * ## Why this file exists
 *
 * WP-51's egress allow-list is asked once per action, about the URL a client builds out of its
 * binding's validated config. What `fetch` did with a `3xx` was below that decision: all five
 * clients sent no `redirect` option, so the default `follow` applied and the second request went to
 * a host no list ever saw — measured on Node v25.1.0 against a local server at WP-59, with
 * GitLab's `private-token` header and a custom header reaching the second host (the standard
 * strips `authorization` and `cookie` on a cross-origin hop, and nothing else). The replayed
 * fixtures cannot express a redirect, which is how every tier stayed green over it.
 *
 * Each case builds the client exactly as its adapter does, hands it
 * {@link createRedirectingFetch} — which answers `302` to an undeclared host and then does what the
 * request's `redirect` mode says — and asserts three things: the client **raised**, the request it
 * sent carried `redirect: 'error'`, and **nothing** was sent to the second host. A client that
 * dropped the option fails the third assertion with the header names that would have followed.
 *
 * ## The scope is the disk, in both directions
 *
 * `PROVIDER_DIRECTORIES` is read off this directory, as `egress-host.test.ts` and
 * `delivery-key-redaction.test.ts` read it, and compared with the cases: a sixth provider fails
 * this file the moment its directory exists, and backlog 129's *"five files or none"* is the
 * equality below rather than a sentence in a ledger.
 *
 * ## What it cannot prove
 *
 * That a client never builds a second URL some *other* way — a pagination link or a URL read out
 * of a response body. That limit is `egress-host.test.ts`'s and it is stated there. And the double
 * models the standard, not a particular runtime: it rejects because the request said `'error'`,
 * which is the contract, and the WP-59 measurement is what says Node's own `fetch` keeps it.
 */
import { readdirSync } from 'node:fs';
import { IntegrationError, noSecretsRedactor } from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createRedirectingFetch, type RedirectingFetch } from '../support/redirecting-fetch.js';
import { createGitLabHttp } from './gitlab/http.js';
import { createJiraClient } from './jira-cloud/client.js';
import { createLokiHttp } from './loki/http.js';
import { createSentryHttp } from './sentry/http.js';
import { createSlackHttp } from './slack/http.js';

const clock = fixedClock('2026-06-01T10:30:00.000Z');

/** The provider directories, asked of the filesystem rather than listed here (rule 7). */
const PROVIDER_DIRECTORIES: readonly string[] = readdirSync(new URL('.', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/** One request through the client, built the way its adapter builds it. */
type Attempt = (double: RedirectingFetch) => Promise<unknown>;

const CASES: Readonly<Record<string, Attempt>> = {
  gitlab: async (double) =>
    createGitLabHttp({
      baseUrl: 'https://gitlab.example.test',
      token: 'FAKE-gitlab-token-DO-NOT-USE',
      fetchImpl: double.fetchImpl,
      timeoutMs: 0,
      maxPages: 1,
      redactor: noSecretsRedactor(),
    }).request({ method: 'GET', path: '/projects/acme%2Fapi', action: 'get_project' }),
  'jira-cloud': async (double) =>
    createJiraClient({
      siteUrl: 'https://acme-example.atlassian.net',
      email: 'agentic-bot@example.test',
      apiToken: 'FAKE-jira-api-token-DO-NOT-USE',
      fetch: double.fetchImpl as typeof globalThis.fetch,
      now: () => Date.parse('2026-06-01T10:30:00.000Z'),
      redactor: noSecretsRedactor(),
    }).send({ method: 'GET', path: 'issue/ACME-1', action: 'read_ticket' }),
  loki: async (double) =>
    createLokiHttp({
      baseUrl: 'https://loki.example.test',
      auth: {
        mode: 'bearer',
        bearerToken: 'FAKE-loki-bearer-token-DO-NOT-USE',
        username: null,
        password: null,
        tenantId: null,
      },
      fetchImpl: double.fetchImpl,
      timeoutMs: 0,
      clock,
      redactor: noSecretsRedactor(),
    }).request({ path: '/loki/api/v1/labels', action: 'query_logs' }),
  sentry: async (double) =>
    createSentryHttp({
      baseUrl: 'https://sentry.example.test',
      token: 'FAKE-sentry-auth-token-DO-NOT-USE',
      fetchImpl: double.fetchImpl,
      timeoutMs: 0,
      clock,
      redactor: noSecretsRedactor(),
      // The trailing slash Sentry's own paths carry (`client.ts`): a same-host 301 for a path
      // without one is refused like any other redirect, and the paths already satisfy it.
    }).request({ method: 'GET', path: '/api/0/organizations/acme-example/', action: 'probe' }),
  slack: async (double) =>
    createSlackHttp({
      baseUrl: 'https://slack.example.test/api',
      token: 'xoxb-FAKE-bot-token-DO-NOT-USE',
      fetchImpl: double.fetchImpl,
      timeoutMs: 0,
      redactor: noSecretsRedactor(),
    }).call({ method: 'auth.test', action: 'test_connection', body: {}, encoding: 'form' }),
};

describe('provider HTTP clients refuse a redirect (backlog 129)', () => {
  it('has a case for every provider directory, and no case for one that is gone', () => {
    expect(Object.keys(CASES).sort()).toEqual(PROVIDER_DIRECTORIES);
  });

  it.each(Object.keys(CASES).sort())(
    '%s raises on a 302 to an undeclared host and sends nothing there',
    async (provider) => {
      const double = createRedirectingFetch();
      const attempt = CASES[provider] as Attempt;
      const outcome = await attempt(double).then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome, 'the client must raise rather than answer').toBeInstanceOf(IntegrationError);
      expect((outcome as IntegrationError).code).toBe('unavailable');
      expect(double.asked.map((entry) => entry.redirect)).toEqual(['error']);
      expect(double.followed, 'nothing may reach the host the redirect named').toEqual([]);
    },
  );
});
