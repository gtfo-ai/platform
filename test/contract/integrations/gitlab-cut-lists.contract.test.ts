/**
 * WP-220 (backlog 610) — a GitLab list the binding's `max_pages` cut is never read as the whole
 * list by a read that answers yes or no. `project-lists-paged.json` records `acme/many-rules` with
 * two pages of protection rules (an exact `main` rule with push "No one", then a wildcard `ma*` that
 * lets Maintainers push) and two pages of deploy keys (a read-only key, then the write key).
 *
 * Both sides of the bound (rule 42): with `max_pages: 2` the second page is read and answered; with
 * `max_pages: 1` the read is refused. Before this change the cut read answered "nobody pushes" and
 * "not enabled" (the measurement is in PROGRESS under WP-220), so each refusal below is one a wrong
 * implementation does not make (rule 43). Through the real adapter, the real executor, the
 * operator-token gate and the binding probe.
 */
import {
  allowAnyIntegrationHost,
  type BindingRepository,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  FAKE_DEPLOY_KEY,
  type IntegrationAccount,
  IntegrationError,
  type MemoryIntegrationAuditLog,
  noSecretsRedactor,
  type PipelineIntegrations,
  runCredentialWrites,
  StaticRunCredentialRefusedError,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import {
  type AnyProviderRegistration,
  createGitLabProvider,
  createIntegrationProber,
  createIntegrationRegistry,
  gitlabAdapterInput,
  gitlabConfigSchema,
  gitlabProviderRegistration,
} from '@platform/integrations';
import { beforeEach, describe, expect, it } from 'vitest';
import { CLOCK_AT, GITLAB_HOST } from '../support/integrations/gitlab-fixtures.js';
import {
  FAKE_BINDING_TOKEN,
  GITLAB_FAKE_DEPLOY_KEYS,
} from '../support/integrations/gitlab-harness.js';
import {
  createGitLabReplay,
  type GitLabReplay,
  loadReplayFixture,
} from '../support/integrations/gitlab-replay.js';

const PROJECT = 'acme/many-rules';
const OPERATOR_TOKEN = 'FAKE-operator-run-token-DO-NOT-USE';
const INTEGRATION = '00000000-0000-4000-8000-0000000002a1' as Id;
const SECRET = '00000000-0000-4000-8000-0000000002a2' as Id;

let replay: GitLabReplay;
let auditLog: MemoryIntegrationAuditLog;

beforeEach(() => {
  replay = createGitLabReplay(
    ['instance', 'project-lists-paged'].flatMap((name) => loadReplayFixture(name)),
  );
  auditLog = createMemoryAuditLog();
});

const adapter = (maxPages: number) =>
  createGitLabProvider({
    integrationId: INTEGRATION,
    config: gitlabConfigSchema.parse({
      base_url: GITLAB_HOST,
      project: PROJECT,
      request_timeout_ms: 0,
      max_pages: maxPages,
    }),
    secrets: { token: FAKE_BINDING_TOKEN },
    fetchImpl: replay.fetchImpl,
    clock: fixedClock(CLOCK_AT),
    redactor: noSecretsRedactor(),
  });

const executor = () =>
  createIntegrationActionExecutor({
    egress: allowAnyIntegrationHost(),
    auditLog,
    redactor: noSecretsRedactor(),
    timer: createVirtualTimer({ autoAdvance: true }),
    clock: fixedClock(CLOCK_AT, 1000),
  });

const requested = () => replay.requests.map((request) => request.key);

const refusal = async (read: () => Promise<unknown>): Promise<IntegrationError> => {
  const caught = await read().then(
    (answer) => answer,
    (error: unknown) => error,
  );
  expect(caught, 'a cut list is not an answer').toBeInstanceOf(IntegrationError);
  return caught as IntegrationError;
};

describe('GitLab in replay: the protection rules of a project cut at max_pages (WP-220)', () => {
  it('reads the second page when max_pages reaches it, and its wildcard opens the branch', async () => {
    expect(await adapter(2).branchPushProtection(PROJECT, 'main')).toEqual({
      protected: true,
      nobodyPushes: false,
      forcePushAllowed: false,
      pushers: ['No one', 'Maintainers (rule ma*)'],
    });
    expect(requested()).toEqual([
      'GET /projects/acme%2Fmany-rules',
      'GET /projects/acme%2Fmany-rules/protected_branches?page=1&per_page=100',
      'GET /projects/acme%2Fmany-rules/protected_branches?page=2&per_page=100',
    ]);
  });

  it('refuses the rules when max_pages stops before the page that opens the branch', async () => {
    const error = await refusal(() => adapter(1).branchPushProtection(PROJECT, 'main'));
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('list_protected_branches');
    expect(error.message).toContain('max_pages (1)');
    expect(requested()).toEqual([
      'GET /projects/acme%2Fmany-rules',
      'GET /projects/acme%2Fmany-rules/protected_branches?page=1&per_page=100',
    ]);
  });
});

describe('GitLab in replay: the deploy keys of a project cut at max_pages (WP-220)', () => {
  it('finds the write key on the second page when max_pages reaches it', async () => {
    expect(await adapter(2).deployKeyAccess(PROJECT, GITLAB_FAKE_DEPLOY_KEYS.writable)).toEqual({
      enabled: true,
      canPush: true,
      keyId: '42',
    });
  });

  it('refuses the keys when max_pages stops before the page that holds the key', async () => {
    const error = await refusal(() =>
      adapter(1).deployKeyAccess(PROJECT, GITLAB_FAKE_DEPLOY_KEYS.writable),
    );
    expect(error.code).toBe('invalid_response');
    expect(error.message).toContain('list_deploy_keys');
    expect(error.message).toContain('max_pages (1)');
    expect(requested()).toEqual([
      'GET /projects/acme%2Fmany-rules',
      'GET /projects/acme%2Fmany-rules/deploy_keys?page=1&per_page=100',
    ]);
  });
});

/**
 * Criterion (2): the gate that hands a run the operator's own token (TD-028 decision 13a,
 * `operatorTokenProtectionRefusal`) reads the cut list through the executor and hands nothing.
 */
describe('the operator-token gate over a cut protection list (WP-220)', () => {
  const gate = (maxPages: number) => {
    const port = adapter(maxPages);
    const integrations: PipelineIntegrations = {
      executor: executor(),
      git: {
        port,
        ref: port.ref,
        project: PROJECT,
        redactor: noSecretsRedactor(),
        staticRunCredential: {
          owner: 'operator',
          username: 'acme-owner',
          value: OPERATOR_TOKEN,
          expiresAt: '2026-12-01T00:00:00.000Z',
          declaredExpiry: '2026-12-01',
          sameAsApiToken: false,
          refusal: null,
        },
      },
      taskManagement: null,
      communication: null,
    };
    return runCredentialWrites(integrations, {
      isRetired: async () => false,
      now: () => CLOCK_AT,
    }).mint({
      runId: '00000000-0000-4000-8000-0000000002c1' as Id,
      taskId: '00000000-0000-4000-8000-0000000002c2' as Id,
      projectId: '00000000-0000-4000-8000-0000000002c3' as Id,
      mode: 'normal',
      scope: 'push',
      branchPatterns: ['agentic/*'],
      ttlSeconds: 86_400,
      defaultBranch: 'main',
    });
  };

  it('hands no run the token when the list is cut: the read is refused and recorded as failed', async () => {
    const caught = await gate(1).then(
      (answer) => answer,
      (error: unknown) => error,
    );
    expect(caught, 'no credential is answered').toBeInstanceOf(IntegrationError);
    expect((caught as IntegrationError).code).toBe('invalid_response');
    expect(JSON.stringify(caught)).not.toContain(OPERATOR_TOKEN);
    const [row] = auditLog.entriesFor('check_default_branch_protection');
    expect(row?.status).toBe('failed');
  });

  it('refuses by name when max_pages reaches the wildcard that lets Maintainers push', async () => {
    const caught = await gate(2).then(
      (answer) => answer,
      (error: unknown) => error,
    );
    expect(caught).toBeInstanceOf(StaticRunCredentialRefusedError);
    expect((caught as Error).message).toMatch(
      /default branch main of acme\/many-rules lets No one, Maintainers \(rule ma\*\) push/,
    );
  });
});

/** GitLab's own registration, its adapter on this file's replay. */
const registration = (): AnyProviderRegistration => ({
  ...gitlabProviderRegistration,
  create: (input) => {
    const built = gitlabAdapterInput(input);
    return createGitLabProvider({
      integrationId: input.integrationId,
      config: gitlabConfigSchema.parse(built.config),
      secrets: built.secrets,
      redactor: input.redactor,
      fetchImpl: replay.fetchImpl,
      clock: fixedClock(CLOCK_AT),
    });
  },
});

const deployKeyProbe = (maxPages: number) => {
  const account: IntegrationAccount = {
    integrationId: INTEGRATION,
    type: 'git',
    provider: 'gitlab',
    name: 'acme gitlab',
    config: {
      // A deploy key's SSH route is gitlab.com's alone (TD-028 decision 13b); the replay keys on
      // the path, so the recorded corpus answers this host too.
      base_url: 'https://gitlab.com',
      project: PROJECT,
      request_timeout_ms: 0,
      max_pages: maxPages,
      run_credential: 'deploy_key',
      run_ssh_public_key: FAKE_DEPLOY_KEY.publicKey,
    },
    secretIds: [SECRET],
    bindings: [],
  };
  const repository: BindingRepository = {
    forProject: async () => [],
    forIntegration: async () => account,
  };
  return createIntegrationProber({
    repository,
    secrets: {
      resolve: async () => ({
        token: FAKE_BINDING_TOKEN,
        run_ssh_private_key: FAKE_DEPLOY_KEY.privateKey,
      }),
    },
    registry: createIntegrationRegistry([registration()]),
    executor: executor(),
    boundProjectOf: async () => ({ path: PROJECT, defaultBranch: 'main' }),
  }).test(INTEGRATION);
};

/** Criterion (3): the probe names an incomplete read, never a key that is not enabled. */
describe('the deploy-key probe over cut lists (WP-220)', () => {
  it('names the incomplete read on both checks when max_pages stops before the second page', async () => {
    const outcome = await deployKeyProbe(1);
    expect(outcome?.ok).toBe(false);
    const key = outcome?.checks.find((check) => check.name === 'run_credential');
    expect(key?.ok).toBe(false);
    expect(key?.detail).toMatch(/^Not checked: .*list_deploy_keys.*max_pages \(1\)/);
    expect(key?.detail).not.toMatch(/is not one of/);
    const rule = outcome?.checks.find((check) => check.name === 'default_branch_protection');
    expect(rule?.ok).toBe(false);
    expect(rule?.detail).toMatch(/^Not checked: .*list_protected_branches.*max_pages \(1\)/);
  });

  it('answers both checks from the second page when max_pages reaches it', async () => {
    const outcome = await deployKeyProbe(2);
    expect(outcome?.checks.find((check) => check.name === 'run_credential')).toMatchObject({
      ok: true,
      detail: expect.stringMatching(/enabled on acme\/many-rules with write access/),
    });
    expect(
      outcome?.checks.find((check) => check.name === 'default_branch_protection'),
    ).toMatchObject({ ok: false, detail: expect.stringMatching(/Maintainers \(rule ma\*\)/) });
  });
});
