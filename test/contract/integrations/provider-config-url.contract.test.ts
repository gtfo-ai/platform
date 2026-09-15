/**
 * Every shipped provider's config URL, held to the scheme obligation (WP-51, backlog 48).
 *
 * The scope is **the provider directories on disk**, not a list maintained here (standing rule 7):
 * a sixth provider fails this file the moment its directory exists, and cannot be excused by
 * nobody remembering to add it. That is the same derivation `delivery-key-redaction.test.ts` and
 * `fixture-provenance.contract.test.ts` use, and it is the reason those two caught defects a
 * hand-written list had walked past.
 *
 * `config-url.ts` carries the obligation itself and what it can and cannot prove.
 */
import { readdirSync } from 'node:fs';
import {
  gitlabConfigSchema,
  jiraCloudConfigSchema,
  lokiConfigSchema,
  sentryConfigSchema,
  slackConfigSchema,
} from '@platform/integrations';
import { describe, expect, it } from 'vitest';
import {
  type ConfigUrlCase,
  describeConfigUrlContract,
} from '../support/integrations/config-url.js';

const PROVIDER_ROOT = new URL('../../../packages/integrations/src/providers/', import.meta.url);

const PROVIDER_DIRECTORIES: readonly string[] = readdirSync(PROVIDER_ROOT, {
  withFileTypes: true,
})
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

/**
 * One case per provider directory, keyed by the directory name.
 *
 * The keys are compared with the disk in both directions below, so this is a list of *recipes* and
 * not a list of providers: a missing recipe is a failure rather than a silent exclusion.
 */
const CASES: Readonly<Record<string, ConfigUrlCase>> = {
  gitlab: {
    provider: 'gitlab',
    schema: gitlabConfigSchema,
    urlField: 'base_url',
    valid: { base_url: 'https://gitlab.example.test', project: 'acme/api' },
  },
  'jira-cloud': {
    provider: 'jira-cloud',
    schema: jiraCloudConfigSchema,
    urlField: 'site_url',
    valid: {
      site_url: 'https://acme-example.atlassian.net',
      user_email: 'bot@example.test',
      api_token: 'FAKE-jira-api-token-0123456789',
    },
  },
  loki: {
    provider: 'loki',
    schema: lokiConfigSchema,
    urlField: 'base_url',
    valid: { base_url: 'https://loki.example.test:3100', auth_mode: 'none' },
  },
  sentry: {
    provider: 'sentry',
    schema: sentryConfigSchema,
    urlField: 'base_url',
    valid: { base_url: 'https://sentry.io', organization: 'acme-example' },
  },
  slack: {
    provider: 'slack',
    schema: slackConfigSchema,
    urlField: 'base_url',
    valid: { base_url: 'https://slack.com/api', channel: '#agentic' },
  },
};

describe('provider config URLs', () => {
  it('has a case for every provider directory on disk, and no case for a directory that is gone', () => {
    expect(Object.keys(CASES).sort()).toEqual([...PROVIDER_DIRECTORIES]);
  });

  it('finds provider directories at all, so an empty scope cannot pass', () => {
    // Standing rule 4: a suite that discovered nothing would report every rule satisfied.
    expect(PROVIDER_DIRECTORIES.length).toBeGreaterThanOrEqual(5);
  });

  for (const provider of PROVIDER_DIRECTORIES) {
    describe(provider, () => {
      const testCase = CASES[provider];
      if (testCase === undefined) {
        it('has a config-URL case', () => {
          expect.unreachable(`no ConfigUrlCase for provider directory "${provider}"`);
        });
        return;
      }
      describeConfigUrlContract(testCase);
    });
  }
});
