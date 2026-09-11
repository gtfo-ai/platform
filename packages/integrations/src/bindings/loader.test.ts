/**
 * The binding loader's tests (WP-15a).
 *
 * Two things are being held here, and only one of them is the happy path.
 *
 * The first is **which branch ran** (standing rule 10): a project with no git binding and a project
 * whose git binding is broken both end with the pipeline not calling GitLab, and they are not the
 * same fact. One resolves to `git: null` and the sagas park the task with a brief; the other throws
 * and the job retries and then escalates. Every refusal below asserts the message, not merely that
 * something was thrown.
 *
 * The second is **rule 35**: making `ProviderCreateInput.redactor` required proved that an adapter
 * is *handed* a redactor, and nothing more — the type is checked where the object is built. So the
 * redaction test plants two credentials the platform knows about, drives the **real** GitLab
 * adapter through the **real** `gitlabProviderRegistration`, and greps what `getJobLog` hands back.
 * One of the two is the run-scoped credential Q55 is about, which no binding could have known.
 */
import type {
  BindingRepository,
  GitProviderPort,
  ProjectBinding,
  SecretStore,
} from '@platform/application';
import {
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  SecretResolutionError,
} from '@platform/application';
import type { Id, IsoDateTime } from '@platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import type { AnyProviderRegistration } from '../registry.js';
import { createIntegrationRegistry } from '../registry.js';
import { BindingLoadError, createPipelineIntegrationsLoader } from './loader.js';
import { createPipelineProviderRegistry } from './shipped-registry.js';

const PROJECT = '00000000-0000-4000-8000-0000000000b1' as Id;
const GIT_INTEGRATION = '00000000-0000-4000-8000-00000000a001' as Id;
const GIT_BINDING = '00000000-0000-4000-8000-00000000d001' as Id;

/** Obviously fake, and long enough that `MIN_SECRET_LENGTH` does not skip it. */
const BINDING_TOKEN = 'glpat-FAKE-not-a-real-binding-token-0001';
const RUN_TOKEN = 'glpat-FAKE-not-a-real-run-scoped-token-0002';

const gitBinding = (overrides: Partial<ProjectBinding> = {}): ProjectBinding => ({
  bindingId: GIT_BINDING,
  integrationId: GIT_INTEGRATION,
  type: 'git',
  provider: 'gitlab',
  name: 'acme gitlab',
  config: { base_url: 'https://git.example.test', project: 'acme/api' },
  secretIds: ['00000000-0000-4000-8000-00000000e001' as Id],
  ...overrides,
});

const repositoryOf = (bindings: readonly ProjectBinding[]): BindingRepository => ({
  forProject: async () => bindings,
  // The project loader never asks the integration side; a fake that answered would be kinder than
  // the adapter, which is standing rule 1's forbidden direction.
  forIntegration: async () => {
    throw new Error('the project loader must not resolve an integration by id');
  },
});

const secretsOf = (
  resolved: Readonly<Record<string, string>> | Error = { token: BINDING_TOKEN },
): SecretStore => ({
  resolve: async () => {
    if (resolved instanceof Error) {
      throw resolved;
    }
    return resolved;
  },
});

const executor = () =>
  createIntegrationActionExecutor({
    auditLog: createMemoryAuditLog(),
    redactor: exactSecretRedactor([]),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
  });

interface LoaderOptions {
  readonly bindings?: readonly ProjectBinding[];
  readonly secrets?: Readonly<Record<string, string>> | Error;
  /** Replaces the shipped registry; only the forgetful-provider case uses it. */
  readonly registrations?: readonly AnyProviderRegistration[];
}

const loaderFor = (options: LoaderOptions = {}) => {
  const actions = executor();
  return createPipelineIntegrationsLoader({
    repository: repositoryOf(options.bindings ?? [gitBinding()]),
    secrets: secretsOf(options.secrets ?? { token: BINDING_TOKEN }),
    // The registry the composition root ships, not one assembled for the test: a loader held to a
    // registry of its own would pass with a provider list production does not have.
    registry:
      options.registrations === undefined
        ? createPipelineProviderRegistry({
            executor: actions,
            clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
          })
        : createIntegrationRegistry(options.registrations),
    executor: actions,
    gitProjectPath: async () => 'acme/api',
  });
};

const outsideARun = { runScopedSecrets: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a project with no bindings', () => {
  it('resolves to null for both, which is absent rather than broken', async () => {
    const integrations = await loaderFor({ bindings: [] }).forProject(PROJECT, outsideARun);
    expect(integrations.git).toBeNull();
    expect(integrations.taskManagement).toBeNull();
  });
});

describe('a binding that cannot be built', () => {
  it('refuses a provider this build does not register, naming the provider', async () => {
    const loader = loaderFor({ bindings: [gitBinding({ provider: 'github' })] });
    await expect(loader.forProject(PROJECT, outsideARun)).rejects.toThrow(
      /names provider "github", which this build does not register/,
    );
  });

  it('refuses configuration that fails the provider schema, naming the path and not the value', async () => {
    const loader = loaderFor({
      bindings: [gitBinding({ config: { base_url: 'https://git.example.test/api/v4' } })],
    });
    const error = await loader.forProject(PROJECT, outsideARun).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BindingLoadError);
    expect((error as Error).message).toContain('fails its schema at: base_url');
    expect((error as Error).message).not.toContain(BINDING_TOKEN);
  });

  it('refuses a credential that will not resolve, rather than building the adapter without it', async () => {
    const loader = loaderFor({
      secrets: new SecretResolutionError('secret … is sealed under key "v1:old"', []),
    });
    await expect(loader.forProject(PROJECT, outsideARun)).rejects.toThrow(
      /has credentials that cannot be read: secret … is sealed under key/,
    );
  });

  it('refuses two bindings of one type rather than choosing by sort order', async () => {
    const loader = loaderFor({
      bindings: [
        gitBinding(),
        gitBinding({
          bindingId: '00000000-0000-4000-8000-00000000d002' as Id,
          integrationId: '00000000-0000-4000-8000-00000000a003' as Id,
          name: 'second gitlab',
        }),
      ],
    });
    await expect(loader.forProject(PROJECT, outsideARun)).rejects.toThrow(
      /has 2 "git" bindings \(gitlab\/acme gitlab, gitlab\/second gitlab\)/,
    );
  });
});

describe('a git binding that loads', () => {
  it('carries the integration id and the project path the composition root resolved', async () => {
    const integrations = await loaderFor().forProject(PROJECT, outsideARun);
    expect(integrations.git?.ref).toEqual({
      integrationId: GIT_INTEGRATION,
      provider: 'gitlab',
      type: 'git',
    });
    expect(integrations.git?.project).toBe('acme/api');
  });

  /**
   * Rule 35, and the only test in this file that proves *behaviour* rather than supply.
   *
   * The trace GitLab hands back carries both credentials the platform knows about. The binding's
   * own token the adapter could have found for itself; the run-scoped one it could not — it did not
   * exist when `create()` ran, which is the whole of Q55. Deleting the `scope.runScopedSecrets`
   * half of the composed redactor in `loader.ts` leaves every other test in this file green and
   * kills this one by name.
   */
  it('keeps a run-scoped credential out of what a provider returns', async () => {
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/trace')) {
        return new Response(
          `$ deploy --token ${RUN_TOKEN}\nusing PRIVATE-TOKEN ${BINDING_TOKEN}\nexit 1\n`,
          { status: 200, headers: { 'content-type': 'text/plain' } },
        );
      }
      throw new Error(`the test did not script ${url}`);
    });

    const integrations = await loaderFor().forProject(PROJECT, {
      runScopedSecrets: [{ name: 'run:credential', value: RUN_TOKEN }],
    });
    const log = await integrations.git?.port.getJobLog('acme/api', '42');

    expect(log).not.toContain(RUN_TOKEN);
    expect(log).not.toContain(BINDING_TOKEN);
    expect(log).toContain('[REDACTED:integration:run:credential]');
    expect(log).toContain('exit 1');
  });
});

/**
 * The seam standing rule 22 asks for.
 *
 * `forgetfulGitProvider` is WP-11's defect as a fixture: an adapter that *uses* the redactor it is
 * handed and composes **none** of its own over its resolved credentials — which is precisely what
 * GitLab did until the redaction follow-up, and what `emitted-secrets.test.ts` catches for the two
 * providers it enumerates by hand. It is here so the loader's own half of the composed redactor has
 * a branch that executes, rather than sitting behind two adapters that make it unreachable.
 */
const forgetfulGitProvider = (): AnyProviderRegistration => ({
  id: 'forgetful-git',
  type: 'git',
  displayName: 'A git provider that composes no redactor of its own',
  configSchema: z.strictObject({ base_url: z.url(), token: z.string().nullish() }),
  secretFields: ['token'],
  setupGuidePath: 'packages/integrations/src/bindings/loader.test.ts',
  agentTooling: null,
  create: ({ integrationId, secrets, redactor }) =>
    ({
      ref: { integrationId, provider: 'forgetful-git', type: 'git' },
      capabilities: () => ({}),
      getJobLog: async () =>
        redactor.redactText(`$ push --token ${String(secrets.token)}\nexit 1`).value,
    }) as unknown as GitProviderPort,
});

describe('a provider that composes no redactor of its own', () => {
  it('redacts a credential the provider does not redact for itself', async () => {
    const integrations = await loaderFor({
      registrations: [forgetfulGitProvider()],
      bindings: [
        gitBinding({ provider: 'forgetful-git', config: { base_url: 'https://git.example.test' } }),
      ],
    }).forProject(PROJECT, outsideARun);

    const log = await integrations.git?.port.getJobLog('acme/api', '42');
    expect(log).not.toContain(BINDING_TOKEN);
    expect(log).toContain(`[REDACTED:integration:forgetful-git:${GIT_INTEGRATION}:token]`);
    expect(log).toContain('exit 1');
  });
});

describe('a task-management binding that loads', () => {
  it('is instantiated through its own registration and carries its ref', async () => {
    const integrations = await loaderFor({
      bindings: [
        {
          bindingId: '00000000-0000-4000-8000-00000000d003' as Id,
          integrationId: '00000000-0000-4000-8000-00000000a002' as Id,
          type: 'task_management',
          provider: 'jira-cloud',
          name: 'acme jira',
          config: {
            site_url: 'https://acme-example.atlassian.net',
            user_email: 'bot@example.test',
          },
          secretIds: [],
        },
      ],
      secrets: { api_token: 'FAKE-jira-token-0001' },
    }).forProject(PROJECT, outsideARun);

    expect(integrations.git).toBeNull();
    expect(integrations.taskManagement?.ref).toEqual({
      integrationId: '00000000-0000-4000-8000-00000000a002',
      provider: 'jira-cloud',
      type: 'task_management',
    });
  });
});
