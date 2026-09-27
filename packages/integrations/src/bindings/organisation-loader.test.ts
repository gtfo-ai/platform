/**
 * The organisation's own chat account, built with no binding (WP-65, PROGRESS backlog 80).
 *
 * The branches are the point, as in `loader.test.ts` (standing rule 10): *no account*, *an account
 * whose own config names no channel* and *two accounts that do* are three different facts, and the
 * last one is a refusal rather than a coin toss. Each refusal asserts its message.
 */
import type { IntegrationAccount, SecretStore } from '@platform/application';
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  noRunScopedSecrets,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { createFakeCommunication } from '../communication/fake.js';
import { createIntegrationRegistry } from '../registry.js';
import {
  FAKE_COMMUNICATION_PROVIDER_ID,
  fakeCommunicationRegistration,
} from './fake-registrations.js';
import { BindingLoadError } from './loader.js';
import { createOrganisationIntegrationsLoader } from './organisation-loader.js';

const CHAT = '00000000-0000-4000-8000-00000000a0c1' as Id;
const SECOND = '00000000-0000-4000-8000-00000000a0c2' as Id;
/** Obviously fake (BD-002), long enough for the exact redactor to take it. */
const TOKEN = 'FAKE-org-chat-token-not-a-real-secret-01';

const account = (overrides: Partial<IntegrationAccount> = {}): IntegrationAccount => ({
  integrationId: CHAT,
  type: 'communication',
  provider: FAKE_COMMUNICATION_PROVIDER_ID,
  name: 'acme chat',
  config: { channel: '#org-alerts' },
  secretIds: ['00000000-0000-4000-8000-00000000e0c1' as Id],
  bindings: [],
  ...overrides,
});

const secrets: SecretStore = { resolve: async () => ({ token: TOKEN }) };

const loaderOf = (accounts: readonly IntegrationAccount[]) => {
  const executor = createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog: createMemoryAuditLog(),
    redactor: exactSecretRedactor([]),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
  });
  const fake = createFakeCommunication({ integrationId: CHAT, channels: ['#org-alerts'] });
  return createOrganisationIntegrationsLoader({
    communicationAccounts: async () => accounts,
    secrets,
    registry: createIntegrationRegistry([
      fakeCommunicationRegistration({ port: fake, token: TOKEN }),
    ]),
    executor,
  });
};

describe('the organisation’s own chat account', () => {
  it('builds the account with no binding, on its own channel, with its credential redacted', async () => {
    const integrations = await loaderOf([account()]).forOrganisation(noRunScopedSecrets());
    expect(integrations.git).toBeNull();
    expect(integrations.taskManagement).toBeNull();
    expect(integrations.communication?.channel).toBe('#org-alerts');
    expect(integrations.communication?.ref.integrationId).toBe(CHAT);
    // The account's own credential is in the redactor it hands out for the text the band stores.
    expect(integrations.communication?.redactor.redactText(`leak ${TOKEN}`).value).not.toContain(
      TOKEN,
    );
  });

  it('answers no channel for an organisation with no chat account', async () => {
    const integrations = await loaderOf([]).forOrganisation(noRunScopedSecrets());
    expect(integrations.communication).toBeNull();
  });

  it('answers no channel for an account whose own config names none — never a project’s', async () => {
    // Every binding may carry its own channel and leave the account's empty; that is the
    // organisation choosing no channel of its own, not a broken account.
    const integrations = await loaderOf([account({ config: {} })]).forOrganisation(
      noRunScopedSecrets(),
    );
    expect(integrations.communication).toBeNull();
  });

  it('refuses two accounts that each name a channel, by name, rather than choosing by sort order', async () => {
    const loader = loaderOf([
      account(),
      account({ integrationId: SECOND, name: 'other chat', config: { channel: '#elsewhere' } }),
    ]);
    await expect(loader.forOrganisation(noRunScopedSecrets())).rejects.toThrow(BindingLoadError);
    await expect(loader.forOrganisation(noRunScopedSecrets())).rejects.toThrow(
      /2 communication accounts that name a channel of their own \(fake-communication\/acme chat, fake-communication\/other chat\)/,
    );
  });

  it('refuses an account whose provider this build does not register', async () => {
    await expect(
      loaderOf([account({ provider: 'carrier-pigeon' })]).forOrganisation(noRunScopedSecrets()),
    ).rejects.toThrow(/names provider "carrier-pigeon", which this build does not register/);
  });

  it('refuses an account whose config fails the provider’s schema, naming the path and never a value', async () => {
    const refused = loaderOf([account({ config: { channel: '#org-alerts', unknown_key: TOKEN } })])
      .forOrganisation(noRunScopedSecrets())
      .catch((error: unknown) => error as Error);
    const error = (await refused) as Error;
    expect(error).toBeInstanceOf(BindingLoadError);
    expect(error.message).toMatch(/fails its schema/);
    expect(error.message).not.toContain(TOKEN);
  });
});
