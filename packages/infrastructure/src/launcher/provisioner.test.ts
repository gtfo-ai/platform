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
import path from 'node:path';
import { WorkspaceError } from '@platform/application';
import { afterEach, describe, expect, it } from 'vitest';
import { createRunletShim } from '../runlet/shim.js';
import { connectProbe, createControlVolume, nodeScript } from '../runlet/testing.js';
import { manualClock } from '../runner/clock.js';
import { runSpecFixture } from '../runner/fixtures.js';
import type { RunWorkspaceEnding } from '../runner/workspace-runner.js';
import type { LauncherControlClient } from './client.js';
import {
  type CreateRunRequestPayload,
  createRunRequestSchema,
  type EndRunRequestPayload,
} from './protocol.js';
import {
  assertControlSocketUnderRoot,
  createLauncherRunWorkspaceProvisioner,
  type RunGitCredentialAnswer,
  type RunGitCredentialMinter,
  type RunWorkspaceProject,
  runWorkspaceSpecFor,
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
          credentialScope: payload.credential?.scope ?? null,
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
    credentialTtlSeconds: 86_400,
    clock: manualClock(Date.parse('2026-01-01T00:00:00.000Z')),
  });

describe('backlog 71 — `checkoutRef` reaches the workspace', () => {
  it('checks out the task’s own branch for a re-entry run', () => {
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture({ checkoutRef: 'agentic/task-7' }),
      project,
      modelEgressHosts: [],
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
});

describe('the workspace spec a run gets', () => {
  it('carries the git host and the model host, and nothing else', () => {
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture(),
      project,
      modelEgressHosts: ['api.anthropic.com'],
      now: new Date('2026-01-01T00:00:00.000Z'),
    });
    expect(spec.egress.hosts).toEqual(['api.anthropic.com', 'git.example.com']);
  });

  it('fails closed when no model host is declared', () => {
    // Stated rather than assumed: the run reaches only its git host and the CLI's first request is
    // refused by the sidecar. Visibly wrong beats silently permissive (technical/05).
    const spec = runWorkspaceSpecFor({
      spec: runSpecFixture(),
      project,
      modelEgressHosts: [],
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
        /writes to its checkout and no git credential can be minted.*mint_credentials is off/,
    });
    expect(recorded.creates).toEqual([]);
  });

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

describe('the control root this process was configured with', () => {
  it('must be absolute, because a relative one is resolved against nothing', () => {
    expect(() =>
      createLauncherRunWorkspaceProvisioner({
        client: clientWith().client,
        credentials: minterWith().minter,
        projects: { forRun: async () => project },
        controlRoot: 'run/agentic/ctl',
        modelEgressHosts: [],
        credentialTtlSeconds: 86_400,
        clock: manualClock(),
      }),
    ).toThrow(/absolute path/);
  });
});
