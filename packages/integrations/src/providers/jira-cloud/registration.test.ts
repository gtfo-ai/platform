/**
 * The registration, checked against the registry's own guards (BD-017) — including the one that
 * matters most: a `secretFields` entry that does not exist in the config schema would leave a
 * credential stored and rendered as plain configuration (BD-002).
 */
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  noSecretsRedactor,
} from '@platform/application';
import { fixedClock } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createIntegrationRegistry, ProviderRegistrationError } from '../../registry.js';
import { jiraCloudConfigSchema } from './config.js';
import { createJiraCloudRegistration } from './registration.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-00000000a108';
const CONFIG = {
  site_url: 'https://acme-example.atlassian.net',
  user_email: 'agentic-bot@example.test',
  project_keys: ['ACME'],
};
const SECRETS = {
  api_token: 'FAKE-jira-api-token-0123456789',
  webhook_secret: 'FAKE-jira-webhook-secret-0123456789',
};

const deps = () => ({
  executor: createIntegrationActionExecutor({
    auditLog: createMemoryAuditLog(),
    redactor: noSecretsRedactor(),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: fixedClock('2026-09-02T12:05:00.000Z', 0),
  }),
  clock: fixedClock('2026-09-02T12:05:00.000Z', 0),
  actionContext: () => ({ mode: 'normal' as const }),
});

describe('createJiraCloudRegistration', () => {
  it('registers, and is found by type', () => {
    const registry = createIntegrationRegistry([createJiraCloudRegistration(deps())]);
    const found = registry.get('task_management', 'jira-cloud');
    expect(found.displayName).toBe('Jira Cloud');
    expect(found.setupGuidePath).toContain('setup-guide.md');
    expect(registry.list('task_management').map((entry) => entry.id)).toEqual(['jira-cloud']);
  });

  it('cannot be handed to a caller that wanted another type', () => {
    const registry = createIntegrationRegistry([createJiraCloudRegistration(deps())]);
    expect(() => registry.get('git', 'jira-cloud')).toThrow(ProviderRegistrationError);
  });

  it('declares both secrets, and both exist in the config schema', () => {
    const registration = createJiraCloudRegistration(deps());
    expect([...registration.secretFields].sort()).toEqual(['api_token', 'webhook_secret']);
    for (const field of registration.secretFields) {
      expect(Object.keys(jiraCloudConfigSchema.shape)).toContain(field);
    }
  });

  it('exposes no agent tooling, because no ticket write is an agent’s to make directly', () => {
    expect(createJiraCloudRegistration(deps()).agentTooling).toBeNull();
  });

  it('builds a port from the binding’s config merged with its resolved secrets', () => {
    const registration = createJiraCloudRegistration(deps());
    const port = registration.create({
      redactor: noSecretsRedactor(),
      integrationId: INTEGRATION_ID,
      config: CONFIG,
      secrets: SECRETS,
    });
    expect(port.ref).toEqual({
      integrationId: INTEGRATION_ID,
      provider: 'jira-cloud',
      type: 'task_management',
    });
    expect(port.capabilities()).toEqual({
      webhooks: true,
      epics: true,
      links: true,
      customFields: false,
      adf: true,
      createTicket: true,
      attachments: false,
    });
  });

  it('refuses a binding whose configuration is incomplete, at creation rather than at first call', () => {
    const registration = createJiraCloudRegistration(deps());
    expect(() =>
      registration.create({
        integrationId: INTEGRATION_ID,
        config: CONFIG,
        secrets: {},
        redactor: noSecretsRedactor(),
      }),
    ).toThrow();
    expect(() =>
      registration.create({
        redactor: noSecretsRedactor(),
        integrationId: INTEGRATION_ID,
        // An unknown key is an error, never dropped: a mis-spelled field must not look configured.
        config: { ...CONFIG, sight_url: 'https://typo.example.test' },
        secrets: SECRETS,
      }),
    ).toThrow();
  });

  it('says it has no webhooks when no secret was resolved for it', () => {
    const port = createJiraCloudRegistration(deps()).create({
      redactor: noSecretsRedactor(),
      integrationId: INTEGRATION_ID,
      config: CONFIG,
      secrets: { api_token: SECRETS.api_token },
    });
    expect(port.capabilities().webhooks).toBe(false);
  });
});
