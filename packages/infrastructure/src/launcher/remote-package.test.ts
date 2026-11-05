/**
 * A remote run's package (WP-281, TD-031 decision 4): built from the provisioner's own mapping, with
 * a credential minted for exactly the spec's scope, and refused — never cut — where it may not travel.
 * The success path through the routes is `test/contract/worker/protocol.contract.test.ts`; these are
 * the branches — every one a start failure the caller settles `not_started`, never a release (TD-031's
 * 2026-11-05 amendment): a mint failure is retryable exactly when the mint error says so, the
 * binding-changed race is retryable, a refusal is a terminal `invalid_spec` — and that every refusal
 * revokes what it minted.
 */
import {
  FAKE_DEPLOY_KEY,
  IntegrationError,
  RunStartError,
  WorkspaceError,
} from '@platform/application';
import { type RunSpec, runPackageSchema, storedRunSpecOf } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { manualClock } from '../runner/clock.js';
import { runSpecFixture } from '../runner/fixtures.js';
import { SKILL_CATALOGUE_FIXTURE } from '../workspace/fixtures.js';
import type { MintedRunGitCredential, RunGitCredentialAnswer } from './provisioner.js';
import { createRemoteRunPackager } from './remote-package.js';

const IMAGES = { run: `sha256:${'1'.repeat(64)}`, egress: `sha256:${'2'.repeat(64)}` };
const TOKEN = 'r'.repeat(43);
/** Shaped past a provider's real token pattern (rule 93): a hyphen after FAKE. */
const PASSWORD = 'FAKE-remote-run-credential-0281';

/** The plan as stored: no secret value in its environment (`storedRunSpecSchema`). */
const stored = (overrides: Partial<RunSpec> = {}): RunSpec =>
  storedRunSpecOf(runSpecFixture(overrides)) as RunSpec;

const credential = (
  overrides: Partial<MintedRunGitCredential> = {},
): MintedRunGitCredential & { readonly revoked: () => number } => {
  let revoked = 0;
  return {
    username: 'oauth2',
    password: PASSWORD,
    scope: 'push',
    expiresAt: '2026-11-05T09:00:00.000Z',
    source: 'minted',
    revoke: async () => {
      revoked += 1;
    },
    ...overrides,
    revoked: () => revoked,
  };
};

const ROUTE = {
  httpsPrefix: 'https://gitlab.com/',
  sshPrefix: 'ssh://git@altssh.gitlab.com:443/',
  connectHost: 'altssh.gitlab.com',
  connectPort: 443,
  hostKeyAlias: 'gitlab.com',
  knownHosts: [
    'gitlab.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAfuCHKVTjquxvt6CM6tdG4SLp1Btn/nOeHHE5UOzRdf',
  ],
};

const packager = (
  mint: () => Promise<RunGitCredentialAnswer>,
  remote: { readonly optIn?: 'allow' | 'deny'; readonly host?: string } = {},
) =>
  createRemoteRunPackager({
    projects: {
      forRun: async () => ({
        repoUrl: `https://${remote.host ?? 'git.example.test'}/acme/api.git`,
        defaultBranch: 'main',
        projectPath: 'acme/api',
        gitHost: remote.host ?? 'git.example.test',
        branchPatterns: ['agentic/*'],
        containerEnv: {},
      }),
    },
    remoteRunCredential: async () => remote.optIn ?? 'deny',
    credentials: { mint },
    skills: SKILL_CATALOGUE_FIXTURE,
    modelEgressHosts: ['api.anthropic.com'],
    runRegistryHosts: [],
    credentialTtlSeconds: 86_400,
    clock: manualClock(Date.parse('2026-11-04T09:00:00.000Z')),
  });

const build = (built: ReturnType<typeof packager>, spec: RunSpec = stored()) =>
  built.build({ spec, epoch: 3, runToken: TOKEN, images: IMAGES, leaseTtlMs: 600_000 });

describe('the remote run package (WP-281)', () => {
  it('carries the stored spec with no secret named, the minted push credential, the images and the fence', async () => {
    const minted = credential();
    const answer = await build(packager(async () => ({ kind: 'minted', credential: minted })));
    expect(answer.kind).toBe('package');
    const pkg = runPackageSchema.parse(answer.kind === 'package' ? answer.package : null);
    expect(pkg).toMatchObject({
      epoch: 3,
      runToken: TOKEN,
      images: IMAGES,
      credential: { password: PASSWORD, scope: 'push', source: 'minted', host: 'git.example.test' },
      limits: { leaseTtlMs: 600_000 },
    });
    // The fixture's injected secret is neither named nor carried.
    expect(pkg.run.secretEnvNames).toEqual([]);
    expect(Object.keys(pkg.run.env)).not.toContain('GITLAB_TOKEN');
    expect(minted.revoked()).toBe(0);
  });

  it.each([
    ['a provider 503 (unavailable)', new IntegrationError('unavailable', 'fake-git', '503'), true],
    ['a rate limit', new IntegrationError('rate_limited', 'fake-git', '429'), true],
    ['a refusal (forbidden)', new IntegrationError('forbidden', 'fake-git', '403'), false],
    ['an error of no known shape', new Error('socket hang up'), false],
  ] as const)(
    'throws a start failure for %s while minting, retryable as the error says',
    async (_name, error, retryable) => {
      const refused = build(
        packager(async () => {
          throw error;
        }),
      );
      await expect(refused).rejects.toBeInstanceOf(RunStartError);
      await expect(refused).rejects.toMatchObject({
        retryable,
        diagnosis: { reason: 'run_credential_unavailable' },
      });
    },
  );

  it('throws a retryable start failure for a static or deploy-key credential behind remote_run_credential: deny (the binding changed), revoking it', async () => {
    for (const source of ['static', 'deploy_key'] as const) {
      const minted = credential({ source });
      const refused = build(packager(async () => ({ kind: 'minted', credential: minted })));
      await expect(refused).rejects.toMatchObject({
        retryable: true,
        diagnosis: { reason: 'run_credential_unavailable' },
      });
      await refused.catch((error: unknown) => {
        expect((error as Error).message).not.toContain(PASSWORD);
      });
      expect(minted.revoked()).toBe(1);
    }
  });

  it('carries a static run token to a worker behind remote_run_credential: allow — to a read-only run too (WP-282)', async () => {
    for (const spec of [stored(), stored({ tools: ['Read', 'Grep', 'Glob'], role: 'reviewer' })]) {
      const minted = credential({ source: 'static', scope: 'push' });
      const answer = await build(
        packager(async () => ({ kind: 'minted', credential: minted }), { optIn: 'allow' }),
        spec,
      );
      expect(answer.kind).toBe('package');
      const pkg = runPackageSchema.parse(answer.kind === 'package' ? answer.package : null);
      expect(pkg.credential).toMatchObject({ source: 'static', password: PASSWORD, scope: 'push' });
      expect(minted.revoked()).toBe(0);
    }
  });

  it('never carries a deploy key: behind allow the package holds the route and the public key, and no credential (WP-282)', async () => {
    const minted = credential({
      source: 'deploy_key',
      username: 'git',
      password: FAKE_DEPLOY_KEY.privateKey,
      ssh: { publicKey: FAKE_DEPLOY_KEY.publicKey, route: ROUTE },
    });
    const answer = await build(
      packager(async () => ({ kind: 'minted', credential: minted }), {
        optIn: 'allow',
        host: 'gitlab.com',
      }),
    );
    expect(answer.kind).toBe('package');
    const pkg = runPackageSchema.parse(answer.kind === 'package' ? answer.package : null);
    expect(pkg.credential).toBeNull();
    expect(pkg.workspace.repo?.ssh).toMatchObject({
      publicKey: FAKE_DEPLOY_KEY.publicKey.split(' ').slice(0, 2).join(' '),
      connectHost: 'altssh.gitlab.com',
      connectPort: 443,
    });
    expect(pkg.workspace.egress.hosts).toContain('altssh.gitlab.com');
    // The private key is nowhere in what travels — not one line of its body.
    const body = FAKE_DEPLOY_KEY.privateKey.split('\n')[1] ?? '';
    expect(body.length).toBeGreaterThan(20);
    expect(JSON.stringify(pkg)).not.toContain(body);
    expect(minted.revoked()).toBe(0);
  });

  it('refuses a writing run whose binding can mint nothing, terminal and by name', async () => {
    const refused = build(
      packager(async () => ({
        kind: 'unavailable',
        reason: 'the binding declares no run credential',
      })),
    );
    await expect(refused).rejects.toBeInstanceOf(WorkspaceError);
    await expect(refused).rejects.toMatchObject({
      code: 'invalid_spec',
      reason: 'run_credential_unavailable',
    });
  });

  it('refuses a read-only run minted a push credential, and revokes it', async () => {
    const minted = credential({ scope: 'push' });
    const readOnly = stored({ tools: ['Read', 'Grep', 'Glob'], role: 'reviewer' });
    const built = packager(async () => ({ kind: 'minted', credential: minted }));
    const refused = build(built, readOnly);
    await expect(refused).rejects.toMatchObject({
      code: 'invalid_spec',
      reason: 'run_credential_scope_mismatch',
    });
    expect(minted.revoked()).toBe(1);
  });

  it('refuses a package the schema refuses — a credential in the environment — and revokes what it minted', async () => {
    const minted = credential();
    const leaky = stored({ env: { PATH: '/usr/bin', LEAK: PASSWORD } });
    const refused = build(
      packager(async () => ({ kind: 'minted', credential: minted })),
      leaky,
    );
    await expect(refused).rejects.toMatchObject({
      code: 'invalid_spec',
      reason: 'run_package_refused',
    });
    await refused.catch((error: unknown) => {
      // The refusal names the path and the rule, never the value.
      expect((error as Error).message).not.toContain(PASSWORD);
    });
    expect(minted.revoked()).toBe(1);
  });
});
