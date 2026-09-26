/**
 * The one setting that decides whether a process runs agents — WP-53, TD-028 decision 5.
 *
 * Three states, and the middle one is the reason this file exists: **both** variables composes a
 * provisioner, **neither** composes none, and **one** is a configuration mistake that must not be
 * spelled the same way as "no launcher" (standing rule 18). An operator who set `APP_LAUNCHER_URL`
 * and forgot the token would otherwise get a silent instance that queues every agent stage and
 * reports nothing about why.
 */
import {
  allowAnyIntegrationHost,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createRunScopedSecrets,
  createVirtualTimer,
  noSecretsRedactor,
  type PipelineIntegrations,
  type RunSpec,
  runGitCredentialSecretName,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { createFakeGitProvider } from '@platform/integrations';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import {
  composeRunWorkspaces,
  createRunGitCredentialMinter,
  createRunWorkspaceProjectSource,
} from './workspaces.js';

const TOKEN = 'FAKE-launcher-token-0000000000000000';

const poolWith = (rows: Record<string, unknown>[]): pg.Pool =>
  ({ query: async () => ({ rows }) }) as unknown as pg.Pool;

const compose = (launcherUrl: string | null, launcherToken: string | null) =>
  composeRunWorkspaces({
    pool: poolWith([]),
    launcherUrl,
    launcherToken,
    controlRoot: '/run/agentic/ctl',
    modelEgressHosts: ['api.anthropic.com'],
    stack: {
      executor: {} as never,
      registry: {} as never,
      auditLog: {} as never,
      runSecrets: createRunScopedSecrets({ now: () => 0 }),
      platformRedactor: noSecretsRedactor(),
    },
    secretKey: 'FAKE-app-secret-key-not-a-real-secret-0000',
    logger: silentLogger,
  });

describe('composing the run workspaces', () => {
  it('composes a provisioner when the launcher is configured', () => {
    expect(compose('http://launcher:7780', TOKEN)).toBeDefined();
  });

  it('composes none when no launcher is configured, which is the `app` service’s state', () => {
    // Not an error: TD-028 decision 5 ships a topology where the API container deliberately has no
    // launcher. What it must *also* do is not subscribe `stage.execute`, which `pipeline.ts` reads
    // off the same condition.
    expect(compose(null, null)).toBeUndefined();
  });

  it.each([
    ['a URL with no token', 'http://launcher:7780', null],
    ['a token with no URL', null, TOKEN],
  ])('refuses %s, naming the missing half', (_label, url, token) => {
    expect(() => compose(url, token)).toThrow(/APP_LAUNCHER_(URL|TOKEN)/);
  });

  it('refuses a launcher URL that is not an http address', () => {
    // The client's own check, reached at composition rather than at the first run: TD-028 decision
    // 7's "says so by name at composition".
    expect(() => compose('file:///etc/passwd', TOKEN)).toThrow();
  });
});

describe('what the platform tells the launcher about a project', () => {
  it('derives the project path and the git host from `projects.repo_url`', async () => {
    const source = createRunWorkspaceProjectSource(
      poolWith([
        { repo_url: 'https://git.example.com:8443/acme/api.git', default_branch: 'trunk' },
      ]),
    );
    const project = await source.forRun({
      projectId: '33333333-3333-4333-8333-333333333333',
      runId: '11111111-1111-4111-8111-111111111111',
    } as never);
    expect(project).toEqual({
      repoUrl: 'https://git.example.com:8443/acme/api.git',
      defaultBranch: 'trunk',
      projectPath: 'acme/api',
      // Lowercased, port removed — the same derivation the egress allow-list uses, so the host the
      // credential is scoped to and the host the container may reach cannot disagree.
      gitHost: 'git.example.com',
      branchPatterns: ['agentic/*'],
      containerEnv: {},
    });
  });

  it('refuses a run whose project has no row rather than cloning nothing', async () => {
    const source = createRunWorkspaceProjectSource(poolWith([]));
    await expect(
      source.forRun({
        projectId: '33333333-3333-4333-8333-333333333333',
        runId: '11111111-1111-4111-8111-111111111111',
      } as never),
    ).rejects.toThrow(/has no row/);
  });
});

/**
 * The run's git credential, minted through the executor against the project's git binding
 * (TD-028's WP-76 amendment) — criterion (2) and (3), counted on the audit log the real executor
 * wrote and on the revocations the fake provider recorded.
 */
describe('minting the run credential (WP-76)', () => {
  const RUN = '11111111-1111-4111-8111-111111111111' as Id;
  const TASK = '22222222-2222-4222-8222-222222222222' as Id;
  const PROJECT = '33333333-3333-4333-8333-333333333333' as Id;
  const GIT_INTEGRATION = '44444444-4444-4444-8444-444444444444' as Id;

  const harness = (
    mode: 'normal' | 'shadow',
    options: { minting?: boolean; widen?: boolean } = {},
  ) => {
    const fake = createFakeGitProvider({
      integrationId: GIT_INTEGRATION,
      projects: [{ path: 'acme/api' }],
      capabilities: { credentialMinting: options.minting ?? true },
    });
    // `widen`: a provider that answers a `read` request with a `push` token — the defect the
    // application layer refuses after the token already exists.
    const git: typeof fake = options.widen
      ? Object.assign(Object.create(fake) as typeof fake, {
          mintCredential: async (request: Parameters<typeof fake.mintCredential>[0]) =>
            fake.mintCredential({ ...request, scope: 'push', branchPatterns: ['agentic/*'] }),
        })
      : fake;
    const auditLog = createMemoryAuditLog();
    const integrations: PipelineIntegrations = {
      executor: createIntegrationActionExecutor({
        egress: allowAnyIntegrationHost(),
        auditLog,
        redactor: noSecretsRedactor(),
        timer: createVirtualTimer({ autoAdvance: true }),
        clock: fixedClock('2026-01-01T00:00:00.000Z', 1000),
      }),
      git: { port: git, ref: fake.ref, project: 'acme/api', redactor: noSecretsRedactor() },
      taskManagement: null,
      communication: null,
    };
    const runSecrets = createRunScopedSecrets({ now: () => Date.parse('2026-01-01T00:00:00Z') });
    const minter = createRunGitCredentialMinter({
      pool: poolWith([{ mode }]),
      integrations: staticPipelineIntegrations(integrations),
      runSecrets,
    });
    const spec = { runId: RUN, taskId: TASK, projectId: PROJECT } as unknown as RunSpec;
    const project = {
      repoUrl: 'https://git.example.com/acme/api.git',
      defaultBranch: 'main',
      projectPath: 'acme/api',
      gitHost: 'git.example.com',
      branchPatterns: ['agentic/*'],
      containerEnv: {},
    };
    return { git: fake, auditLog, runSecrets, minter, spec, project };
  };

  it('mints once and revokes once through the executor, one audit row each, keyed by the binding', async () => {
    const { git, auditLog, minter, spec, project } = harness('normal');
    const answer = await minter.mint({ spec, project, scope: 'push', ttlSeconds: 86_400 });
    if (answer.kind !== 'minted') throw new Error('expected a credential');
    expect(answer.credential.scope).toBe('push');
    await answer.credential.revoke();

    expect(auditLog.entriesFor('mint_credential').map((row) => row.integrationId)).toEqual([
      GIT_INTEGRATION,
    ]);
    expect(auditLog.entriesFor('revoke_credential')).toHaveLength(1);
    expect(git.credentials).toEqual([
      expect.objectContaining({ scope: 'push', revoked: true, revocations: 1 }),
    ]);
    expect(JSON.stringify(auditLog.entries)).not.toContain(answer.credential.password);
  });

  it('registers the value with the run-scoped secrets before it is handed out', async () => {
    const { runSecrets, minter, spec, project } = harness('normal');
    const answer = await minter.mint({ spec, project, scope: 'read', ttlSeconds: 86_400 });
    if (answer.kind !== 'minted') throw new Error('expected a credential');
    expect(runSecrets.redactor.redactText(`x ${answer.credential.password} y`).value).toBe(
      `x [REDACTED:integration:${runGitCredentialSecretName(RUN)}] y`,
    );
  });

  it('mints a shadow task’s writing run a read credential, audited as performed (Q98 (a))', async () => {
    const { git, auditLog, minter, spec, project } = harness('shadow');
    const answer = await minter.mint({ spec, project, scope: 'push', ttlSeconds: 86_400 });
    if (answer.kind !== 'minted') throw new Error('expected a credential');
    expect(answer.credential.scope).toBe('read');
    expect(git.credentials.map((record) => record.scope)).toEqual(['read']);
    expect(auditLog.entriesFor('mint_credential').map((row) => row.status)).toEqual(['ok']);
    expect(auditLog.entriesFor('mint_credential')[0]?.payload).toMatchObject({
      task_mode: 'shadow',
    });
  });

  /**
   * Review round 1, the production path: the refusal of a credential the provider already created
   * revokes it exactly once, through the executor, and it never becomes a usable credential.
   */
  it('revokes, exactly once, a token the provider minted wider than asked, and refuses the run', async () => {
    const { git, auditLog, runSecrets, minter, spec, project } = harness('normal', { widen: true });
    await expect(minter.mint({ spec, project, scope: 'read', ttlSeconds: 86_400 })).rejects.toThrow(
      /asked for read, got push; it was revoked/,
    );
    expect(git.credentials).toEqual([
      expect.objectContaining({ scope: 'push', revoked: true, revocations: 1 }),
    ]);
    expect(auditLog.entriesFor('revoke_credential').map((row) => row.status)).toEqual(['ok']);
    expect(runSecrets.size).toBe(0);
  });

  it('answers unavailable for a binding that cannot mint, and never falls back to a token', async () => {
    const { git, auditLog, minter, spec, project } = harness('normal', { minting: false });
    const answer = await minter.mint({ spec, project, scope: 'push', ttlSeconds: 86_400 });
    expect(answer.kind).toBe('unavailable');
    expect(git.credentials).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });
});
