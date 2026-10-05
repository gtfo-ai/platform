/**
 * The first production `RunWorkspaceProvisioner` — WP-53, and PROGRESS backlog **71**'s one
 * remaining mapping.
 *
 * Backlog 71 is filed as *"`RunSpec.checkoutRef` is filled by the planner and **reaches nothing**"*,
 * with the measurement that `checkoutBranch` appears outside the port, the spec builder and the
 * Docker provider in exactly two places, neither of them production. This file is where that stops
 * being true, so the case that matters is not "a spec was built" but **which branch** the built spec
 * names — asserted as the countable effect the row asks for.
 */
import { createPublicKey, verify } from 'node:crypto';
import { connect } from 'node:net';
import path from 'node:path';
import {
  FAKE_DEPLOY_KEY,
  RFC8032_TEST1,
  sshEd25519PublicKeyBlob,
  sshString,
  WorkspaceError,
} from '@platform/application';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunletShim } from '../runlet/shim.js';
import {
  AGENT_FAILURE,
  encodeAgentMessage,
  SSH_AGENT_SIGN_RESPONSE,
  SSH_AGENTC_SIGN_REQUEST,
} from '../runlet/ssh-agent.js';
import { connectProbe, createControlVolume, nodeScript } from '../runlet/testing.js';
import { manualClock } from '../runner/clock.js';
import { runSpecFixture } from '../runner/fixtures.js';
import type { RunWorkspaceEnding } from '../runner/workspace-runner.js';
import type { LauncherControlClient } from './client.js';
import {
  type CreateRunRequestPayload,
  createRunRequestSchema,
  type EndRunRequestPayload,
  type EndRunResponse,
} from './protocol.js';
import {
  assertControlSocketUnderRoot,
  createLauncherRunWorkspaceProvisioner,
  type RunGitCredentialAnswer,
  type RunGitCredentialMinter,
  type RunWorkspaceProject,
  runWorkspaceSpecFor,
  savedWorkOf,
} from './provisioner.js';

const CONTROL_ROOT = '/run/agentic/ctl';
/** A credential the wire schema accepts for a writing spec of {@link project}. */
const CARRIED = {
  host: 'git.example.com',
  username: 'oauth2',
  password: 'fake_run_credential_push_0001',
  scope: 'push',
  expiresAt: '2026-01-03T00:00:00.000Z',
} as const;
const RUN_ID = '11111111-1111-4111-8111-111111111111';

const project: RunWorkspaceProject = {
  repoUrl: 'https://git.example.com/acme/api.git',
  defaultBranch: 'main',
  projectPath: 'acme/api',
  gitHost: 'git.example.com',
  branchPatterns: ['agentic/*'],
  containerEnv: {},
};

const handleFor = (runId: string) => ({
  runId,
  projectId: '33333333-3333-4333-8333-333333333333',
  containerId: 'ws-container',
  sidecarContainerId: 'sidecar',
  networkId: 'net',
  volumeName: `ws-${runId}`,
  cacheKey: 'p33333333',
  controlSubPath: runId,
  keepUntil: '2026-01-04T00:00:00.000Z',
});

/** The launcher's WP-118 answer, as `DockerWorkspaceProvider` gives it for a run with a sidecar. */
const CLI_ENVIRONMENT = {
  proxy: { url: 'http://egress-sidecar:8888', noProxy: 'localhost,127.0.0.1' },
  home: '/tmp',
  claudeConfigDir: '/tmp/claude',
  path: '/usr/local/bin:/usr/bin:/bin',
  gitConfig: [
    { key: 'credential.helper', value: '!agentic-runlet credential --socket /ctl/cred.sock' },
  ],
};

interface Recorded {
  readonly creates: CreateRunRequestPayload[];
  readonly ends: { runId: string; payload: EndRunRequestPayload }[];
}

const clientWith = (
  overrides: {
    readonly socketPath?: string;
    readonly claudeCodePath?: string;
    readonly failures?: readonly string[];
  } = {},
): { client: LauncherControlClient; recorded: Recorded } => {
  const recorded: Recorded = { creates: [], ends: [] };
  return {
    recorded,
    client: {
      createRun: async (payload) => {
        recorded.creates.push(payload);
        return {
          handle: handleFor(payload.spec.runId),
          attachment: {
            socketPath: overrides.socketPath ?? `${CONTROL_ROOT}/${payload.spec.runId}/ctl.sock`,
            token: 'FAKE-run-token',
            workdir: '/work/repo',
          },
          claudeCodePath: overrides.claudeCodePath ?? '/usr/local/bin/claude',
          cliEnvironment: CLI_ENVIRONMENT,
          credentialScope: payload.credential?.scope ?? null,
          existingProtectedPaths: {
            state: 'listed',
            paths: ['src/totals.test.ts'],
            opaque: [],
          },
          replayed: false,
        };
      },
      endRun: async (runId, payload) => {
        recorded.ends.push({ runId, payload });
        return { exported: null, keepUntil: null, failures: [...(overrides.failures ?? [])] };
      },
      health: async () => ({
        status: 'ok',
        controlRoot: CONTROL_ROOT,
        runtimeImage: 'platform-runtime:dev',
        claudeCodePath: '/usr/local/bin/claude',
        runs: 0,
      }),
      // The provisioner never lists or destroys by id — that is the reaper's (WP-103) — so both
      // refuse, and a provisioner that started calling them would fail here by name.
      listRuns: async () => {
        throw new Error('the provisioner does not list runs');
      },
      destroyRun: async () => {
        throw new Error('the provisioner does not destroy by run id');
      },
    },
  };
};

/** A minter that records what it was asked and every revocation, in call order with `log`. */
const minterWith = (
  answer: (scope: 'read' | 'push') => RunGitCredentialAnswer | 'minted' = () => 'minted',
  log: string[] = [],
) => {
  const asked: ('read' | 'push')[] = [];
  let revocations = 0;
  const minter: RunGitCredentialMinter = {
    mint: async ({ scope }) => {
      asked.push(scope);
      const decided = answer(scope);
      if (decided !== 'minted') {
        return decided;
      }
      return {
        kind: 'minted',
        credential: {
          username: 'oauth2',
          password: `fake_run_credential_${scope}_0001`,
          scope,
          expiresAt: '2026-01-03T00:00:00.000Z',
          revoke: async () => {
            revocations += 1;
            log.push('revoke');
          },
        },
      };
    },
  };
  return {
    minter,
    asked,
    get revocations() {
      return revocations;
    },
  };
};

const provisionerWith = (
  client: LauncherControlClient,
  credentials: RunGitCredentialMinter = minterWith().minter,
  controlRoot: string = CONTROL_ROOT,
) =>
  createLauncherRunWorkspaceProvisioner({
    client,
    credentials,
    projects: { forRun: async () => project },
    controlRoot,
    modelEgressHosts: ['api.anthropic.com'],
    runRegistryHosts: [],
    credentialTtlSeconds: 86_400,
    clock: manualClock(Date.parse('2026-01-01T00:00:00.000Z')),
  });

describe('backlog 71 — `checkoutRef` reaches the workspace', () => {
  it('checks out the task’s own branch for a re-entry run', () => {
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture({ checkoutRef: 'agentic/task-7' }),
      project,
      modelEgressHosts: [],
      runRegistryHosts: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(spec.repo?.checkoutBranch).toBe('agentic/task-7');
  });

  it('checks out the default branch for a task’s first run, rather than failing on a branch that is not on the remote', () => {
    // The other direction (standing rule 42), and the half the row asks to be answered *in the same
    // change*: `null` is what the planner writes for a first run, and `#clone` then clones
    // `defaultBranch` and creates the task branch with `checkout -b`.
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture({ checkoutRef: null }),
      project,
      modelEgressHosts: [],
      runRegistryHosts: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(spec.repo?.checkoutBranch).toBeNull();
    expect(spec.repo?.defaultBranch).toBe('main');
  });

  it('reaches the control plane’s create request, not only the builder', async () => {
    // Standing rule 82's shape: the case above would pass with the provisioner deleted.
    const { client, recorded } = clientWith();
    await provisionerWith(client).provision(runSpecFixture({ checkoutRef: 'agentic/task-9' }));
    expect(recorded.creates[0]?.spec.repo?.checkoutBranch).toBe('agentic/task-9');
  });

  /**
   * WP-105 (WP-98's discovered work): a shadow task's base is a **commit**, and it reaches the
   * create request as one — never as a branch, which `#clone` would create when the mirror lacks it.
   */
  it('carries a shadow base as a commit to the create request, never as a branch (WP-105)', async () => {
    const base = 'a1'.repeat(20);
    const { client, recorded } = clientWith();
    await provisionerWith(client).provision(runSpecFixture({ checkoutCommit: base }));
    expect(recorded.creates[0]?.spec.repo).toMatchObject({
      checkoutCommit: base,
      checkoutBranch: null,
    });
  });
});

describe('the workspace spec a run gets', () => {
  it('carries the git host and the model host, and nothing else', () => {
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture(),
      project,
      modelEgressHosts: ['api.anthropic.com'],
      runRegistryHosts: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(spec.egress.hosts).toEqual(['api.anthropic.com', 'git.example.com']);
  });

  it('sends a declared registry host for a run that may install, and not for a read-only one (WP-82)', async () => {
    // Rule 82: asserted on the create request the launcher receives, not on the builder alone.
    const { client, recorded } = clientWith();
    const provisioner = createLauncherRunWorkspaceProvisioner({
      client,
      credentials: minterWith().minter,
      projects: { forRun: async () => project },
      controlRoot: CONTROL_ROOT,
      modelEgressHosts: ['api.anthropic.com'],
      runRegistryHosts: ['registry.npmjs.org'],
      credentialTtlSeconds: 86_400,
      clock: manualClock(Date.parse('2026-01-01T00:00:00.000Z')),
    });
    await provisioner.provision(
      runSpecFixture({
        runId: '00000000-0000-4000-8000-0000000082a1',
        role: 'developer',
        tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
        commandPolicy: { allow: ['npm ci', 'npm test'], ask: [], block: [] },
      }),
    );
    await provisioner.provision(
      runSpecFixture({
        runId: '00000000-0000-4000-8000-0000000082a2',
        role: 'architect',
        tools: ['Read', 'Grep', 'Glob', 'Bash'],
        commandPolicy: { allow: ['git log', 'ls *'], ask: [], block: [] },
      }),
    );
    expect(recorded.creates.map((create) => create.spec.egress.hosts)).toEqual([
      ['api.anthropic.com', 'git.example.com', 'registry.npmjs.org'],
      ['api.anthropic.com', 'git.example.com'],
    ]);
  });

  it('fails closed when no model host is declared', () => {
    // Stated rather than assumed: the run reaches only its git host and the CLI's first request is
    // refused by the sidecar. Visibly wrong beats silently permissive (technical/05).
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture(),
      project,
      modelEgressHosts: [],
      runRegistryHosts: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(spec.egress.hosts).toEqual(['git.example.com']);
  });

  /**
   * WP-74 criterion (5), the runner's half: a run with no file tool and no shell sends a spec with
   * no repository and **no credential request** — the launcher is never asked to mint — and the
   * request it sends is one the wire schema accepts.
   */
  it('asks for no checkout and no credential for a run that holds no file tool and no shell', async () => {
    const { client, recorded } = clientWith();
    await provisionerWith(client).provision(runSpecFixture({ role: 'ask', tools: [] }));
    const request = recorded.creates[0];
    expect(request?.spec.repo).toBeNull();
    expect(request?.credential).toBeNull();
    expect(request?.spec.egress.hosts).toEqual(['api.anthropic.com']);
    expect(createRunRequestSchema.safeParse(request).success).toBe(true);
    // A repo-less spec carrying a credential is refused at the boundary, not reconciled.
    expect(createRunRequestSchema.safeParse({ ...request, credential: CARRIED }).success).toBe(
      false,
    );
  });

  it('carries a minted push credential for a writing run, naming the git host', async () => {
    const minting = minterWith();
    const { client, recorded } = clientWith();
    await provisionerWith(client, minting.minter).provision(runSpecFixture());
    expect(minting.asked).toEqual(['push']);
    expect(recorded.creates[0]?.credential).toEqual({
      host: 'git.example.com',
      username: 'oauth2',
      password: 'fake_run_credential_push_0001',
      scope: 'push',
      expiresAt: '2026-01-03T00:00:00.000Z',
      source: 'minted',
    });
    expect(createRunRequestSchema.safeParse(recorded.creates[0]).success).toBe(true);
  });

  it('asks for read for a read-only run, and carries it (the read scope’s producer, backlog 133 (2))', async () => {
    const minting = minterWith();
    const { client, recorded } = clientWith();
    await provisionerWith(client, minting.minter).provision(
      runSpecFixture({ tools: ['Read', 'Grep', 'Bash'] }),
    );
    expect(minting.asked).toEqual(['read']);
    expect(recorded.creates[0]?.credential?.scope).toBe('read');
  });

  it('lets a read-only run fetch anonymously when the binding cannot mint', async () => {
    const minting = minterWith(() => ({ kind: 'unavailable', reason: 'mint_credentials is off' }));
    const { client, recorded } = clientWith();
    await provisionerWith(client, minting.minter).provision(
      runSpecFixture({ tools: ['Read', 'Grep'] }),
    );
    expect(recorded.creates[0]?.credential).toBeNull();
    expect(createRunRequestSchema.safeParse(recorded.creates[0]).success).toBe(true);
  });

  /** Decision 6, and its pair (rule 42): the same answer that lets a read-only run through above. */
  it('refuses a writing run the binding cannot mint for, before the launcher is asked, by name', async () => {
    const minting = minterWith(() => ({ kind: 'unavailable', reason: 'mint_credentials is off' }));
    const { client, recorded } = clientWith();
    const refused = provisionerWith(client, minting.minter).provision(runSpecFixture());
    await expect(refused).rejects.toMatchObject({
      code: 'invalid_spec',
      message:
        /writes to its checkout and no git credential can be given to it.*mint_credentials is off/,
    });
    expect(recorded.creates).toEqual([]);
  });

  /**
   * WP-137 criterion (4) — TD-028 decision 13 item 2: a static run credential travels the **same**
   * path a minted one does (the create request, the broker, `cred.get`), as `push` with the declared
   * expiry, to a writing run **and** to a read-only one — it cannot be narrowed (item 5) — and the
   * provisioner's one revoke is the credential's own no-op.
   */
  it.each([
    ['a writing run', ['Read', 'Edit', 'Bash']],
    ['a read-only run', ['Read', 'Grep']],
  ])(
    'carries a static run credential to %s as push, with the declared expiry',
    async (_case, tools) => {
      const STATIC_TOKEN = 'glpat-FAKE-static-run-token-not-real-0001';
      let revoked = 0;
      const fixed: RunGitCredentialMinter = {
        mint: async () => ({
          kind: 'minted',
          credential: {
            username: 'agentic-runner',
            password: STATIC_TOKEN,
            scope: 'push',
            expiresAt: '2026-12-01T00:00:00.000Z',
            source: 'static',
            revoke: async () => {
              revoked += 1;
            },
          },
        }),
      };
      const { client, recorded } = clientWith();
      const workspace = await provisionerWith(client, fixed).provision(runSpecFixture({ tools }));
      expect(recorded.creates[0]?.credential).toEqual({
        host: 'git.example.com',
        username: 'agentic-runner',
        password: STATIC_TOKEN,
        scope: 'push',
        expiresAt: '2026-12-01T00:00:00.000Z',
        source: 'static',
      });
      const request = recorded.creates[0];
      expect(createRunRequestSchema.safeParse(request).success).toBe(true);
      // Rule 42's pair: the same request with the credential called minted is refused for a
      // read-only spec at the wire — the exception is the static source's alone.
      const asMinted = { ...request, credential: { ...request?.credential, source: 'minted' } };
      expect(createRunRequestSchema.safeParse(asMinted).success).toBe(
        request?.spec.readOnly !== true,
      );
      await workspace.release({ kind: 'not_started' });
      expect(revoked).toBe(1);
    },
  );

  it('accepts a narrower read credential for a writing run (a shadow task, Q98 (a))', async () => {
    const minting = minterWith(() => 'minted');
    const narrowing: RunGitCredentialMinter = {
      mint: async (request) => minting.minter.mint({ ...request, scope: 'read' }),
    };
    const { client, recorded } = clientWith();
    await provisionerWith(client, narrowing).provision(runSpecFixture());
    expect(recorded.creates[0]?.credential?.scope).toBe('read');
    expect(createRunRequestSchema.safeParse(recorded.creates[0]).success).toBe(true);
  });

  it('refuses — and revokes — a push credential minted for a read-only run', async () => {
    const minting = minterWith();
    const widening: RunGitCredentialMinter = {
      mint: async (request) => minting.minter.mint({ ...request, scope: 'push' }),
    };
    const { client, recorded } = clientWith();
    await expect(
      provisionerWith(client, widening).provision(runSpecFixture({ tools: ['Read'] })),
    ).rejects.toMatchObject({ code: 'invalid_spec', message: /the credential was revoked/ });
    expect(minting.revocations).toBe(1);
    expect(recorded.creates).toEqual([]);
  });

  it('says the widened credential is live when its revocation failed, not that it was revoked', async () => {
    const widening: RunGitCredentialMinter = {
      mint: async () => ({
        kind: 'minted',
        credential: {
          username: 'oauth2',
          password: 'fake_run_credential_push_0001',
          scope: 'push',
          expiresAt: '2026-01-03T00:00:00.000Z',
          revoke: async () => {
            throw new Error('the provider is down');
          },
        },
      }),
    };
    const { client } = clientWith();
    const refused = await provisionerWith(client, widening)
      .provision(runSpecFixture({ tools: ['Read'] }))
      .then(
        () => null,
        (error: unknown) => error as Error,
      );
    expect(refused?.message).toMatch(
      /revocation failed, so it is live until the recovery pass revokes it or it expires at 2026-01-03/,
    );
    expect(refused?.message).not.toMatch(/was revoked/);
  });

  it.each([
    ['a push credential on a read-only spec', { scope: 'push' }, ['Read']],
    ['a host that is not the spec’s', { host: 'evil-git.example.com' }, undefined],
    ['an empty password', { password: '' }, undefined],
  ] as const)('refuses %s at the wire schema', (_label, over, tools) => {
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture(tools === undefined ? {} : { tools: [...tools] }),
      project,
      modelEgressHosts: [],
      runRegistryHosts: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(createRunRequestSchema.safeParse({ spec, credential: CARRIED }).success).toBe(
      tools === undefined,
    );
    expect(
      createRunRequestSchema.safeParse({ spec, credential: { ...CARRIED, ...over } }).success,
    ).toBe(false);
  });

  it('refuses a spec whose container environment carries the credential (criterion 5)', () => {
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture(),
      project: { ...project, containerEnv: { LEAK: `x${CARRIED.password}y` } },
      modelEgressHosts: [],
      runRegistryHosts: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(createRunRequestSchema.safeParse({ spec, credential: CARRIED }).success).toBe(false);
    expect(
      createRunRequestSchema.safeParse({
        spec,
        credential: { ...CARRIED, password: 'fake_run_credential_other' },
      }).success,
    ).toBe(true);
  });

  it('refuses a writing spec with no credential at the wire schema', () => {
    const repoFul = runWorkspaceSpecFor({
      spec: runSpecFixture(),
      project,
      modelEgressHosts: [],
      runRegistryHosts: [],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(createRunRequestSchema.safeParse({ spec: repoFul, credential: null }).success).toBe(
      false,
    );
  });
});

describe('revocation: exactly once, after the end request (TD-028 WP-76 decision 5)', () => {
  it.each([
    ['an ordinary ending', { kind: 'ended', status: 'completed' } as RunWorkspaceEnding],
    ['a crash', { kind: 'crashed' } as RunWorkspaceEnding],
    ['a run that never started', { kind: 'not_started' } as RunWorkspaceEnding],
    [
      'a take-over, whose export pushes first',
      {
        kind: 'ended',
        status: 'cancelled',
        takeOver: {
          branch: 'agentic/task-7',
          commitMessage: 'wip: hand-over',
          tarball: false,
          keepUntil: '2026-01-15T00:00:00.000Z',
        },
      } as RunWorkspaceEnding,
    ],
  ])('revokes once after endRun returns for %s', async (_label, ending) => {
    const log: string[] = [];
    const minting = minterWith(() => 'minted', log);
    const { client } = clientWith();
    const logged: LauncherControlClient = {
      ...client,
      endRun: async (runId, payload) => {
        log.push('endRun');
        return client.endRun(runId, payload);
      },
    };
    const workspace = await provisionerWith(logged, minting.minter).provision(
      runSpecFixture({ runId: RUN_ID }),
    );
    await workspace.release(ending);
    await workspace.release(ending);
    expect(log).toEqual(['endRun', 'revoke', 'endRun']);
    expect(minting.revocations).toBe(1);
  });

  it('revokes once when the create fails, and asks the launcher for nothing else', async () => {
    const minting = minterWith();
    const failing: LauncherControlClient = {
      ...clientWith().client,
      createRun: async () => {
        throw new WorkspaceError('workspace_failed', 'the mirror fetch failed');
      },
      endRun: async () => {
        throw new Error('there is no handle to end');
      },
    };
    await expect(
      provisionerWith(failing, minting.minter).provision(runSpecFixture()),
    ).rejects.toThrow(/mirror fetch failed/);
    expect(minting.revocations).toBe(1);
  });

  it('ends the workspace and revokes once when the answer is refused after the create', async () => {
    const log: string[] = [];
    const minting = minterWith(() => 'minted', log);
    const { client, recorded } = clientWith({ socketPath: '/somewhere/else/ctl.sock' });
    await expect(
      provisionerWith(client, minting.minter).provision(runSpecFixture()),
    ).rejects.toThrow(/control root/);
    expect(recorded.ends).toHaveLength(1);
    expect(minting.revocations).toBe(1);
  });

  it('never revokes for a run that holds no credential', async () => {
    const minting = minterWith();
    const { client } = clientWith();
    const workspace = await provisionerWith(client, minting.minter).provision(
      runSpecFixture({ role: 'ask', tools: [] }),
    );
    await workspace.release({ kind: 'ended', status: 'completed' });
    expect(minting.asked).toEqual([]);
    expect(minting.revocations).toBe(0);
  });

  it('logs a failed revocation as a live token and does not throw from release', async () => {
    const records: { message: string; fields: Record<string, unknown> }[] = [];
    const logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (fields: Record<string, unknown>, message: string) =>
        records.push({ fields, message }),
    };
    const failingRevoke: RunGitCredentialMinter = {
      mint: async () => ({
        kind: 'minted',
        credential: {
          username: 'oauth2',
          password: 'fake_run_credential_push_0001',
          scope: 'push',
          expiresAt: '2026-01-03T00:00:00.000Z',
          revoke: async () => {
            throw new Error('the provider is down');
          },
        },
      }),
    };
    const workspace = await createLauncherRunWorkspaceProvisioner({
      client: clientWith().client,
      credentials: failingRevoke,
      projects: { forRun: async () => project },
      controlRoot: CONTROL_ROOT,
      modelEgressHosts: [],
      runRegistryHosts: [],
      credentialTtlSeconds: 86_400,
      clock: manualClock(),
      logger,
    }).provision(runSpecFixture());
    await expect(
      workspace.release({ kind: 'ended', status: 'completed' }),
    ).resolves.toBeUndefined();
    expect(records.map((record) => record.message)).toContain(
      'the run credential could not be revoked here; unless the recovery pass has already revoked it (a cancelled run is reached that way, and a not_found here then means it is gone), it is live until that pass revokes it from its audit row, or until it expires if the pass cannot (PROGRESS backlog 155)',
    );
    expect(JSON.stringify(records)).not.toContain('fake_run_credential_push_0001');
  });
});

/**
 * Decision 4 — **the runner answers `cred.get`**, which `createRunletSpawn` was given no responder
 * for until WP-76, so every in-container ask was refused. Against the real shim over a real socket:
 * the helper's question travels shim → runner and back.
 */
describe('the workspace’s cred.get is answered by this process', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });

  const TOKEN = 'run-token-pppppppppppppppppppppp';

  const live = async (options: { readonly readOnly?: boolean } = {}) => {
    const volume = await createControlVolume();
    const clock = manualClock(1_000);
    const shim = createRunletShim({
      controlSocketPath: volume.controlSocketPath,
      credentialSocketPath: volume.credentialSocketPath,
      token: TOKEN,
      clock,
    });
    await shim.start();
    cleanups.push(async () => {
      await shim.close();
      await volume.cleanup();
    });
    let releaseEnd: (() => void) | null = null;
    const base = clientWith({ socketPath: volume.controlSocketPath }).client;
    const client: LauncherControlClient = {
      ...base,
      createRun: async (payload) => ({
        ...(await base.createRun(payload)),
        attachment: { socketPath: volume.controlSocketPath, token: TOKEN, workdir: '/work/repo' },
      }),
      endRun: async (runId, payload) => {
        await new Promise<void>((resolve) => {
          releaseEnd = resolve;
        });
        return base.endRun(runId, payload);
      },
    };
    const workspace = await provisionerWith(
      client,
      minterWith().minter,
      path.dirname(volume.controlSocketPath),
    ).provision(runSpecFixture(options.readOnly === true ? { tools: ['Read', 'Bash'] } : {}));
    const child = workspace.spawn({
      ...nodeScript('setInterval(() => {}, 1000)'),
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin' },
      signal: new AbortController().signal,
    });
    cleanups.push(async () => {
      child.kill('SIGKILL');
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const ask = async (host: string) => {
      const helper = await connectProbe(volume.credentialSocketPath);
      helper.send({ type: 'cred.get', request_id: 'git-1', host, protocol: 'https' });
      const reply = await helper.next('cred.reply');
      helper.close();
      return (reply as { credential: unknown }).credential;
    };
    return { workspace, ask, finishEnd: () => releaseEnd?.() };
  };

  it('answers the git host with the run’s own credential, and refuses a host merely like it', async () => {
    const { ask } = await live();
    expect(await ask('git.example.com')).toEqual({
      username: 'oauth2',
      password: 'fake_run_credential_push_0001',
    });
    // Lower-case spellings only: the shim refuses a host that is not a lowercase DNS name itself,
    // before the runner is asked (`broker.test.ts` covers the case fold on the runner's side).
    for (const host of [
      'evil-git.example.com',
      'git.example.com.evil.test',
      'ci.git.example.com',
    ]) {
      expect(await ask(host), host).toBeNull();
    }
  });

  it('hands a read-only run its read credential and nothing wider', async () => {
    const { ask } = await live({ readOnly: true });
    expect(await ask('git.example.com')).toEqual({
      username: 'oauth2',
      password: 'fake_run_credential_read_0001',
    });
  });

  it('answers null from the moment release begins, before the end request returns', async () => {
    const { workspace, ask, finishEnd } = await live();
    expect(await ask('git.example.com')).not.toBeNull();
    const releasing = workspace.release({ kind: 'ended', status: 'completed' });
    expect(await ask('git.example.com')).toBeNull();
    finishEnd();
    await releasing;
  });
});

describe('the control socket the launcher answers with', () => {
  it('is accepted when it is under this process’ own control root', () => {
    expect(() =>
      assertControlSocketUnderRoot(`${CONTROL_ROOT}/${RUN_ID}/ctl.sock`, CONTROL_ROOT),
    ).not.toThrow();
  });

  it.each([
    ['a different mount point', '/var/run/ctl/x/ctl.sock'],
    ['a prefix that only looks like one', '/run/agentic/ctl-other/x/ctl.sock'],
    ['a path that climbs out', '/run/agentic/ctl/../../etc/ctl.sock'],
    // Accepted until WP-53's review: only `/../` was refused, so a path *ending* in `..` — which
    // resolves to the root's parent — slipped through.
    ['a path that climbs out at its end', '/run/agentic/ctl/x/..'],
  ])('is refused when it is %s', (_label, socketPath) => {
    // The failure this turns into a named refusal is `ECONNREFUSED` thirty seconds into a run,
    // whose real cause is two containers mounting one volume at two paths.
    expect(() => assertControlSocketUnderRoot(socketPath, CONTROL_ROOT)).toThrow(WorkspaceError);
  });

  it('refuses before the run starts, so the container is torn down by the end request', async () => {
    const { client } = clientWith({ socketPath: '/somewhere/else/ctl.sock' });
    await expect(provisionerWith(client).provision(runSpecFixture())).rejects.toThrow(
      /control root/,
    );
  });
});

describe('the CLI path', () => {
  it('is whatever the launcher said the run image carries (backlog 34)', async () => {
    const { client } = clientWith({ claudeCodePath: '/opt/claude/claude' });
    const workspace = await provisionerWith(client).provision(runSpecFixture());
    expect(workspace.claudeCodePath).toBe('/opt/claude/claude');
  });
});

describe('the CLI environment (WP-118)', () => {
  it('is whatever the launcher answered for the run container, handed on beside the CLI path', async () => {
    const { client } = clientWith();
    const workspace = await provisionerWith(client).provision(runSpecFixture());
    expect(workspace.cliEnvironment).toEqual(CLI_ENVIRONMENT);
  });
});

describe('release', () => {
  it('ends the run with no export for an ordinary ending', async () => {
    const { client, recorded } = clientWith();
    const workspace = await provisionerWith(client).provision(runSpecFixture({ runId: RUN_ID }));
    await workspace.release({ kind: 'ended', status: 'completed' });
    expect(recorded.ends).toHaveLength(1);
    expect(recorded.ends[0]?.payload.export).toBeNull();
    expect(recorded.ends[0]?.payload.handle.runId).toBe(RUN_ID);
  });

  it('carries the take-over’s branch, message, tarball and retention', async () => {
    const { client, recorded } = clientWith();
    const workspace = await provisionerWith(client).provision(runSpecFixture({ runId: RUN_ID }));
    await workspace.release({
      kind: 'ended',
      status: 'cancelled',
      takeOver: {
        branch: 'agentic/task-7',
        commitMessage: 'wip: hand-over to Ada Lovelace',
        tarball: true,
        keepUntil: '2026-01-15T00:00:00.000Z',
      },
    });
    expect(recorded.ends[0]?.payload.export).toEqual({
      branch: 'agentic/task-7',
      commitMessage: 'wip: hand-over to Ada Lovelace',
      tarball: true,
      keepUntil: '2026-01-15T00:00:00.000Z',
    });
  });

  it.each([
    ['a run that never started', { kind: 'not_started' } as RunWorkspaceEnding],
    ['a run that crashed', { kind: 'crashed' } as RunWorkspaceEnding],
  ])('still ends the run for %s', async (_label, ending) => {
    const { client, recorded } = clientWith();
    const workspace = await provisionerWith(client).provision(runSpecFixture({ runId: RUN_ID }));
    await workspace.release(ending);
    expect(recorded.ends).toHaveLength(1);
    expect(recorded.ends[0]?.payload.export).toBeNull();
  });

  it('does not throw when the launcher cannot be told, because the caller is in a `finally`', async () => {
    const failing: LauncherControlClient = {
      ...clientWith().client,
      endRun: async () => {
        throw new WorkspaceError('engine_unavailable', 'the launcher is gone');
      },
    };
    const workspace = await provisionerWith(failing).provision(runSpecFixture({ runId: RUN_ID }));
    await expect(workspace.release({ kind: 'ended', status: 'failed' })).resolves.toBeUndefined();
  });
});

/**
 * Backlog 467: an unsuccessful run's unfinished work goes through the take-over's verb — the same end
 * request, the same export helper, the run's own credential (revoked only after the end request,
 * asserted above for every ending) — with `onlyIfChanged`, no tarball and no longer retention. And the
 * launcher's answer is what the run records.
 */
describe('release, for an unsuccessful run’s unfinished work (backlog 467)', () => {
  const UNFINISHED = {
    branch: 'agentic/task-7',
    commitMessage: 'wip: unfinished attempt 1 of implementation (error_max_turns)',
  };
  const EXPORTED = {
    branch: 'agentic/task-7',
    pushed: true,
    changed: true,
    commitSha: 'abc1234def',
    tarballPath: null,
    tarballBytes: 0,
    droppedLinks: 0,
  };
  const answering = (
    exported: EndRunResponse['exported'],
    failures: readonly string[] = [],
  ): { client: LauncherControlClient; recorded: ReturnType<typeof clientWith>['recorded'] } => {
    const base = clientWith();
    return {
      recorded: base.recorded,
      client: {
        ...base.client,
        endRun: async (runId, payload) => {
          await base.client.endRun(runId, payload);
          return { exported, keepUntil: null, failures: [...failures] };
        },
      },
    };
  };
  const released = async (client: LauncherControlClient) => {
    const workspace = await provisionerWith(client).provision(runSpecFixture({ runId: RUN_ID }));
    return workspace.release({ kind: 'ended', status: 'failed', unfinishedWork: UNFINISHED });
  };

  it('asks for the export only if the tree changed, with no tarball and no retention', async () => {
    const { client, recorded } = answering(EXPORTED);
    expect(await released(client)).toEqual({
      savedWork: { branch: 'agentic/task-7', commit_sha: 'abc1234def', pushed: true },
    });
    expect(recorded.ends[0]?.payload.export).toEqual({
      branch: 'agentic/task-7',
      commitMessage: 'wip: unfinished attempt 1 of implementation (error_max_turns)',
      tarball: false,
      onlyIfChanged: true,
    });
  });

  it('records nothing for an unchanged tree, and an attempt that did not push for every failure', async () => {
    expect(await released(answering({ ...EXPORTED, changed: false, pushed: false }).client)).toBe(
      undefined,
    );
    // The helper refused (a nested repository, say): the launcher answers no export and a failure.
    expect(await released(answering(null, ['export: refusing to export']).client)).toEqual({
      savedWork: { branch: 'agentic/task-7', commit_sha: null, pushed: false },
    });
    // The push was refused by the remote.
    expect(await released(answering({ ...EXPORTED, pushed: false }).client)).toEqual({
      savedWork: { branch: 'agentic/task-7', commit_sha: 'abc1234def', pushed: false },
    });
    // The launcher could not be told at all: nothing is claimed about the push.
    const failing: LauncherControlClient = {
      ...clientWith().client,
      endRun: async () => {
        throw new WorkspaceError('engine_unavailable', 'the launcher is gone');
      },
    };
    expect(await released(failing)).toEqual({
      savedWork: { branch: 'agentic/task-7', commit_sha: null, pushed: false },
    });
  });

  it('keeps a commit only when it is a sha', () => {
    expect(savedWorkOf(UNFINISHED, { ...EXPORTED, commitSha: 'not-a-sha' })).toEqual({
      branch: 'agentic/task-7',
      commit_sha: null,
      pushed: true,
    });
    // An earlier launcher answers no `changed`: the export happened, so it is read as changed.
    const { changed: _changed, ...withoutChanged } = EXPORTED;
    expect(savedWorkOf(UNFINISHED, withoutChanged)?.pushed).toBe(true);
  });

  it('sends a take-over’s export rather than the unfinished work’s if both were ever set', async () => {
    const { client, recorded } = answering(EXPORTED);
    const workspace = await provisionerWith(client).provision(runSpecFixture({ runId: RUN_ID }));
    const takeOver = {
      branch: 'agentic/task-7',
      commitMessage: 'wip: hand-over to Ada Lovelace',
      tarball: false,
      keepUntil: '2026-01-15T00:00:00.000Z',
    };
    expect(
      await workspace.release({
        kind: 'ended',
        status: 'cancelled',
        takeOver,
        unfinishedWork: UNFINISHED,
      }),
    ).toBeUndefined();
    expect(recorded.ends[0]?.payload.export).toEqual(takeOver);
  });
});

describe('the control root this process was configured with', () => {
  it('must be absolute, because a relative one is resolved against nothing', () => {
    expect(() =>
      createLauncherRunWorkspaceProvisioner({
        client: clientWith().client,
        credentials: minterWith().minter,
        projects: { forRun: async () => project },
        controlRoot: 'run/agentic/ctl',
        modelEgressHosts: [],
        runRegistryHosts: [],
        credentialTtlSeconds: 86_400,
        clock: manualClock(),
      }),
    ).toThrow(/absolute path/);
  });
});

/**
 * WP-146 (TD-028 decision 13b): a deploy key puts its route on the spec and its CONNECT host on this
 * run's egress list, travels to the launcher as `source: 'deploy_key'`, is **never** answered to the
 * workspace's `cred.get`, and signs — in this process — what the run shim's agent socket relays,
 * until `release` begins.
 */
const userauthFor = (blob: Buffer): Buffer =>
  Buffer.concat([
    sshString(Buffer.alloc(32, 9)),
    Buffer.from([50]),
    sshString('git'),
    sshString('ssh-connection'),
    sshString('publickey'),
    Buffer.from([1]),
    sshString('ssh-ed25519'),
    sshString(blob),
  ]);

describe('a deploy-key run (WP-146)', () => {
  const cleanups: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) {
      await cleanup();
    }
  });
  const TOKEN = 'run-token-kkkkkkkkkkkkkkkkkkkkkk';
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
  const deployKeyMinter = (privateKey: string = FAKE_DEPLOY_KEY.privateKey) => {
    let revoked = 0;
    const minter: RunGitCredentialMinter = {
      mint: async () => ({
        kind: 'minted',
        credential: {
          username: 'git',
          password: privateKey,
          scope: 'push',
          expiresAt: '2026-10-05T12:00:00.000Z',
          source: 'deploy_key',
          ssh: { publicKey: FAKE_DEPLOY_KEY.publicKey, route: ROUTE },
          revoke: async () => {
            revoked += 1;
          },
        },
      }),
    };
    return { minter, revoked: () => revoked };
  };

  it.each([
    ['a writing run', ['Read', 'Edit', 'Bash']],
    ['a read-only run', ['Read', 'Grep']],
  ])(
    'carries the key to %s with its route on the spec and altssh on its egress list',
    async (_, tools) => {
      const { minter } = deployKeyMinter();
      const { client, recorded } = clientWith();
      await provisionerWith(client, minter).provision(runSpecFixture({ tools }));
      const request = recorded.creates[0];
      expect(request?.credential).toMatchObject({
        source: 'deploy_key',
        username: 'git',
        scope: 'push',
      });
      expect(request?.spec.repo?.ssh).toMatchObject({
        publicKey: FAKE_DEPLOY_KEY.publicKey.split(' ').slice(0, 2).join(' '),
        connectHost: 'altssh.gitlab.com',
        connectPort: 443,
      });
      expect(request?.spec.egress.hosts).toContain('altssh.gitlab.com');
      expect(request?.spec.egress.connectPorts).not.toContain(22);
      expect(createRunRequestSchema.safeParse(request).success).toBe(true);
      // The wire's pair rule: the key without the route, or the route without the key, is refused.
      const keyOnly = {
        ...request,
        spec: { ...request?.spec, repo: { ...request?.spec.repo, ssh: undefined } },
      };
      expect(createRunRequestSchema.safeParse(keyOnly).success).toBe(false);
      const asMinted = { ...request, credential: { ...request?.credential, source: 'minted' } };
      expect(createRunRequestSchema.safeParse(asMinted).success).toBe(false);
    },
  );

  it('refuses a key that does not parse before the create, revokes once, and sends nothing', async () => {
    const { minter, revoked } = deployKeyMinter('not a key at all, fake');
    const { client, recorded } = clientWith();
    await expect(provisionerWith(client, minter).provision(runSpecFixture())).rejects.toMatchObject(
      {
        code: 'invalid_spec',
      },
    );
    expect(recorded.creates).toEqual([]);
    expect(revoked()).toBe(1);
  });

  it('signs for the agent socket here, never answers cred.get, and stops signing at release', async () => {
    const volume = await createControlVolume();
    const agentSocket = path.join(volume.dir, 'a.sock');
    const clock = manualClock(1_000);
    const shim = createRunletShim({
      controlSocketPath: volume.controlSocketPath,
      credentialSocketPath: volume.credentialSocketPath,
      sshAgentSocketPath: agentSocket,
      sshPublicKey: FAKE_DEPLOY_KEY.publicKey.split(' ').slice(0, 2).join(' '),
      token: TOKEN,
      clock,
    });
    await shim.start();
    cleanups.push(async () => {
      await shim.close();
      await volume.cleanup();
    });
    const base = clientWith({ socketPath: volume.controlSocketPath }).client;
    const client: LauncherControlClient = {
      ...base,
      createRun: async (payload) => ({
        ...(await base.createRun(payload)),
        attachment: { socketPath: volume.controlSocketPath, token: TOKEN, workdir: '/work/repo' },
      }),
    };
    const workspace = await provisionerWith(
      client,
      deployKeyMinter().minter,
      path.dirname(volume.controlSocketPath),
    ).provision(runSpecFixture());
    const child = workspace.spawn({
      ...nodeScript('setInterval(() => {}, 1000)'),
      cwd: process.cwd(),
      env: { PATH: process.env['PATH'] ?? '/usr/bin' },
      signal: new AbortController().signal,
    });
    cleanups.push(async () => {
      child.kill('SIGKILL');
    });
    await new Promise((resolve) => setTimeout(resolve, 150));
    const blob = sshEd25519PublicKeyBlob(RFC8032_TEST1.publicKey);
    const sign = async (): Promise<Buffer> => {
      const socket = connect(agentSocket);
      // An SSH user-authentication request for `git` with this key (RFC 4252 § 7): the one
      // shape the signer signs (review round 1).
      const data = userauthFor(blob);
      const reply = await new Promise<Buffer>((resolve, reject) => {
        socket.once('data', resolve);
        socket.once('error', reject);
        socket.write(
          encodeAgentMessage(
            SSH_AGENTC_SIGN_REQUEST,
            Buffer.concat([sshString(blob), sshString(data), Buffer.alloc(4)]),
          ),
        );
      });
      socket.destroy();
      return reply;
    };
    const answer = await sign();
    expect(answer[4]).toBe(SSH_AGENT_SIGN_RESPONSE);
    const signature = answer.subarray(answer.length - 64);
    const publicKey = createPublicKey({
      key: { kty: 'OKP', crv: 'Ed25519', x: RFC8032_TEST1.publicKey.toString('base64url') },
      format: 'jwk',
    });
    expect(verify(null, userauthFor(blob), publicKey, signature)).toBe(true);
    // The HTTPS credential socket answers nothing for a deploy-key run.
    const helper = await connectProbe(volume.credentialSocketPath);
    helper.send({
      type: 'cred.get',
      request_id: 'git-1',
      host: 'git.example.com',
      protocol: 'https',
    });
    expect(((await helper.next('cred.reply')) as { credential: unknown }).credential).toBeNull();
    helper.close();
    await workspace.release({ kind: 'not_started' });
    expect((await sign()).equals(AGENT_FAILURE)).toBe(true);
  });
});
