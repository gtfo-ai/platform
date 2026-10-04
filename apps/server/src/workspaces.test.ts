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
  type StaticRunCredential,
  silentLogger,
  staticPipelineIntegrations,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { createFakeGitProvider } from '@platform/integrations';
import type pg from 'pg';
import { describe, expect, it } from 'vitest';
import { createMetrics } from './metrics.js';
import {
  composeOrphanWorkspaceReaper,
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
    runRegistryHosts: [],
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

describe('composing the orphaned-workspace pass (WP-103)', () => {
  const reaperWith = (launcherUrl: string | null, intervalMs: number) => {
    const lines: string[] = [];
    const reaper = composeOrphanWorkspaceReaper({
      launcherUrl,
      launcherToken: launcherUrl === null ? null : TOKEN,
      unitOfWork: { transaction: async () => Promise.reject(new Error('not reached')) },
      intervalMs,
      metrics: createMetrics({ defaultMetrics: false }),
      logger: { ...silentLogger, info: (_fields: unknown, message: string) => lines.push(message) },
    });
    return { reaper, lines };
  };

  it('composes none where no launcher is configured, because it has nobody to ask', () => {
    expect(reaperWith(null, 60_000).reaper).toBeNull();
  });

  it('arms one where the launcher is, and says so; a 0 interval arms nothing and says that', () => {
    const armed = reaperWith('http://launcher:7780', 60_000);
    expect(armed.reaper).not.toBeNull();
    armed.reaper?.stop();
    expect(armed.lines.some((line) => line.includes('pass is armed'))).toBe(true);
    const off = reaperWith('http://launcher:7780', 0);
    expect(off.reaper).toBeNull();
    expect(off.lines.some((line) => line.includes('pass is off'))).toBe(true);
  });

  it('exports no orphan series until the pass has acted, so a quiet pass is not a measured zero', async () => {
    const metrics = createMetrics({ defaultMetrics: false });
    expect(await metrics.registry.metrics()).not.toMatch(/orphan_run_workspaces_total\{/);
    metrics.orphanRunWorkspaces.inc({ outcome: 'removed_terminal' });
    expect(await metrics.registry.metrics()).toMatch(
      /orphan_run_workspaces_total\{outcome="removed_terminal"\} 1/,
    );
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
    options: {
      minting?: boolean;
      widen?: boolean;
      /** WP-137: the integration's static run credential, as the loader reads it. */
      staticRunCredential?: StaticRunCredential;
      /** WP-137: `runs.credential_source` cannot be written. */
      failRecord?: boolean;
    } = {},
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
      git: {
        port: git,
        ref: fake.ref,
        project: 'acme/api',
        redactor: noSecretsRedactor(),
        ...(options.staticRunCredential === undefined
          ? {}
          : { staticRunCredential: options.staticRunCredential }),
      },
      taskManagement: null,
      communication: null,
    };
    const runSecrets = createRunScopedSecrets({ now: () => Date.parse('2026-01-01T00:00:00Z') });
    // Every statement the minter sent, with its parameters — WP-137's `runs.credential_source`.
    const queries: { text: string; values: readonly unknown[] }[] = [];
    const pool = {
      query: async (text: string, values: readonly unknown[] = []) => {
        if (options.failRecord === true && text.includes('credential_source')) {
          throw new Error('the database is gone');
        }
        queries.push({ text, values });
        return { rows: [{ mode }] };
      },
    } as unknown as pg.Pool;
    const minter = createRunGitCredentialMinter({
      pool,
      integrations: staticPipelineIntegrations(integrations),
      runSecrets,
      now: () => '2026-01-01T00:00:00.000Z',
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
    const credentialSources = () =>
      queries
        .filter((query) => query.text.includes('credential_source'))
        .map((query) => query.values.slice(1));
    return { git: fake, auditLog, runSecrets, minter, spec, project, credentialSources };
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

  /**
   * WP-137 — TD-028 decision 13, the production minter: a static run credential is handed on the
   * minted path's own shape, joins the run's redactor (so a transcript line or an artifact that
   * echoes it is redacted), writes no `mint_credential`/`revoke_credential` row — which is what keeps
   * the orphan-revoke recovery, which starts from those rows, away from the run — and the run row
   * says `static`.
   */
  describe('a static run credential (WP-137)', () => {
    const STATIC_TOKEN = 'glpat-FAKE-static-run-token-not-real-0001';
    const STATIC: StaticRunCredential = {
      username: 'agentic-runner',
      value: STATIC_TOKEN,
      expiresAt: '2026-12-01T00:00:00.000Z',
      declaredExpiry: '2026-12-01',
      sameAsApiToken: false,
      refusal: null,
    };

    it('hands it on the minted path, redacted, with no audit row, and records the source', async () => {
      const { git, auditLog, runSecrets, minter, spec, project, credentialSources } = harness(
        'normal',
        { minting: false, staticRunCredential: STATIC },
      );
      const answer = await minter.mint({ spec, project, scope: 'read', ttlSeconds: 86_400 });
      if (answer.kind !== 'minted') throw new Error('expected a credential');
      expect(answer.credential).toMatchObject({
        username: 'agentic-runner',
        password: STATIC_TOKEN,
        scope: 'push',
        expiresAt: '2026-12-01T00:00:00.000Z',
        source: 'static',
      });
      // The canary: a transcript line and an artifact field are redacted through this registry.
      const line = `remote: https://agentic-runner:${STATIC_TOKEN}@gitlab.example.test/acme/api`;
      const artifact = JSON.stringify({ commands_run: [`git push ${STATIC_TOKEN}`] });
      expect(runSecrets.redactor.redactText(line).value).not.toContain(STATIC_TOKEN);
      expect(runSecrets.redactor.redactText(artifact).value).toBe(
        JSON.stringify({
          commands_run: [`git push [REDACTED:integration:${runGitCredentialSecretName(RUN)}]`],
        }),
      );
      await answer.credential.revoke();
      // Review round 1: the teardown drops the run's entry; no provider call was made for it.
      expect(runSecrets.size).toBe(0);
      expect(auditLog.entries).toEqual([]);
      expect(git.credentials).toEqual([]);
      expect(credentialSources()).toEqual([['static', GIT_INTEGRATION]]);
    });

    it('gives a shadow task no credential, and records none (decision 13 item 4)', async () => {
      const { runSecrets, minter, spec, project, credentialSources } = harness('shadow', {
        staticRunCredential: STATIC,
      });
      const answer = await minter.mint({ spec, project, scope: 'push', ttlSeconds: 86_400 });
      expect(answer.kind).toBe('unavailable');
      expect(JSON.stringify(answer)).not.toContain(STATIC_TOKEN);
      expect(runSecrets.size).toBe(0);
      expect(credentialSources()).toEqual([['none', null]]);
    });

    it('refuses an expired one terminally, before the create, naming the date', async () => {
      const { runSecrets, minter, spec, project, credentialSources } = harness('normal', {
        staticRunCredential: {
          ...STATIC,
          expiresAt: '2025-12-01T00:00:00.000Z',
          declaredExpiry: '2025-12-01',
        },
      });
      await expect(
        minter.mint({ spec, project, scope: 'push', ttlSeconds: 86_400 }),
      ).rejects.toMatchObject({
        code: 'invalid_spec',
        message: expect.stringMatching(/expired on 2025-12-01/),
      });
      expect(runSecrets.size).toBe(0);
      expect(credentialSources()).toEqual([['none', GIT_INTEGRATION]]);
    });
  });

  it('revokes a minted token once when its run cannot record the source, and refuses the run', async () => {
    const { git, auditLog, minter, spec, project } = harness('normal', { failRecord: true });
    await expect(minter.mint({ spec, project, scope: 'push', ttlSeconds: 86_400 })).rejects.toThrow(
      'the database is gone',
    );
    expect(git.credentials).toEqual([expect.objectContaining({ revoked: true, revocations: 1 })]);
    expect(auditLog.entriesFor('revoke_credential')).toHaveLength(1);
  });

  it('answers unavailable for a binding that cannot mint, and never falls back to a token', async () => {
    const { git, auditLog, minter, spec, project } = harness('normal', { minting: false });
    const answer = await minter.mint({ spec, project, scope: 'push', ttlSeconds: 86_400 });
    expect(answer.kind).toBe('unavailable');
    expect(git.credentials).toEqual([]);
    expect(auditLog.entries).toEqual([]);
  });
});
