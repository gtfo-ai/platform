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
import { WorkspaceError } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { manualClock } from '../runner/clock.js';
import { runSpecFixture } from '../runner/fixtures.js';
import type { RunWorkspaceEnding } from '../runner/workspace-runner.js';
import type { LauncherControlClient } from './client.js';
import type { CreateRunRequestPayload, EndRunRequestPayload } from './protocol.js';
import {
  assertControlSocketUnderRoot,
  createLauncherRunWorkspaceProvisioner,
  type RunWorkspaceProject,
  runWorkspaceSpecFor,
} from './provisioner.js';

const CONTROL_ROOT = '/run/agentic/ctl';
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
          credentialMinted: false,
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

const provisionerWith = (client: LauncherControlClient) =>
  createLauncherRunWorkspaceProvisioner({
    client,
    projects: { forRun: async () => project },
    controlRoot: CONTROL_ROOT,
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
    expect(spec.repo.checkoutBranch).toBe('agentic/task-7');
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
    expect(spec.repo.checkoutBranch).toBeNull();
    expect(spec.repo.defaultBranch).toBe('main');
  });

  it('reaches the control plane’s create request, not only the builder', async () => {
    // Standing rule 82's shape: the case above would pass with the provisioner deleted.
    const { client, recorded } = clientWith();
    await provisionerWith(client).provision(runSpecFixture({ checkoutRef: 'agentic/task-9' }));
    expect(recorded.creates[0]?.spec.repo.checkoutBranch).toBe('agentic/task-9');
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

  it('asks the launcher to mint for the project path, the git host and the branch namespace', async () => {
    const { client, recorded } = clientWith();
    await provisionerWith(client).provision(runSpecFixture());
    expect(recorded.creates[0]?.credential).toEqual({
      project: 'acme/api',
      host: 'git.example.com',
      branchPatterns: ['agentic/*'],
      ttlSeconds: 86_400,
    });
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
        projects: { forRun: async () => project },
        controlRoot: 'run/agentic/ctl',
        modelEgressHosts: [],
        credentialTtlSeconds: 86_400,
        clock: manualClock(),
      }),
    ).toThrow(/absolute path/);
  });
});
