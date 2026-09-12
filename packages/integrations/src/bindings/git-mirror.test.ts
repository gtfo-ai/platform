/**
 * The knowledge mirror's credential loader (WP-18a, TD-026).
 *
 * Three answers, and the whole point of the file is that they are three and not one: a project with
 * no git binding (`null`), a binding that cannot be read (throw), and a binding whose declared
 * credential field is empty (throw). Collapsing any of them into "no credential, fetch anyway" is a
 * mirror that works against a public repository and fails against every private one — standing
 * rules 16 and 18, with the same shape `loader.ts` keeps for the pipeline's bindings.
 */
import type { BindingRepository, ProjectBinding, SecretStore } from '@platform/application';
import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import * as z from 'zod';
import { type AnyProviderRegistration, createIntegrationRegistry } from '../registry.js';
import { createGitMirrorCredentials, GitMirrorCredentialError } from './git-mirror.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const INTEGRATION = '00000000-0000-4000-8000-0000000000b2' as Id;
const SECRET = '00000000-0000-4000-8000-0000000000b3' as Id;
const TOKEN = 'glpat-FAKE-mirror-credential-000000';

const gitRegistration = (
  gitCredential: AnyProviderRegistration['gitCredential'],
): AnyProviderRegistration =>
  ({
    id: 'fake-git',
    type: 'git',
    displayName: 'Fake git',
    configSchema: z.strictObject({ base_url: z.url(), token: z.string().optional() }),
    secretFields: ['token'],
    setupGuidePath: 'providers/fake/setup-guide.md',
    agentTooling: null,
    gitCredential,
    create: () => {
      throw new Error('the mirror never builds the port');
    },
  }) as AnyProviderRegistration;

const binding = (overrides: Partial<ProjectBinding> = {}): ProjectBinding => ({
  bindingId: '00000000-0000-4000-8000-0000000000b4' as Id,
  integrationId: INTEGRATION,
  type: 'git',
  provider: 'fake-git',
  name: 'the repository',
  config: { base_url: 'https://git.example.test' },
  secretIds: [SECRET],
  ...overrides,
});

const credentials = (options: {
  readonly bindings: readonly ProjectBinding[];
  readonly secrets?: Readonly<Record<string, string>>;
  readonly secretsThrow?: Error;
  /** `null` means the provider declares none at all; absent means the ordinary declaration. */
  readonly declaration?: AnyProviderRegistration['gitCredential'] | null;
}) =>
  createGitMirrorCredentials({
    repository: {
      forProject: async () => options.bindings,
      forIntegration: async () => null,
    } satisfies BindingRepository,
    secrets: {
      resolve: async () => {
        if (options.secretsThrow !== undefined) throw options.secretsThrow;
        return options.secrets ?? { token: TOKEN };
      },
    } as SecretStore,
    registry: createIntegrationRegistry([
      gitRegistration(
        options.declaration === undefined
          ? { passwordField: 'token', username: 'oauth2' }
          : (options.declaration ?? undefined),
      ),
    ]),
  });

/** The refusal, as an `Error` — `.catch()` on the promise would widen it to the success type too. */
const refusal = async (promise: Promise<unknown>): Promise<Error> => {
  try {
    await promise;
  } catch (cause) {
    return cause as Error;
  }
  throw new Error('expected a refusal and got a credential');
};

describe('createGitMirrorCredentials', () => {
  it('resolves the field the provider declares, with the username it declares', async () => {
    const resolved = await credentials({ bindings: [binding()] }).forProject(PROJECT);
    expect(resolved).toEqual({ username: 'oauth2', password: TOKEN });
  });

  it('answers null for a project with no git binding', async () => {
    const resolved = await credentials({
      bindings: [binding({ type: 'task_management', provider: 'fake-git' })],
    }).forProject(PROJECT);
    expect(resolved).toBeNull();
  });

  it('refuses two git bindings rather than choosing one by sort order', async () => {
    await expect(
      credentials({
        bindings: [binding(), binding({ name: 'the other repository' })],
      }).forProject(PROJECT),
    ).rejects.toThrow(/2 "git" bindings/);
  });

  it('refuses a provider this build does not register', async () => {
    await expect(
      credentials({ bindings: [binding({ provider: 'github' })] }).forProject(PROJECT),
    ).rejects.toThrow(/does not register/);
  });

  it('refuses a provider that declares no static git credential', async () => {
    await expect(
      credentials({ bindings: [binding()], declaration: null }).forProject(PROJECT),
    ).rejects.toBeInstanceOf(GitMirrorCredentialError);
  });

  it('refuses a credential that will not decrypt, and never names the value', async () => {
    const error = await refusal(
      credentials({
        bindings: [binding()],
        secretsThrow: new Error('key id kid-2 is unknown'),
      }).forProject(PROJECT),
    );
    expect(error.message).toContain('cannot be read');
    expect(error.message).toContain('kid-2');
  });

  it('refuses an empty credential rather than fetching anonymously', async () => {
    const empties: Readonly<Record<string, string>>[] = [{}, { token: '' }];
    for (const secrets of empties) {
      const error = await refusal(
        credentials({ bindings: [binding()], secrets }).forProject(PROJECT),
      );
      expect(error).toBeInstanceOf(GitMirrorCredentialError);
      expect(error.message).toContain('an empty credential is not a credential');
    }
  });

  it('never puts the credential in the message of a refusal it does report', async () => {
    const error = await refusal(
      credentials({ bindings: [binding(), binding({ name: 'second' })] }).forProject(PROJECT),
    );
    expect(error.message).not.toContain(TOKEN);
  });
});
