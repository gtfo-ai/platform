/**
 * **Every provider's adapter publishes the host it dials**, built through its real registration —
 * WP-51, PROGRESS backlog 48 (technical/10 unit tier).
 *
 * ## Why this file exists
 *
 * `IntegrationActionExecutor` refuses a call whose binding names a host no operator declared, and
 * the value it decides on is `IntegrationRef.host`. That makes the ref's `host` a **security
 * input**, and it makes `null` the dangerous value: the executor reads `null` as *this adapter
 * opens no socket* and performs the call without asking, which is correct for the fakes and would
 * be a silent hole for a real provider. Nothing in the type system separates the two — `null` is a
 * legal value of the field for both — so this is the check that does.
 *
 * It is the same shape, and for the same reason, as `delivery-key-redaction.test.ts`: three
 * providers shipped that defect before the check existed, and rule 30 says that when a defect is
 * mechanically detectable you add the check rather than the note. The scope is read off the disk
 * (`PROVIDER_DIRECTORIES`), so a sixth provider fails this file the moment its directory exists.
 *
 * ## What each assertion is for
 *
 *  1. **A case per provider directory**, compared with the disk in both directions, so a new
 *     provider cannot be excused by an absent recipe (rule 7's corollary: no allow-list).
 *  2. **Built through the registration's own `create`**, which is the production path. Standing
 *     rule 35: making a field required proves it is *supplied* where the object is built, never
 *     that it holds the right value.
 *  3. **The host equals the host of the configured URL**, and the configured URL is **not** the
 *     provider's default: Sentry and Slack both default `base_url`, so a recipe that let the
 *     default stand would pass against an adapter that hard-coded `sentry.io`.
 *  4. **It is not `null`**, stated separately from (3) so the failure message says which of the two
 *     things went wrong.
 *  5. **It changes when the config changes**, which is the assertion that separates "reads the
 *     config" from "returns a constant" (rule 9).
 *
 * ## What it cannot prove, stated rather than implied
 *
 * That the adapter's HTTP client only ever requests the host it published. A client that built a
 * second URL from a provider response — a pagination link, a `Location` header, a redirect — would
 * reach a host this ref never named and the executor would never see it, and **this census cannot
 * see that**: it reads the ref, not the requests. One of the three is now held elsewhere —
 * **redirects**, which every client refuses with `redirect: 'error'` since WP-59 and which
 * `redirect-refusal.test.ts` drives per provider directory with an injected `fetch` answering
 * `302` (PROGRESS backlog 129). The other two are not held by any test: GitLab's pagination puts a
 * page *number* back into a URL rebuilt from its own base and Jira's pages on a token, so neither
 * dials a URL a provider handed it today — a reading of the two clients, not an assertion, and it
 * stays true only until a client starts following a link.
 */

import { readdirSync } from 'node:fs';
import { noSecretsRedactor } from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { gitlabProviderRegistration } from './gitlab/index.js';
import { createJiraCloudRegistration } from './jira-cloud/registration.js';
import { lokiProviderRegistration } from './loki/index.js';
import { sentryProviderRegistration } from './sentry/index.js';
import { slackProviderRegistration } from './slack/index.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000e1';
const clock = fixedClock('2026-06-01T10:30:00.000Z');

/** The provider directories, asked of the filesystem rather than listed here (rule 7). */
const PROVIDER_DIRECTORIES: readonly string[] = readdirSync(new URL('.', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * Jira's registration is a factory over an executor, so one is built here — and it is a **stub**
 * rather than a real `IntegrationActionExecutor`: nothing below performs an action, and a real one
 * would need the very egress policy this file is checking the input of, which would make the
 * assertion circular.
 */
const jiraRegistration = createJiraCloudRegistration({
  executor: {
    execute: async () => {
      throw new Error('no action is performed by egress-host.test.ts');
    },
  },
  clock,
  actionContext: () => ({ mode: 'normal', projectId: null, taskId: null }),
});

interface EgressHostCase {
  /** A host that is **not** the provider's default, so a hard-coded default cannot pass. */
  readonly configuredHost: string;
  /** A second host, to prove the ref follows the config rather than returning a constant. */
  readonly otherHost: string;
  /** The port, built through the registration with the given host in its config URL. */
  readonly port: (host: string) => object;
}

const CASES: Readonly<Record<string, EgressHostCase>> = {
  gitlab: {
    configuredHost: 'gitlab.example.test',
    otherHost: 'gitlab.other.test',
    port: (host) =>
      gitlabProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { base_url: `https://${host}`, project: 'acme/api' },
        secrets: { token: 'FAKE-gitlab-token-0123456789' },
        redactor: noSecretsRedactor(),
      }),
  },
  'jira-cloud': {
    configuredHost: 'acme.atlassian.net',
    otherHost: 'other.atlassian.net',
    port: (host) =>
      jiraRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { site_url: `https://${host}`, user_email: 'bot@example.test' },
        secrets: { api_token: 'FAKE-jira-api-token-0123456789' },
        redactor: noSecretsRedactor(),
      }),
  },
  loki: {
    configuredHost: 'loki.example.test',
    otherHost: 'loki.other.test',
    port: (host) =>
      lokiProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        // With the port, because `URL.hostname` drops it and the ref must not keep it: a declared
        // list is written in host names.
        config: { base_url: `https://${host}:3100` },
        secrets: { bearer_token: 'FAKE-loki-bearer-token-0123456789' },
        redactor: noSecretsRedactor(),
      }),
  },
  sentry: {
    // Not `sentry.io`: that is the schema's default and would pass against a constant.
    configuredHost: 'sentry.example.test',
    otherHost: 'sentry.other.test',
    port: (host) =>
      sentryProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { base_url: `https://${host}`, organization: 'acme-example' },
        secrets: { auth_token: 'FAKE-sentry-auth-token-0123456789' },
        redactor: noSecretsRedactor(),
      }),
  },
  slack: {
    // Not `slack.com`, for the same reason: `slackConfigSchema.base_url` defaults to it.
    configuredHost: 'slack.example.test',
    otherHost: 'slack.other.test',
    port: (host) =>
      slackProviderRegistration.create({
        integrationId: INTEGRATION_ID,
        config: { base_url: `https://${host}/api`, channel: 'C0FAKECHAN1' },
        secrets: {
          bot_token: 'xoxb-FAKE-bot-token-0123456789',
          app_token: 'xapp-FAKE-app-token-0123456789',
          signing_secret: 'FAKE-slack-signing-secret-0123456789',
        },
        redactor: noSecretsRedactor(),
      }),
  },
};

/** Asked of the built object, not of its type: what a new provider gets wrong is the object. */
const hostOf = (port: object): string | null | undefined => {
  if (!('ref' in port)) {
    return undefined;
  }
  const ref = (port as { ref: { host?: string | null } }).ref;
  return ref.host;
};

describe('every provider’s published egress host', () => {
  it('has a case here for every provider directory on disk', () => {
    expect(Object.keys(CASES).sort()).toEqual([...PROVIDER_DIRECTORIES]);
  });

  describe.each(PROVIDER_DIRECTORIES)('%s', (provider) => {
    /** Read inside each test, so a missing case is a named failure and not a collection crash. */
    const caseFor = (): EgressHostCase => {
      const testCase = CASES[provider];
      if (testCase === undefined) {
        expect.fail(
          `${provider}: a provider directory with no case in CASES — add one naming the host its ` +
            'config URL points at, so the executor’s allow-list has something to decide about',
        );
      }
      return testCase;
    };

    it('has a case in this file', () => {
      caseFor();
    });

    it('publishes the host of its configured URL, and not null', () => {
      const testCase = caseFor();
      const host = hostOf(testCase.port(testCase.configuredHost));

      expect(
        host,
        `${provider} published no ref.host: the executor would perform every call this binding ` +
          'makes without consulting APP_INTEGRATION_HOSTS',
      ).not.toBeNull();
      expect(host).toBe(testCase.configuredHost);
    });

    it('follows the configuration rather than returning a constant', () => {
      const testCase = caseFor();

      expect(hostOf(testCase.port(testCase.otherHost))).toBe(testCase.otherHost);
    });
  });
});
