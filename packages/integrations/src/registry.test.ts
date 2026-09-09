/**
 * The provider registry (technical/06, BD-017).
 *
 * The assertion that earns this file its place is the `secretFields` one: a typo there is
 * invisible in review and would have the field stored and rendered as ordinary configuration
 * (BD-002). The check turns it into a boot failure.
 */
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import {
  type AnyProviderRegistration,
  createIntegrationRegistry,
  ProviderRegistrationError,
} from './registry.js';
import { createFakeTaskManagement } from './task-management/fake.js';

const INTEGRATION_ID = '00000000-0000-4000-8000-0000000000a1';

const registration = (overrides: Partial<AnyProviderRegistration> = {}): AnyProviderRegistration =>
  ({
    id: 'fake-tickets',
    type: 'task_management',
    displayName: 'Fake tickets',
    configSchema: z.strictObject({
      base_url: z.url(),
      api_token: z.string().min(1),
    }),
    secretFields: ['api_token'],
    setupGuidePath: 'providers/fake/setup-guide.md',
    agentTooling: null,
    create: () => createFakeTaskManagement({ integrationId: INTEGRATION_ID }),
    ...overrides,
  }) as AnyProviderRegistration;

describe('createIntegrationRegistry', () => {
  it('registers a provider and hands it back by type and id', () => {
    const registry = createIntegrationRegistry([registration()]);
    const found = registry.get('task_management', 'fake-tickets');
    expect(found.displayName).toBe('Fake tickets');
    expect(registry.has('fake-tickets')).toBe(true);

    const port = found.create({ integrationId: INTEGRATION_ID, config: {}, secrets: {} });
    expect(port.ref.type).toBe('task_management');
  });

  it('refuses a secret field the config schema does not have (BD-002)', () => {
    expect(() => createIntegrationRegistry([registration({ secretFields: ['api_tokn'] })])).toThrow(
      ProviderRegistrationError,
    );
    expect(() => createIntegrationRegistry([registration({ secretFields: ['api_tokn'] })])).toThrow(
      /does not exist in the config schema/,
    );
  });

  it('refuses a duplicate id and a non-slug id', () => {
    const registry = createIntegrationRegistry([registration()]);
    expect(() => registry.register(registration())).toThrow(/already registered/);
    expect(() => registry.register(registration({ id: 'Fake_Tickets' }))).toThrow(
      /lower-case slug/,
    );
  });

  it('refuses to hand a provider of one type to a caller wanting another', () => {
    const registry = createIntegrationRegistry([registration()]);
    expect(() => registry.get('git', 'fake-tickets')).toThrow(
      /is a "task_management" provider, not "git"/,
    );
    expect(() => registry.get('task_management', 'nope')).toThrow(/is not registered/);
  });

  it('lists everything, or one type, in a stable order', () => {
    const registry = createIntegrationRegistry([
      registration({ id: 'zeta-tickets' }),
      registration({ id: 'alpha-git', type: 'git' } as Partial<AnyProviderRegistration>),
      registration(),
    ]);

    expect(registry.list().map((entry) => entry.id)).toEqual([
      'alpha-git',
      'fake-tickets',
      'zeta-tickets',
    ]);
    expect(registry.list('git').map((entry) => entry.id)).toEqual(['alpha-git']);
  });
});
