/**
 * The registration, checked against the registry's own guards (BD-017) — including the one that
 * matters most: a `secretFields` entry that does not exist in the config schema would leave a
 * credential stored and rendered as plain configuration (BD-002).
 */
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  noSecretsRedactor,
  type TaskManagementPort,
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
    // Declared open on purpose (WP-51): this file is not about the egress allow-list, and an
    // omitted policy is not a thing `IntegrationActionExecutorOptions` permits.
    egress: allowAnyIntegrationHost(),
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

  /**
   * WP-54 (PROGRESS backlog 40): the tooling names the `jira-ticket` **skill**, because a provider
   * skill is now provisioned only when a binding's `AgentTooling.skill` names it — and still no CLI,
   * no MCP server and no environment variable, because no ticket write is an agent's to make
   * directly and nobody here has verified a Jira CLI's credential contract.
   */
  it('exposes the recipes and no CLI, server or credential — no ticket write is an agent’s to make', () => {
    expect(createJiraCloudRegistration(deps()).agentTooling).toEqual({
      cli: null,
      mcp: null,
      skill: { id: 'jira-ticket', path: 'packages/prompts/skills/jira-ticket' },
      env: { variables: [] },
    });
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
      // The host the executor's egress allow-list decides on (`IntegrationRef.host`, WP-51).
      host: 'acme-example.atlassian.net',
    });
    expect(port.capabilities()).toEqual({
      webhooks: true,
      epics: true,
      links: true,
      customFields: false,
      adf: true,
      createTicket: true,
      attachments: false,
      // WP-172: all six lifecycle members (research/15 J1, J3, J4, J5, J6).
      lifecycleStatuses: true,
      transitionsRead: true,
      assign: true,
      commentsRead: true,
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

/**
 * WP-122 pre-review round: `ticketScope` is `project_keys`, compared exactly as the webhook compares
 * a delivered key (`projectKeyOf`), asked with the key Jira answered — so an empty list is
 * `unscoped` and admits any key, and a declared list refuses another project's ticket.
 */
describe('the Jira binding’s declared scope (WP-122)', () => {
  const portWith = (projectKeys: readonly string[]) =>
    createJiraCloudRegistration(deps()).create({
      integrationId: INTEGRATION_ID as never,
      config: { ...CONFIG, project_keys: [...projectKeys] },
      secrets: SECRETS,
      redactor: noSecretsRedactor(),
    } as never) as TaskManagementPort;

  it('admits a ticket of a declared project, refuses another naming the list, and admits any key when none is declared', () => {
    const scoped = portWith(['ACME', 'OPS']);
    expect(scoped.ticketScope('ACME-12')).toEqual({ kind: 'in_scope' });
    expect(scoped.ticketScope('OPS-1')).toEqual({ kind: 'in_scope' });
    expect(scoped.ticketScope('OTHER-12')).toEqual({
      kind: 'out_of_scope',
      scope: ['ACME', 'OPS'],
    });
    // The prefix, not a substring: `ACMEX` is another project.
    expect(scoped.ticketScope('ACMEX-1').kind).toBe('out_of_scope');
    expect(portWith([]).ticketScope('OTHER-12')).toEqual({ kind: 'unscoped' });
  });
});
