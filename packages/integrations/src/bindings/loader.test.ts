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
  IntegrationAccount,
  ProjectBinding,
  SecretRedactor,
  SecretStore,
} from '@platform/application';
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  exactSecretRedactor,
  FAKE_DEPLOY_KEY,
  SecretResolutionError,
  staticRunTokenLeaks,
} from '@platform/application';
import type { Id, IsoDateTime, JsonObject } from '@platform/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as z from 'zod';
import { secretFieldsOf } from '../catalogue.js';
import { GITLAB_CREDENTIAL_MINTING_HINTS } from '../providers/gitlab/index.js';
import type { AnyProviderRegistration } from '../registry.js';
import { createIntegrationRegistry } from '../registry.js';
import {
  BindingLoadError,
  createOrganisationAccountCredentialCheck,
  createPipelineIntegrationsLoader,
  createProjectBindingSecrets,
} from './loader.js';
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
  retired: false,
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
    // Declared open on purpose (WP-51): this file is not about the egress allow-list, and an
    // omitted policy is not a thing `IntegrationActionExecutorOptions` permits.
    egress: allowAnyIntegrationHost(),
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
  /** TD-012 step 2, as the composition root passes it (WP-15f). */
  readonly platformRedactor?: SecretRedactor;
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
            // Socket Mode's backoff; nothing here opens a socket (WP-43).
            timer: { now: () => 0, sleep: async () => {} },
          })
        : createIntegrationRegistry(options.registrations),
    executor: actions,
    gitProjectPath: async () => 'acme/api',
    ...(options.platformRedactor === undefined
      ? {}
      : { platformRedactor: options.platformRedactor }),
  });
};

const outsideARun = { runScopedSecrets: [] };

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * WP-137 review round 1: the dependency gate's leak search over a diff the **real** GitLab adapter
 * returns, built by this loader with `run_token` sealed. The binding's redactor knows the run token,
 * so the transport hands back its placeholder rather than the value — the search must still find it,
 * or a token pushed into the repository never parks the task against GitLab.
 */
describe('the static run token in a merge request read through the real GitLab adapter (WP-137)', () => {
  it('reaches the leak search as the binding’s placeholder, and the search finds it', async () => {
    const STATIC_TOKEN = 'glpat-FAKE-static-run-token-not-real-0009';
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.includes('/merge_requests/7/diffs')) {
        return new Response(
          JSON.stringify([
            {
              old_path: '.env',
              new_path: '.env',
              diff: `@@ -1 +1,2 @@\n APP=1\n+GITLAB_TOKEN=${STATIC_TOKEN}\n`,
              new_file: false,
              renamed_file: false,
              deleted_file: false,
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`the test did not script ${url}`);
    });
    const integrations = await loaderFor({
      bindings: [
        gitBinding({
          config: {
            base_url: 'https://git.example.test',
            project: 'acme/api',
            run_credential: 'static',
            run_token_username: 'agentic-runner',
            run_token_expires_at: '2026-12-01',
          },
        }),
      ],
      secrets: { token: BINDING_TOKEN, run_token: STATIC_TOKEN },
    }).forProject(PROJECT, outsideARun);
    const git = integrations.git;
    if (git === null) throw new Error('expected the git binding');
    const files = await git.port.getMergeRequestDiff(
      {
        provider: 'gitlab',
        project_path: 'acme/api',
        iid: 7,
        url: 'https://git.example.test/acme/api/-/merge_requests/7',
        branch: 'agentic/acme-1',
        head_sha: null,
      },
      { limit: 10 },
    );
    // The transport redacted it: the exact value is gone, the placeholder is in its place.
    expect(JSON.stringify(files)).not.toContain(STATIC_TOKEN);
    expect(git.staticRunCredential?.redactedAs).toBe(
      `[REDACTED:integration:gitlab:${GIT_INTEGRATION}:run_token]`,
    );
    expect(files[0]?.diff).toContain(git.staticRunCredential?.redactedAs);
    expect(staticRunTokenLeaks(git.staticRunCredential, files)).toBe(1);
  });
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

  it('refuses a binding of a retired integration by name, never reading it as absent (WP-114)', async () => {
    let resolved = 0;
    const loader = createPipelineIntegrationsLoader({
      repository: repositoryOf([gitBinding({ retired: true })]),
      secrets: {
        resolve: async () => {
          resolved += 1;
          return { token: BINDING_TOKEN };
        },
      },
      registry: createIntegrationRegistry([]),
      executor: executor(),
      gitProjectPath: async () => 'acme/api',
    });
    const error = await loader.forProject(PROJECT, outsideARun).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BindingLoadError);
    expect((error as BindingLoadError).integrationId).toBe(GIT_INTEGRATION);
    expect((error as Error).message).toMatch(/which is retired: its credentials are destroyed/);
    // Refused before anything is resolved or looked up: a retired row has no credential to read.
    expect(resolved).toBe(0);
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
      // The host the executor's egress allow-list decides on (`IntegrationRef.host`, WP-51).
      host: 'git.example.test',
    });
    expect(integrations.git?.project).toBe('acme/api');
  });

  /**
   * WP-107 (PROGRESS backlog 278): the mint refusals' hints are the provider's, read off the
   * registration the binding was built through — the shipped GitLab one here — never a sentence the
   * application ring keeps.
   */
  it('carries the minting hints its provider’s registration declares', async () => {
    const integrations = await loaderFor().forProject(PROJECT, outsideARun);
    expect(integrations.git?.mintingHints).toEqual(GITLAB_CREDENTIAL_MINTING_HINTS);
    // WP-137: an integration that declares no static run credential carries none.
    expect(integrations.git?.staticRunCredential).toBeUndefined();
  });

  /**
   * WP-137 (TD-028 decision 13 items 1–3): an integration with `run_credential: static` carries its
   * run token to the run-credential path — and only there: the binding's redactor knows it by exact
   * value, and the comparison with the API token is made on the decrypted values.
   */
  it('carries a static run credential to the run-credential path, redacted like any secret', async () => {
    const STATIC_TOKEN = 'glpat-FAKE-static-run-token-not-real-0003';
    const config = {
      base_url: 'https://git.example.test',
      project: 'acme/api',
      run_credential: 'static',
      run_token_username: 'agentic-runner',
      run_token_expires_at: '2026-12-01',
    };
    const integrations = await loaderFor({
      bindings: [gitBinding({ config })],
      secrets: { token: BINDING_TOKEN, run_token: STATIC_TOKEN },
    }).forProject(PROJECT, outsideARun);
    expect(integrations.git?.staticRunCredential).toEqual({
      owner: 'dedicated_user',
      username: 'agentic-runner',
      value: STATIC_TOKEN,
      expiresAt: '2026-12-01T00:00:00.000Z',
      declaredExpiry: '2026-12-01',
      sameAsApiToken: false,
      refusal: null,
      redactedAs: `[REDACTED:integration:gitlab:${GIT_INTEGRATION}:run_token]`,
    });
    expect(integrations.git?.redactor.redactText(`push ${STATIC_TOKEN}`).value).not.toContain(
      STATIC_TOKEN,
    );
    const same = await loaderFor({
      bindings: [gitBinding({ config })],
      secrets: { token: BINDING_TOKEN, run_token: BINDING_TOKEN },
    }).forProject(PROJECT, outsideARun);
    expect(same.git?.staticRunCredential?.sameAsApiToken).toBe(true);
  });

  it('carries a deploy key to the run-credential path with its route, redacted like any secret (WP-146)', async () => {
    const config = {
      base_url: 'https://gitlab.com',
      project: 'acme/api',
      run_credential: 'deploy_key',
      run_ssh_public_key: FAKE_DEPLOY_KEY.publicKey,
    };
    const integrations = await loaderFor({
      bindings: [gitBinding({ config })],
      secrets: { token: BINDING_TOKEN, run_ssh_private_key: FAKE_DEPLOY_KEY.privateKey },
    }).forProject(PROJECT, outsideARun);
    const loaded = integrations.git?.deployKeyRunCredential;
    expect(loaded).toMatchObject({
      privateKey: FAKE_DEPLOY_KEY.privateKey,
      publicKey: FAKE_DEPLOY_KEY.publicKey,
      refusal: null,
      redactedAs: `[REDACTED:integration:gitlab:${GIT_INTEGRATION}:run_ssh_private_key]`,
    });
    expect(loaded?.route?.connectHost).toBe('altssh.gitlab.com');
    expect(integrations.git?.staticRunCredential).toBeUndefined();
    expect(
      integrations.git?.redactor.redactText(`cat key\n${FAKE_DEPLOY_KEY.privateKey}`).value,
    ).not.toContain(FAKE_DEPLOY_KEY.privateKey);
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
          retired: false,
        },
      ],
      secrets: { api_token: 'FAKE-jira-token-0001' },
    }).forProject(PROJECT, outsideARun);

    expect(integrations.git).toBeNull();
    expect(integrations.taskManagement?.ref).toEqual({
      integrationId: '00000000-0000-4000-8000-00000000a002',
      provider: 'jira-cloud',
      type: 'task_management',
      // The host the executor's egress allow-list decides on (`IntegrationRef.host`, WP-51).
      host: 'acme-example.atlassian.net',
    });
  });

  /**
   * **The binding hands out the redactor it was built with, and TD-012 step 2 is in it** (WP-15f,
   * review round 1).
   *
   * The redactor on `TaskManagementBinding` is what bounds `tasks.ticket_snapshot` — the second
   * place the platform stores provider **text**, after `inbox`. Before this option existed the two
   * sinks of one provider call were treated oppositely: the executor holds a `patternRedactor` and
   * redacted the audit row, while the snapshot beside it kept a pasted credential verbatim and
   * rendered it into every prompt. `createInboundIntegrationLoader` takes the same option for the
   * same reason, three lines of composition away.
   *
   * The double here is a `SecretRedactor` rather than the shipped `patternRedactor()`, because this
   * ring may not import `@platform/infrastructure` (biome's ring overrides say so). What it asserts
   * is the **composition** — that the option reaches the binding and is applied *after* the
   * binding's own — and `apps/server/src/pipeline.ts` is where the shipped rules are passed;
   * `test/e2e/pipeline/webhook-ingress.e2e.test.ts` drives that composition with a planted token.
   */
  it('composes the platform’s own redactor into the one the binding hands out', async () => {
    const platformRedactor: SecretRedactor = {
      redactText: (text) =>
        text.includes('PLANTED-PATTERN')
          ? { value: text.replaceAll('PLANTED-PATTERN', '[REDACTED pattern]'), count: 1 }
          : { value: text, count: 0 },
      redactJson: (value) => ({ value, count: 0 }),
    };
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
          retired: false,
        },
      ],
      secrets: { api_token: 'FAKE-jira-token-0001' },
      platformRedactor,
    }).forProject(PROJECT, outsideARun);

    const redactor = integrations.taskManagement?.redactor;
    expect(redactor).toBeDefined();
    // The platform's rules…
    expect(redactor?.redactText('see PLANTED-PATTERN here')).toEqual({
      value: 'see [REDACTED pattern] here',
      count: 1,
    });
    // …composed **after** the binding's own, which still fires (standing rule 42: both halves).
    const both = redactor?.redactText('FAKE-jira-token-0001 and PLANTED-PATTERN');
    expect(both?.value).not.toContain('FAKE-jira-token-0001');
    expect(both?.value).not.toContain('PLANTED-PATTERN');
    expect(both?.count).toBe(2);
  });

  it('applies only the binding’s own redactor when no platform one is supplied', async () => {
    // The visible default, named rather than silent: the binding's redactor is never absent, so
    // the absent case here is *narrower* redaction and not *no* redaction (standing rule 31).
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
          retired: false,
        },
      ],
      secrets: { api_token: 'FAKE-jira-token-0001' },
    }).forProject(PROJECT, outsideARun);

    const redacted = integrations.taskManagement?.redactor.redactText(
      'FAKE-jira-token-0001 and PLANTED-PATTERN',
    );
    expect(redacted?.value).not.toContain('FAKE-jira-token-0001');
    expect(redacted?.value).toContain('PLANTED-PATTERN');
    expect(redacted?.count).toBe(1);
  });
});

/**
 * WP-80, TD-012's M5 amendment: the registration's declaration, not the adapter's flag, admits
 * credential minting. A port that reports `credentialMinting: true` from a registration that
 * declared no stable shape has the capability declined — its values could be redacted by no process
 * but the one that minted them.
 */
describe('credential minting a registration did not declare (WP-80)', () => {
  const claimingGit = (declared: boolean, minted: string[]): AnyProviderRegistration => ({
    id: 'claiming-git',
    type: 'git',
    displayName: 'A git provider whose port says it mints',
    configSchema: z.strictObject({ base_url: z.url(), token: z.string().nullish() }),
    secretFields: ['token'],
    setupGuidePath: 'packages/integrations/src/bindings/loader.test.ts',
    agentTooling: null,
    ...(declared
      ? {
          credentialMinting: {
            shape: 'stable' as const,
            hints: { enable: 'claiming-git: turn it on', shape: 'claiming-git: fix the prefix' },
          },
        }
      : {}),
    create: ({ integrationId }) =>
      ({
        ref: { integrationId, provider: 'claiming-git', type: 'git', host: null },
        capabilities: () => ({ credentialMinting: true, webhooks: true }),
        mintCredential: async () => {
          minted.push('asked');
          throw new Error('the provider was asked to mint');
        },
        getJobLog: async () => 'a log line',
      }) as unknown as GitProviderPort,
  });
  const bindingOf = () =>
    gitBinding({ provider: 'claiming-git', config: { base_url: 'https://git.example.test' } });

  it('declines it: the capability reads false and the provider is never asked', async () => {
    const minted: string[] = [];
    const integrations = await loaderFor({
      registrations: [claimingGit(false, minted)],
      bindings: [bindingOf()],
    }).forProject(PROJECT, outsideARun);
    const port = integrations.git?.port as GitProviderPort;

    expect(port.capabilities()).toMatchObject({ credentialMinting: false, webhooks: true });
    await expect(
      port.mintCredential({ project: 'acme/api', scope: 'read', ttlSeconds: 60 }),
    ).rejects.toMatchObject({ code: 'unsupported_capability' });
    expect(minted).toEqual([]);
    // Everything else passes through untouched.
    expect(await port.getJobLog('acme/api', '1')).toBe('a log line');
  });

  it('admits it when the registration declares a stable shape', async () => {
    const minted: string[] = [];
    const integrations = await loaderFor({
      registrations: [claimingGit(true, minted)],
      bindings: [bindingOf()],
    }).forProject(PROJECT, outsideARun);
    const port = integrations.git?.port as GitProviderPort;

    expect(port.capabilities().credentialMinting).toBe(true);
    await expect(
      port.mintCredential({ project: 'acme/api', scope: 'read', ttlSeconds: 60 }),
    ).rejects.toThrow(/asked to mint/);
    expect(minted).toEqual(['asked']);
  });
});

/**
 * WP-80, TD-028 decision 10: the integration that minted a run credential is built from its
 * **account**, whether or not any project still binds it, so the revoke reaches the host that issued
 * the address. `null` is the one answer for an integration row that is gone.
 */
describe('the minting integration (WP-80, TD-028 decision 10)', () => {
  const accountLoader = (
    account: Awaited<ReturnType<BindingRepository['forIntegration']>>,
    secrets: Readonly<Record<string, string>> | Error = { token: BINDING_TOKEN },
  ) => {
    const actions = executor();
    return createPipelineIntegrationsLoader({
      repository: {
        forProject: async () => {
          throw new Error('the minting integration is not read through a project');
        },
        forIntegration: async () => account,
      },
      secrets: secretsOf(secrets),
      registry: createPipelineProviderRegistry({
        executor: actions,
        clock: { now: () => '2026-06-01T09:00:00.000Z' as IsoDateTime },
        timer: { now: () => 0, sleep: async () => {} },
      }),
      executor: actions,
      gitProjectPath: async () => {
        throw new Error('a revocation needs no repository path');
      },
    });
  };
  const gitlabAccount = {
    integrationId: GIT_INTEGRATION,
    type: 'git' as const,
    provider: 'gitlab',
    name: 'acme gitlab',
    config: { base_url: 'https://git.example.test' },
    secretIds: ['00000000-0000-4000-8000-00000000e001' as Id],
    // Nobody binds it any more — the case decision 10 is about.
    bindings: [],
  };

  it('builds an unbound account’s adapter, with its own id and a redactor over its credential', async () => {
    const minting = await accountLoader(gitlabAccount).forMintingIntegration(
      GIT_INTEGRATION,
      outsideARun,
    );

    expect(minting?.ref).toMatchObject({ integrationId: GIT_INTEGRATION, provider: 'gitlab' });
    expect(minting?.redactor.redactText(`quoted ${BINDING_TOKEN}`).value).not.toContain(
      BINDING_TOKEN,
    );
  });

  /**
   * WP-107 (PROGRESS backlog 278): the account is not a binding, so its load failure does not call it
   * one, and carries the integration's id where a binding's would be — never an integration id in
   * the binding field.
   */
  it('says integration, not binding, when the account cannot be built, and carries its id', async () => {
    const error = await accountLoader(
      gitlabAccount,
      new SecretResolutionError('secret … is sealed under key "v1:old"', []),
    )
      .forMintingIntegration(GIT_INTEGRATION, outsideARun)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BindingLoadError);
    expect((error as Error).message).toBe(
      'integration "acme gitlab" (gitlab) has credentials that cannot be read: secret … is sealed under key "v1:old"',
    );
    expect(error).toMatchObject({
      projectId: null,
      bindingId: null,
      integrationId: GIT_INTEGRATION,
    });

    const schema = await accountLoader({ ...gitlabAccount, config: { base_url: 'not a url' } })
      .forMintingIntegration(GIT_INTEGRATION, outsideARun)
      .catch((caught: unknown) => caught);
    expect((schema as Error).message).toMatch(
      /^integration "acme gitlab" \(gitlab\) has configuration that fails its schema at: base_url/,
    );
  });

  it('still says binding for a project’s binding that cannot be built, with both ids', async () => {
    const error = await loaderFor({
      secrets: new SecretResolutionError('secret … is sealed under key "v1:old"', []),
    })
      .forProject(PROJECT, outsideARun)
      .catch((caught: unknown) => caught);
    expect((error as Error).message).toMatch(/^binding "acme gitlab" \(gitlab\) has credentials/);
    expect(error).toMatchObject({
      projectId: PROJECT,
      bindingId: GIT_BINDING,
      integrationId: GIT_INTEGRATION,
    });
  });

  it('answers null for an integration that no longer exists', async () => {
    expect(
      await accountLoader(null).forMintingIntegration(GIT_INTEGRATION, outsideARun),
    ).toBeNull();
  });

  it('refuses an integration of another type rather than building nothing', async () => {
    await expect(
      accountLoader({
        ...gitlabAccount,
        type: 'task_management',
        provider: 'jira-cloud',
      }).forMintingIntegration(GIT_INTEGRATION, outsideARun),
    ).rejects.toBeInstanceOf(BindingLoadError);
  });
});

/**
 * WP-89 (PROGRESS backlog 143): the bug pre-fetch's bindings, built through the **shipped**
 * registry — which is the assertion that Sentry and Loki are registered where a consumer constructs
 * them — one type at a time, with the loader's refusals unchanged.
 */
describe('an observability binding (WP-89)', () => {
  const SENTRY_TOKEN = 'sntrys_FAKE-not-a-real-sentry-token-0003';
  const LOKI_TOKEN = 'FAKE-not-a-real-loki-bearer-token-0004';
  const sentryBinding = (overrides: Partial<ProjectBinding> = {}): ProjectBinding => ({
    bindingId: '00000000-0000-4000-8000-00000000d0e1' as Id,
    integrationId: '00000000-0000-4000-8000-00000000a0e1' as Id,
    type: 'errors',
    provider: 'sentry',
    name: 'acme sentry',
    config: { base_url: 'https://sentry.example.test', organization: 'acme' },
    secretIds: ['00000000-0000-4000-8000-00000000e0e1' as Id],
    retired: false,
    ...overrides,
  });
  const lokiBinding = (config: Record<string, string> = {}): ProjectBinding => ({
    bindingId: '00000000-0000-4000-8000-00000000d0f1' as Id,
    integrationId: '00000000-0000-4000-8000-00000000a0f1' as Id,
    type: 'logs',
    provider: 'loki',
    name: 'acme loki',
    config: { base_url: 'https://loki.example.test', ...config },
    secretIds: ['00000000-0000-4000-8000-00000000e0f1' as Id],
    retired: false,
  });

  it('answers null for a project with none, and never touches the git binding', async () => {
    const loader = loaderFor({ bindings: [gitBinding()] });
    expect(await loader.forObservability(PROJECT, 'errors', outsideARun)).toBeNull();
    expect(await loader.forObservability(PROJECT, 'logs', outsideARun)).toBeNull();
  });

  it('builds the Sentry adapter, with its host on the ref and a redactor over its credential', async () => {
    const errors = await loaderFor({
      bindings: [sentryBinding()],
      secrets: { auth_token: SENTRY_TOKEN },
    }).forObservability(PROJECT, 'errors', outsideARun);

    expect(errors?.ref).toEqual({
      integrationId: '00000000-0000-4000-8000-00000000a0e1',
      provider: 'sentry',
      type: 'errors',
      host: 'sentry.example.test',
    });
    expect(
      errors?.port.linkedIssues('https://sentry.example.test/organizations/acme/issues/42/'),
    ).toEqual([{ id: '42' }]);
    expect(errors?.redactor.redactText(`leaked ${SENTRY_TOKEN}`).value).not.toContain(SENTRY_TOKEN);
  });

  it('builds the Loki adapter and publishes the binding’s excerpt selector, or null', async () => {
    const secrets = { bearer_token: LOKI_TOKEN };
    const configured = await loaderFor({
      bindings: [lokiBinding({ excerpt_selector: '{app="api"}' })],
      secrets,
    }).forObservability(PROJECT, 'logs', outsideARun);
    expect(configured?.ref).toMatchObject({ provider: 'loki', host: 'loki.example.test' });
    expect(configured?.port.excerptSelector()).toBe('{app="api"}');

    const unconfigured = await loaderFor({ bindings: [lokiBinding()], secrets }).forObservability(
      PROJECT,
      'logs',
      outsideARun,
    );
    expect(unconfigured?.port.excerptSelector()).toBeNull();
  });

  it('refuses a selector the adapter could not query, at the load rather than at every bug task', async () => {
    await expect(
      loaderFor({
        bindings: [lokiBinding({ excerpt_selector: 'app = api' })],
        secrets: { bearer_token: LOKI_TOKEN },
      }).forObservability(PROJECT, 'logs', outsideARun),
    ).rejects.toThrow(/fails its schema at: excerpt_selector/);
  });

  it('refuses a broken binding and two of one type — and forProject does not see either', async () => {
    const broken = loaderFor({
      bindings: [
        gitBinding(),
        sentryBinding({ config: { base_url: 'https://sentry.example.test' } }),
      ],
      secrets: { token: BINDING_TOKEN },
    });
    await expect(broken.forObservability(PROJECT, 'errors', outsideARun)).rejects.toBeInstanceOf(
      BindingLoadError,
    );
    // The separation the member exists for: the pipeline's own answer still loads.
    expect((await broken.forProject(PROJECT, outsideARun)).git).not.toBeNull();

    const two = loaderFor({
      bindings: [
        sentryBinding(),
        sentryBinding({
          bindingId: '00000000-0000-4000-8000-00000000d0e2' as Id,
          integrationId: '00000000-0000-4000-8000-00000000a0e2' as Id,
          name: 'second sentry',
        }),
      ],
      secrets: { auth_token: SENTRY_TOKEN },
    });
    await expect(two.forObservability(PROJECT, 'errors', outsideARun)).rejects.toThrow(
      /has 2 "errors" bindings/,
    );
  });
});

/**
 * WP-107 (TD-012's M6 amendment (2), PROGRESS backlog 316): the credentials a repository reading is
 * redacted against — every binding of the project, decrypted, named as the loader names them.
 */
/**
 * The repository a reading asks: a project's bindings, and each account's own configuration
 * (`forIntegration`, WP-121 review round 1) — `{}` unless a case states one.
 */
const readingRepositoryOf = (
  bindings: readonly ProjectBinding[],
  accountConfigs: Readonly<Record<string, JsonObject>> = {},
): BindingRepository => ({
  forProject: async () => bindings,
  forIntegration: async (integrationId) => {
    const binding = bindings.find((entry) => entry.integrationId === integrationId);
    return binding === undefined
      ? null
      : {
          integrationId,
          type: binding.type,
          provider: binding.provider,
          name: binding.name,
          config: accountConfigs[integrationId] ?? {},
          secretIds: binding.secretIds,
          bindings: [],
        };
  },
});

describe('a project’s binding credentials, for a reading (WP-107)', () => {
  const JIRA_TOKEN = 'FAKE-wp107-not-a-real-jira-token-0003';
  const jiraBinding: ProjectBinding = {
    bindingId: '00000000-0000-4000-8000-00000000d107' as Id,
    integrationId: '00000000-0000-4000-8000-00000000a107' as Id,
    type: 'task_management',
    provider: 'jira-cloud',
    name: 'acme jira',
    config: {},
    secretIds: ['00000000-0000-4000-8000-00000000e107' as Id],
    retired: false,
  };
  const resolving: SecretStore = {
    resolve: async (ids): Promise<Readonly<Record<string, string>>> =>
      ids[0] === jiraBinding.secretIds[0] ? { api_token: JIRA_TOKEN } : { token: BINDING_TOKEN },
  };

  it('names every binding’s every credential <provider>:<integration>:<field>, each account once', async () => {
    const secrets = await createProjectBindingSecrets({
      // The git binding twice — two bindings of one account resolve to the same names.
      repository: readingRepositoryOf([gitBinding(), jiraBinding, gitBinding()]),
      secrets: resolving,
      secretFieldsOf,
      organisationAccounts: async () => [],
    })(PROJECT);
    expect(secrets).toEqual({
      secrets: [
        { name: `gitlab:${GIT_INTEGRATION}:token`, value: BINDING_TOKEN },
        { name: `jira-cloud:${jiraBinding.integrationId}:api_token`, value: JIRA_TOKEN },
      ],
      unreadable: [],
    });
  });

  /**
   * PROGRESS backlog 358: one integration that will not decrypt is **named**, and every other
   * binding's credentials are still answered — a throw here froze the whole reading.
   */
  it('names an integration whose credential will not decrypt, and still answers the others', async () => {
    const answer = await createProjectBindingSecrets({
      repository: readingRepositoryOf([gitBinding(), jiraBinding]),
      secrets: {
        resolve: async (ids): Promise<Readonly<Record<string, string>>> => {
          if (ids[0] === jiraBinding.secretIds[0]) {
            throw new SecretResolutionError('secret … is sealed under key "v1:old"', []);
          }
          return { token: BINDING_TOKEN };
        },
      },
      secretFieldsOf,
      organisationAccounts: async () => [],
    })(PROJECT);
    expect(answer).toEqual({
      secrets: [{ name: `gitlab:${GIT_INTEGRATION}:token`, value: BINDING_TOKEN }],
      unreadable: [
        {
          integration: `integration "acme jira" (jira-cloud, ${jiraBinding.integrationId})`,
          reason: 'secret … is sealed under key "v1:old"',
        },
      ],
    });
  });

  /**
   * WP-121 (TD-012's M7 amendment (2), PROGRESS backlog 362): a provider's declared credential
   * field left in `integrations.config` — which only a row written before WP-100 can carry — is a
   * credential the platform holds, and the loader would build the adapter with it.
   */
  it('adds a declared credential field the configuration still carries, and nothing else of it (WP-121)', async () => {
    const CONFIG_TOKEN = 'FAKE-wp121-jira-token-left-in-config-0004';
    const answer = await createProjectBindingSecrets({
      repository: readingRepositoryOf([
        gitBinding({ config: { ...gitBinding().config, token: BINDING_TOKEN } }),
        {
          ...jiraBinding,
          config: { site: 'https://acme.example.test', api_token: CONFIG_TOKEN, webhook_secret: 7 },
        },
      ]),
      secrets: resolving,
      secretFieldsOf,
      organisationAccounts: async () => [],
    })(PROJECT);
    expect(answer.secrets).toEqual([
      // The same value sealed and in config is kept once.
      { name: `gitlab:${GIT_INTEGRATION}:token`, value: BINDING_TOKEN },
      { name: `jira-cloud:${jiraBinding.integrationId}:api_token`, value: JIRA_TOKEN },
      // A different value under a sealed field's name keeps its own placeholder name.
      { name: `jira-cloud:${jiraBinding.integrationId}:api_token.config`, value: CONFIG_TOKEN },
    ]);
    // `site` is configuration, and a non-string `webhook_secret` is no credential value.
    expect(JSON.stringify(answer)).not.toContain('acme.example.test');
  });

  /**
   * WP-121 review round 1: the binding's config is merged over the account's, so a binding that
   * sets a credential field hides the account's value of it — both are read.
   */
  it('reads the account’s own configuration too, where the binding’s value hides it (WP-121)', async () => {
    const ACCOUNT_HELD = 'FAKE-wp121-round1-account-held-secret-0006';
    const BINDING_HELD = 'FAKE-wp121-round1-binding-held-secret-0007';
    const answer = await createProjectBindingSecrets({
      repository: readingRepositoryOf(
        [{ ...jiraBinding, config: { webhook_secret: BINDING_HELD } }],
        { [jiraBinding.integrationId]: { webhook_secret: ACCOUNT_HELD } },
      ),
      secrets: resolving,
      secretFieldsOf,
      organisationAccounts: async () => [],
    })(PROJECT);
    expect(answer.secrets).toEqual([
      { name: `jira-cloud:${jiraBinding.integrationId}:api_token`, value: JIRA_TOKEN },
      { name: `jira-cloud:${jiraBinding.integrationId}:webhook_secret`, value: BINDING_HELD },
      {
        name: `jira-cloud:${jiraBinding.integrationId}:webhook_secret.config`,
        value: ACCOUNT_HELD,
      },
    ]);
  });

  /**
   * WP-121 (TD-012's M7 amendment (2), PROGRESS backlog 364): the organisation's chat accounts have
   * no binding but their credentials are in the same `secrets` table.
   */
  it('adds the organisation’s communication accounts, and names one that will not decrypt (WP-121)', async () => {
    const SLACK_TOKEN = 'xoxb-FAKE-wp121-organisation-bot-token-0005';
    const SIGNING_IN_CONFIG = 'FAKE-wp121-signing-secret-left-in-config';
    const account = (id: string, secretId: string, name: string): IntegrationAccount => ({
      integrationId: id as Id,
      type: 'communication',
      provider: 'slack',
      name,
      config: { default_channel: 'C0FAKE', signing_secret: SIGNING_IN_CONFIG },
      secretIds: [secretId as Id],
      bindings: [],
    });
    const readable = account(
      '00000000-0000-4000-8000-00000000a121',
      '00000000-0000-4000-8000-00000000e121',
      'acme slack',
    );
    const broken = account(
      '00000000-0000-4000-8000-00000000a122',
      '00000000-0000-4000-8000-00000000e122',
      'old slack',
    );
    const answer = await createProjectBindingSecrets({
      repository: readingRepositoryOf([]),
      secrets: {
        resolve: async (ids): Promise<Readonly<Record<string, string>>> => {
          if (ids[0] === broken.secretIds[0]) {
            throw new SecretResolutionError('secret … is sealed under key "v1:old"', []);
          }
          return { bot_token: SLACK_TOKEN };
        },
      },
      secretFieldsOf,
      organisationAccounts: async () => [readable, broken],
    })(PROJECT);
    expect(answer.secrets).toEqual([
      { name: `slack:${readable.integrationId}:bot_token`, value: SLACK_TOKEN },
      { name: `slack:${readable.integrationId}:signing_secret`, value: SIGNING_IN_CONFIG },
      { name: `slack:${broken.integrationId}:signing_secret`, value: SIGNING_IN_CONFIG },
    ]);
    expect(answer.unreadable).toEqual([
      {
        integration: `integration "old slack" (slack, ${broken.integrationId})`,
        reason: 'secret … is sealed under key "v1:old"',
      },
    ]);
  });

  /**
   * WP-157 (a), PROGRESS backlog 413: the organisation-scoped question, asked through the same
   * resolution the project reading uses, answers whether and never what.
   */
  it('answers once per organisation account whether it decrypts, and carries no value or reason (WP-157)', async () => {
    const SLACK_TOKEN = 'xoxb-FAKE-wp157-organisation-bot-token-0001';
    const account = (id: string, secretId: string): IntegrationAccount => ({
      integrationId: id as Id,
      type: 'communication',
      provider: 'slack',
      name: 'slack',
      config: {},
      secretIds: [secretId as Id],
      bindings: [],
    });
    const readable = account(
      '00000000-0000-4000-8000-00000000a157',
      '00000000-0000-4000-8000-00000000e157',
    );
    const broken = account(
      '00000000-0000-4000-8000-00000000a158',
      '00000000-0000-4000-8000-00000000e158',
    );
    const states = await createOrganisationAccountCredentialCheck({
      secrets: {
        resolve: async (ids): Promise<Readonly<Record<string, string>>> => {
          if (ids[0] === broken.secretIds[0]) {
            throw new SecretResolutionError('secret … is sealed under key "v1:old"', []);
          }
          return { bot_token: SLACK_TOKEN };
        },
      },
      organisationAccounts: async () => [readable, broken],
    })();
    expect(states).toEqual([
      { integrationId: readable.integrationId, readable: true },
      { integrationId: broken.integrationId, readable: false },
    ]);
    expect(JSON.stringify(states)).not.toContain(SLACK_TOKEN);
    expect(JSON.stringify(states)).not.toContain('v1:old');
  });
});
