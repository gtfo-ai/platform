/**
 * A remote run's package (WP-281, TD-031 decision 4): built from the provisioner's own mapping, with
 * a credential minted for exactly the spec's scope, and refused — never cut — where it may not travel.
 * The success path through the routes is `test/contract/worker/protocol.contract.test.ts`; these are
 * the branches: what is answered `credential_unavailable` (the claim is released), what is a terminal
 * `invalid_spec` (the run settles `not_started`), and that every refusal revokes what it minted.
 */
import { WorkspaceError } from '@platform/application';
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

const packager = (mint: () => Promise<RunGitCredentialAnswer>) =>
  createRemoteRunPackager({
    projects: {
      forRun: async () => ({
        repoUrl: 'https://git.example.test/acme/api.git',
        defaultBranch: 'main',
        projectPath: 'acme/api',
        gitHost: 'git.example.test',
        branchPatterns: ['agentic/*'],
        containerEnv: {},
      }),
    },
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

  it('answers credential_unavailable for a provider error while minting — the caller releases', async () => {
    const answer = await build(
      packager(async () => {
        throw new Error('the provider answered 502');
      }),
    );
    expect(answer).toEqual({ kind: 'credential_unavailable', detail: 'the provider answered 502' });
  });

  it('answers credential_unavailable for a static or deploy-key credential, revoking what was handed', async () => {
    for (const source of ['static', 'deploy_key'] as const) {
      const minted = credential({ source });
      const answer = await build(packager(async () => ({ kind: 'minted', credential: minted })));
      expect(answer.kind).toBe('credential_unavailable');
      expect(JSON.stringify(answer)).not.toContain(PASSWORD);
      expect(minted.revoked()).toBe(1);
    }
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
