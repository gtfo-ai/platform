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

/**
 * WP-80, TD-012's M5 amendment — criterion (3): a provider that declares credential minting must
 * declare that its minted values have a stable shape, or it is refused **at registration, by
 * name**. Without the shape a minted value would be redacted only in the process that minted it.
 */
describe('a git provider’s credential-minting declaration (WP-80)', () => {
  const minting = (credentialMinting: unknown): AnyProviderRegistration =>
    ({
      ...registration(),
      id: 'fake-minting-git',
      type: 'git',
      create: () => {
        throw new Error('not built in this test');
      },
      credentialMinting,
    }) as AnyProviderRegistration;

  const HINTS = { enable: 'turn minting on here', shape: 'declare the prefix there' };

  it('accepts a declaration of a stable shape', () => {
    const registry = createIntegrationRegistry([minting({ shape: 'stable', hints: HINTS })]);
    expect(registry.get('git', 'fake-minting-git').credentialMinting).toEqual({
      shape: 'stable',
      hints: HINTS,
    });
  });

  /** WP-107 (PROGRESS backlog 278): the refusals' fixes are the provider's words, so they must exist. */
  it.each([
    ['no hints', { shape: 'stable' }],
    ['a blank enable hint', { shape: 'stable', hints: { ...HINTS, enable: ' ' } }],
    ['no shape hint', { shape: 'stable', hints: { enable: HINTS.enable } }],
  ])('refuses minting declared with %s, naming the provider', (_case, declaration) => {
    expect(() => createIntegrationRegistry([minting(declaration)])).toThrow(
      /provider "fake-minting-git": declares credential minting without both hints/,
    );
  });

  it.each([
    ['an unstable shape', { shape: 'unstable' }],
    ['no shape at all', {}],
  ])('refuses minting declared with %s, naming the provider', (_case, declaration) => {
    const refusal = (() => {
      try {
        createIntegrationRegistry([minting(declaration)]);
        return null;
      } catch (error) {
        return error;
      }
    })();
    expect(refusal).toBeInstanceOf(ProviderRegistrationError);
    expect((refusal as ProviderRegistrationError).providerId).toBe('fake-minting-git');
    expect((refusal as Error).message).toMatch(
      /provider "fake-minting-git": declares credential minting without a stable credential shape/,
    );
  });

  it('refuses the declaration on a provider that is not a git provider', () => {
    expect(() =>
      createIntegrationRegistry([
        {
          ...registration(),
          credentialMinting: { shape: 'stable', hints: HINTS },
        } as AnyProviderRegistration,
      ]),
    ).toThrow(/only a git binding mints run credentials/);
  });

  it('is what both git registrations this repository ships declare', async () => {
    const { gitlabProviderRegistration } = await import('./providers/gitlab/index.js');
    const { fakeGitRegistration } = await import('./bindings/fake-registrations.js');
    expect(gitlabProviderRegistration.credentialMinting).toMatchObject({ shape: 'stable' });
    expect(
      fakeGitRegistration({ port: null as never, token: 'fake-token-000' }).credentialMinting,
    ).toMatchObject({ shape: 'stable' });
  });
});

/**
 * WP-137 (TD-028 decision 13 item 1): a static run credential's declaration names keys of the
 * provider's schema, its two token fields are secrets and distinct, and only a git provider has one —
 * each refused at registration, by name. GitLab's own declaration is the control.
 */
describe('a git provider’s static run credential declaration (WP-137)', () => {
  const SUPPORT = {
    modeField: 'run_credential',
    tokenField: 'run_token',
    apiTokenField: 'token',
    usernameField: 'run_token_username',
    expiresAtField: 'run_token_expires_at',
    mintingField: 'mint_credentials',
    maxLifetimeDays: 90,
  };
  const declaring = (
    staticRunCredential: unknown,
    overrides: Record<string, unknown> = {},
  ): AnyProviderRegistration =>
    ({
      ...registration(),
      id: 'fake-static-git',
      type: 'git',
      configSchema: z.strictObject({
        token: z.string(),
        run_token: z.string().nullish(),
        run_credential: z.enum(['minted', 'static']).default('minted'),
        run_token_username: z.string().nullish(),
        run_token_expires_at: z.string().nullish(),
        mint_credentials: z.boolean().default(false),
      }),
      secretFields: ['token', 'run_token'],
      create: () => {
        throw new Error('not built in this test');
      },
      staticRunCredential,
      ...overrides,
    }) as AnyProviderRegistration;

  it('accepts a declaration over the schema’s own keys, and GitLab ships one', async () => {
    expect(() => createIntegrationRegistry([declaring(SUPPORT)])).not.toThrow();
    const { gitlabProviderRegistration } = await import('./providers/gitlab/index.js');
    expect(() => createIntegrationRegistry([gitlabProviderRegistration])).not.toThrow();
  });

  it.each([
    [
      'a key the schema lacks',
      { ...SUPPORT, usernameField: 'nope' },
      {},
      /field "nope" does not exist/,
    ],
    [
      'a run token that is not a secret',
      SUPPORT,
      { secretFields: ['token'] },
      /"run_token" is not in secretFields/,
    ],
    ['one field for both tokens', { ...SUPPORT, tokenField: 'token' }, {}, /declared as one field/],
    [
      'a provider that is not git',
      SUPPORT,
      { type: 'task_management' },
      /only a git binding gives a run a credential/,
    ],
  ])('refuses %s, naming the provider', (_case, support, overrides, message) => {
    expect(() => createIntegrationRegistry([declaring(support, overrides)])).toThrow(message);
  });
});

/**
 * The channel declaration WP-32 added, and the boot failure it exists to be.
 *
 * A `communication` provider that declared nothing would resolve to a binding with **no channel**,
 * and the symptom would be a notification nobody received — a failure with no error, which is the
 * kind this file exists to convert into a refusal an operator can read.
 */
describe('a communication provider’s channel declaration', () => {
  const chatRegistration = (
    communicationChannels: unknown,
    configShape: Record<string, z.ZodType> = { channel: z.string().min(1) },
  ): AnyProviderRegistration =>
    ({
      ...registration(),
      id: 'fake-chat-provider',
      type: 'communication',
      configSchema: z.strictObject(configShape),
      secretFields: [],
      create: () => {
        throw new Error('not built in this test');
      },
      communicationChannels,
    }) as AnyProviderRegistration;

  it('accepts a declaration whose keys exist in the config schema', () => {
    const registry = createIntegrationRegistry([
      chatRegistration(
        { channel: 'channel', digestChannel: 'digest_channel' },
        {
          channel: z.string().min(1),
          digest_channel: z.string().min(1).nullish(),
        },
      ),
    ]);
    expect(registry.get('communication', 'fake-chat-provider').communicationChannels).toEqual({
      channel: 'channel',
      digestChannel: 'digest_channel',
    });
  });

  it('refuses a communication provider that declares no channel at all', () => {
    expect(() => createIntegrationRegistry([chatRegistration(undefined)])).toThrow(
      /declares no communicationChannels/,
    );
  });

  it('refuses a key that does not exist in the config schema', () => {
    expect(() =>
      createIntegrationRegistry([chatRegistration({ channel: 'conversation' })]),
    ).toThrow(/channel field "conversation" does not exist/);
    expect(() =>
      createIntegrationRegistry([
        chatRegistration({ channel: 'channel', digestChannel: 'nowhere' }),
      ]),
    ).toThrow(/channel field "nowhere" does not exist/);
  });

  it('refuses the declaration on a provider of another type', () => {
    expect(() =>
      createIntegrationRegistry([
        {
          ...registration(),
          communicationChannels: { channel: 'channel' },
        } as AnyProviderRegistration,
      ]),
    ).toThrow(/declares communicationChannels but is a "task_management" provider/);
  });

  it('is what the shipped Slack provider declares', async () => {
    const { slackProviderRegistration } = await import('./providers/slack/index.js');
    expect(slackProviderRegistration.communicationChannels).toEqual({
      channel: 'channel',
      digestChannel: 'digest_channel',
    });
  });
});
