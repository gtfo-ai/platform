/**
 * The provider registry (technical/06, BD-017).
 *
 * The assertion that earns this file its place is the `secretFields` one: a typo there is
 * invisible in review and would have the field stored and rendered as ordinary configuration
 * (BD-002). The check turns it into a boot failure.
 */
import { noSecretsRedactor } from '@platform/application';
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

    const port = found.create({
      integrationId: INTEGRATION_ID,
      config: {},
      secrets: {},
      // Required since WP-11 (standing rule 31): a provider cannot be constructed without one.
      redactor: noSecretsRedactor(),
    });
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

/**
 * The git credential declaration TD-026 added (WP-18a).
 *
 * Same shape as the `secretFields` check above and for the same reason: the knowledge indexer
 * fetches a project's repository with the value this names, so a field that is not a *secret* field
 * would be a credential stored and rendered as ordinary configuration, and a typo would be
 * indistinguishable from a binding nobody gave a token to.
 */
describe('a git provider’s static credential declaration', () => {
  const gitRegistration = (gitCredential: unknown): AnyProviderRegistration =>
    ({
      ...registration(),
      id: 'fake-git-provider',
      type: 'git',
      create: () => {
        throw new Error('not built in this test');
      },
      gitCredential,
    }) as AnyProviderRegistration;

  it('accepts a field that is declared secret', () => {
    const registry = createIntegrationRegistry([
      gitRegistration({ passwordField: 'api_token', username: 'oauth2' }),
    ]);
    expect(registry.get('git', 'fake-git-provider').gitCredential).toEqual({
      passwordField: 'api_token',
      username: 'oauth2',
    });
  });

  it('refuses a field that is not in secretFields', () => {
    expect(() =>
      createIntegrationRegistry([
        gitRegistration({ passwordField: 'base_url', username: 'oauth2' }),
      ]),
    ).toThrow(/not in secretFields/);
  });

  it('refuses a blank username, which git would send verbatim', () => {
    expect(() =>
      createIntegrationRegistry([gitRegistration({ passwordField: 'api_token', username: ' ' })]),
    ).toThrow(ProviderRegistrationError);
  });

  it('refuses the declaration on a provider that is not a git provider', () => {
    expect(() =>
      createIntegrationRegistry([
        {
          ...registration(),
          gitCredential: { passwordField: 'api_token', username: 'oauth2' },
        } as AnyProviderRegistration,
      ]),
    ).toThrow(/only a git binding/);
  });

  it('is what the shipped GitLab provider declares', async () => {
    const { gitlabProviderRegistration } = await import('./providers/gitlab/index.js');
    // The value production fetches with: GitLab takes any non-blank username beside a token.
    expect(gitlabProviderRegistration.gitCredential).toEqual({
      passwordField: 'token',
      username: 'oauth2',
    });
    expect(gitlabProviderRegistration.secretFields).toContain('token');
  });
});
