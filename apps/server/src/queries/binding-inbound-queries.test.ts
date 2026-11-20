/**
 * BACKLOG 1610: a binding's webhook-secret state, decided from the sealed field names and the two
 * config documents — every branch, each from both sides. The SQL half (the sealed rows, the
 * `inbox` read and its poll exclusion) is `test/integration/server/onboarding.integration.test.ts`'s.
 */
import { describe, expect, it } from 'vitest';
import { webhookSecretStateOf } from './binding-inbound-queries.js';

const JIRA = { webhookSecretFields: ['webhook_secret'] } as const;
const GITLAB = { webhookSecretFields: ['webhook_secret_token', 'webhook_signing_token'] } as const;
const none = { fields: new Set<string>(), unreadable: false };

describe('webhookSecretStateOf', () => {
  it('answers nothing for a provider with no webhook secret fields, or one this build does not ship', () => {
    expect(webhookSecretStateOf({ webhookSecretFields: [] }, {}, {}, none)).toBeNull();
    expect(webhookSecretStateOf(undefined, {}, {}, none)).toBeNull();
  });

  it('is configured by a sealed field, and not configured without one', () => {
    expect(
      webhookSecretStateOf(
        JIRA,
        {},
        {},
        { fields: new Set(['webhook_secret']), unreadable: false },
      ),
    ).toBe('configured');
    expect(
      webhookSecretStateOf(JIRA, {}, {}, { fields: new Set(['api_token']), unreadable: false }),
    ).toBe('not_configured');
  });

  it('counts either of GitLab’s two schemes', () => {
    for (const field of GITLAB.webhookSecretFields) {
      expect(
        webhookSecretStateOf(GITLAB, {}, {}, { fields: new Set([field]), unreadable: false }),
        field,
      ).toBe('configured');
    }
  });

  it('counts a non-empty value pasted into the account’s or the binding’s config, as the loader merges it', () => {
    expect(webhookSecretStateOf(JIRA, { webhook_secret: 'FAKE-x-1610' }, {}, none)).toBe(
      'configured',
    );
    expect(webhookSecretStateOf(JIRA, {}, { webhook_secret: 'FAKE-x-1610' }, none)).toBe(
      'configured',
    );
    expect(webhookSecretStateOf(JIRA, { webhook_secret: '' }, { webhook_secret: null }, none)).toBe(
      'not_configured',
    );
  });

  it('says unreadable rather than not configured when a sealed row would not open', () => {
    expect(
      webhookSecretStateOf(JIRA, {}, {}, { fields: new Set(['api_token']), unreadable: true }),
    ).toBe('unreadable');
    // …but a field that did open still answers.
    expect(
      webhookSecretStateOf(JIRA, {}, {}, { fields: new Set(['webhook_secret']), unreadable: true }),
    ).toBe('configured');
  });
});
