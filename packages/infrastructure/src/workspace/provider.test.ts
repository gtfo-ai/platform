import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WORKSPACE_LABELS, type WorkspaceHandle } from '@platform/application';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerEngine } from './engine.js';
import { FIXTURE_RUN_ID, shortTempDir, workspaceSpecFixture } from './fixtures.js';
import { assertProjectEnv, assertRunnerUid, DockerWorkspaceProvider } from './provider.js';
import { parseTar, writeTar } from './tar.js';
import { FakeDockerDaemon } from './testing.js';

const TOKEN = 'a'.repeat(32);
const SECRET = 'glpat-FAKE-000000000000000000';

let daemon: FakeDockerDaemon;
let provider: DockerWorkspaceProvider;
let controlRoot: string;
let workDir: string;
let archives: Map<string, Buffer>;

const exportArchive = (): Buffer =>
  writeTar([
    {
      name: 'export.tar',
      type: 'file',
      content: writeTar([
        { name: 'repo/', type: 'directory' },
        { name: 'repo/README.md', type: 'file', content: '# fixture\n' },
        { name: 'repo/escape', type: 'symlink', linkname: '../../etc/passwd' },
      ]).toString('binary'),
    },
  ]);

const startDaemon = async (
  script?: (container: { name: string }) => { exitCode: number; logs: string },
): Promise<void> => {
  archives = new Map();
  daemon = new FakeDockerDaemon({
    archives,
    ...(script === undefined ? {} : { script }),
  });
  const socketPath = await daemon.start();
  // The launcher's own network, which the sidecar is connected to as its route out. It exists
  // before any run does (compose creates it), so the double is given it up front.
  daemon.networks.set('net-platform', { name: 'platform', internal: false });
  provider = new DockerWorkspaceProvider({
    engine: new DockerEngine({ socketPath }),
    images: {
      runtime: 'platform-runtime:test',
      egress: 'tinyproxy:test',
      git: 'git:test',
      runtimeSourceDir: null,
    },
    controlVolume: 'ctl',
    controlRoot,
    cacheVolume: 'repo-cache',
    helperNetwork: 'platform',
    egressNetwork: 'platform',
    runnerUid: 1000,
    mintToken: () => TOKEN,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
};

beforeEach(async () => {
  // Short, because the control root becomes a Unix socket path (names.ts § MAX_UNIX_SOCKET_PATH).
  workDir = await shortTempDir('agentic-wp14-');
  controlRoot = path.join(workDir, 'ctl');
  await mkdir(controlRoot, { recursive: true });
  await startDaemon();
});

afterEach(async () => {
  await daemon.stop();
  await rm(workDir, { recursive: true, force: true });
});

const created = async (): Promise<WorkspaceHandle> => {
  const spec = workspaceSpecFixture();
  const handle = await provider.create(spec);
  // The prepare helper writes the token file inside the container; the runner reads it through the
  // same volume, which in this tier is a real directory.
  await mkdir(path.join(controlRoot, spec.runId), { recursive: true });
  await writeFile(path.join(controlRoot, spec.runId, 'token'), `${TOKEN}\n`);
  return handle;
};

describe('runner uid (Q51)', () => {
  it('refuses to build a provider on any uid but 1000, naming both numbers', () => {
    expect(() => assertRunnerUid(0)).toThrow(/must run as uid 1000.*this process is uid 0/s);
    expect(() => assertRunnerUid(501)).toThrow(/uid 501/);
    expect(() => assertRunnerUid(1000)).not.toThrow();
  });
});

describe('create', () => {
  it('creates the control sub-directory before the run container starts (WP-13 obligation 1)', async () => {
    await provider.create(workspaceSpecFixture());
    // The double refuses a `volume-subpath` it has not seen created, the way the daemon does
    // (measured on 29.7.2). Reorder `#prepare` after the run container and this fails with the
    // daemon's own message rather than passing quietly.
    expect(daemon.controlSubpaths.has(FIXTURE_RUN_ID)).toBe(true);
    const order = daemon.requests.filter(
      (recorded) => recorded.path === '/containers/create',
    ).length;
    expect(order).toBeGreaterThanOrEqual(4);
  });

  it('chowns the control directory and the workspace root to the uid the shim runs as', async () => {
    await provider.create(workspaceSpecFixture());
    const prepare = daemon.byName(`prep-${FIXTURE_RUN_ID}`);
    const script = (prepare?.body.Cmd ?? []).join('\n');
    expect(script).toContain(`chown -R 1000:1000 /ctl/${FIXTURE_RUN_ID}`);
    expect(script).toContain('chown 1000:1000 /work');
    expect(script).toContain(`chmod 600 /ctl/${FIXTURE_RUN_ID}/token`);
    expect(prepare?.body.HostConfig).toMatchObject({ CapAdd: ['CHOWN'], NetworkMode: 'none' });
  });

  it('creates the run network as internal, so the workspace has no default route', async () => {
    await provider.create(workspaceSpecFixture());
    const network = [...daemon.networks.values()].find((entry) => entry.name.startsWith('run-'));
    expect(network).toEqual({ name: `run-${FIXTURE_RUN_ID}`, internal: true });
  });

  it('clones with no network at all', async () => {
    await provider.create(workspaceSpecFixture());
    const clone = daemon.byName(`clone-${FIXTURE_RUN_ID}`);
    expect(clone?.body.HostConfig?.NetworkMode).toBe('none');
    expect((clone?.body.Cmd ?? []).join('\n')).toContain('--shared');
  });

  it('starts the run container with technical/05 hardening and the control sub-path', async () => {
    const handle = await provider.create(workspaceSpecFixture());
    const container = daemon.containers.get(handle.containerId);
    expect(container?.body.User).toBe('1000:1000');
    expect(container?.body.HostConfig?.Mounts?.[1]).toMatchObject({
      Source: 'ctl',
      VolumeOptions: { Subpath: FIXTURE_RUN_ID },
    });
    expect(container?.state).toBe('running');
  });

  it('labels every object with the run, the project and the retention window', async () => {
    const spec = workspaceSpecFixture();
    const handle = await provider.create(spec);
    expect(daemon.volumes.get(handle.volumeName)).toMatchObject({
      [WORKSPACE_LABELS.run]: spec.runId,
      [WORKSPACE_LABELS.project]: spec.projectId,
      [WORKSPACE_LABELS.role]: 'workspace',
      [WORKSPACE_LABELS.keepUntil]: spec.keepUntil,
    });
  });

  it('points the workspace at the sidecar and connects the sidecar to a second network', async () => {
    const handle = await provider.create(workspaceSpecFixture());
    const env = daemon.containers.get(handle.containerId)?.body.Env ?? [];
    expect(env).toContain(`HTTPS_PROXY=http://egress-${FIXTURE_RUN_ID}:8888`);
    const sidecar = daemon.containers.get(handle.sidecarContainerId ?? '');
    // Two networks on the sidecar and one on the workspace *is* the network policy.
    expect(sidecar?.networks).toHaveLength(2);
    expect(daemon.containers.get(handle.containerId)?.networks).toHaveLength(1);
  });

  it('starts no sidecar when the spec allows no host, and sets no proxy', async () => {
    const handle = await provider.create(
      workspaceSpecFixture({ egress: { hosts: [], connectPorts: [443] } }),
    );
    expect(handle.sidecarContainerId).toBeNull();
    const env = daemon.containers.get(handle.containerId)?.body.Env ?? [];
    expect(env.some((entry) => entry.startsWith('HTTPS_PROXY='))).toBe(false);
  });

  it('makes the credential helper the shim, not anything in the repository', async () => {
    const handle = await provider.create(workspaceSpecFixture());
    const env = daemon.containers.get(handle.containerId)?.body.Env ?? [];
    expect(env).toContain('GIT_CONFIG_KEY_0=credential.helper');
    expect(env).toContain('GIT_CONFIG_VALUE_0=!agentic-runlet credential');
    expect(env).toContain('RUNLET_TOKEN_FILE=/ctl/token');
    // The token itself never reaches the run container's environment: it is a file on the control
    // volume, which the launcher can unlink (`runlet/config.ts`).
    expect(env.some((entry) => entry.includes(TOKEN))).toBe(false);
  });

  it('refuses a project variable that would redirect the proxy or the control channel', () => {
    for (const name of [
      'HTTPS_PROXY',
      'HTTP_PROXY',
      'RUNLET_CONTROL_SOCKET',
      'RUNLET_TOKEN_FILE',
      'GIT_CONFIG_VALUE_0',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'PATH',
      'HOME',
      'CLAUDE_CONFIG_DIR',
    ]) {
      expect(() => assertProjectEnv({ [name]: 'x' })).toThrow(/reserved variable/);
    }
    expect(() => assertProjectEnv({ CI: 'true', NODE_ENV: 'test' })).not.toThrow();
  });

  it('refuses a spec that does not validate before it touches the daemon', async () => {
    const before = daemon.requests.length;
    await expect(
      provider.create({ ...workspaceSpecFixture(), runId: '../other' }),
    ).rejects.toMatchObject({ code: 'invalid_spec' });
    expect(daemon.requests).toHaveLength(before);
  });

  /**
   * Either a handle or nothing. A create that failed after starting the run container and left it
   * up would be a container running an agent that no handle names — nothing would ever stop it,
   * and the shim's own teardown does not reach a detached grandchild.
   */
  it('leaves nothing behind when a later step fails', async () => {
    await daemon.stop();
    await startDaemon((container) =>
      container.name.startsWith('clone-')
        ? { exitCode: 128, logs: 'fatal: repository not found\n' }
        : { exitCode: 0, logs: '' },
    );
    await expect(provider.create(workspaceSpecFixture())).rejects.toMatchObject({
      code: 'workspace_failed',
    });
    expect(daemon.created.filter((container) => container.state === 'running')).toEqual([]);
    expect(daemon.created.map((container) => container.name)).toEqual([]);
    expect([...daemon.networks.values()].filter((entry) => entry.name.startsWith('run-'))).toEqual(
      [],
    );
    expect([...daemon.volumes.keys()].filter((name) => name.startsWith('egress-'))).toEqual([]);
  });

  /**
   * Standing rule 35: making a dependency required proves it is *supplied*, not that it is used.
   * This plants the run credential in a helper's output and looks for it in the error the caller
   * sees — the only assertion that distinguishes "a redactor exists" from "the secret is gone".
   *
   * The credential is configured nowhere in this test: it reaches the redaction list only because
   * the function that put it in the helper's environment also returned it as a secret. Delete
   * `secrets: [credential.password]` from that function and this fails.
   */
  it('redacts the run credential out of the failure a helper reports', async () => {
    await daemon.stop();
    await startDaemon(() => ({
      exitCode: 1,
      logs: `fatal: could not read Password for 'https://agentic:${SECRET}@vcs.example.com'\n`,
    }));
    const spec = workspaceSpecFixture();
    const failure = await provider
      .updateMirror({
        projectId: spec.projectId,
        repo: spec.repo,
        credential: { host: 'vcs.example.com', username: 'agentic', password: SECRET },
      })
      .then(() => null)
      .catch((error: unknown) => error as { detail: string | null });
    expect(failure?.detail).not.toContain(SECRET);
    // And the rest of the message survives: a redactor that returned an empty string would pass
    // the assertion above and destroy the only diagnostic an operator gets.
    expect(failure?.detail).toContain('vcs.example.com');
    expect(failure?.detail).toContain('[REDACTED:integration:run_credential_0]');
  });

  it('has nothing to redact, and still reports, when the helper carries no credential', async () => {
    await daemon.stop();
    await startDaemon(() => ({ exitCode: 1, logs: 'fatal: repository not found\n' }));
    await expect(provider.create(workspaceSpecFixture())).rejects.toMatchObject({
      detail: expect.stringContaining('repository not found'),
    });
  });
});

describe('attach', () => {
  it('returns the runner-side socket path and the run token', async () => {
    const handle = await created();
    const attachment = await provider.attach(handle);
    expect(attachment).toEqual({
      socketPath: path.join(controlRoot, FIXTURE_RUN_ID, 'ctl.sock'),
      token: TOKEN,
      workdir: '/work/repo',
    });
  });

  it('refuses to attach to a container that is not running', async () => {
    const handle = await created();
    await provider.kill(handle);
    await expect(provider.attach(handle)).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses when the token is not on the control volume', async () => {
    const handle = await provider.create(workspaceSpecFixture());
    await expect(provider.attach(handle)).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('kill and destroy (WP-13 obligation 3)', () => {
  it('stops the container', async () => {
    const handle = await created();
    await provider.kill(handle);
    expect(daemon.containers.get(handle.containerId)?.state).toBe('exited');
  });

  it('is idempotent when the container has already gone', async () => {
    const handle = await created();
    await provider.destroy(handle);
    await expect(provider.destroy(handle)).resolves.toBeUndefined();
    await expect(provider.kill(handle)).resolves.toBeUndefined();
  });

  /**
   * The ordering claim, which is the half a fake can check: a `destroy` that removed the container
   * without stopping it first would leave the daemon to `SIGKILL` it with no grace period — and on
   * the paths where the shim exited first, "the shim exited" is not "the workspace's processes are
   * gone" (`research/12`).
   */
  it('stops the container before removing anything', async () => {
    const handle = await created();
    await provider.destroy(handle);
    const paths = daemon.requests.map((recorded) => `${recorded.method} ${recorded.path}`);
    const stop = paths.indexOf(`POST /containers/${handle.containerId}/stop`);
    const remove = paths.indexOf(`DELETE /containers/${handle.containerId}`);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(remove).toBeGreaterThan(stop);
  });

  it('stops the container even when the shim already exited', async () => {
    const handle = await created();
    const container = daemon.containers.get(handle.containerId);
    if (container !== undefined) {
      container.state = 'exited';
    }
    await provider.destroy(handle);
    const stopped = daemon.requests.some(
      (recorded) => recorded.path === `/containers/${handle.containerId}/stop`,
    );
    expect(stopped).toBe(true);
  });

  it('removes the control directory, which holds the run token', async () => {
    const handle = await created();
    await provider.destroy(handle);
    const cleanup = daemon.requests.filter((recorded) => recorded.path === '/containers/create');
    expect(JSON.stringify(cleanup)).toContain(`rm -rf /ctl/${FIXTURE_RUN_ID}`);
  });

  it('removes the control directory with CAP_DAC_OVERRIDE, because the agent owns it', async () => {
    const handle = await created();
    await provider.destroy(handle);
    const ctlrm = daemon.byName(`ctlrm-${FIXTURE_RUN_ID}`);
    // The agent is uid 1000, mounts `<ctl>/<run-id>` read-write and owns it, so it may `chmod 000`
    // the directory or anything it puts inside. Root with `CapDrop: ALL` is an ordinary
    // non-owner: measured against all three of those moves, `chown -R` + `chmod -R` + `rm -rf`
    // with `CAP_CHOWN` exits 1 and the directory survives, while a plain `rm -rf` with
    // `CAP_DAC_OVERRIDE` exits 0 and the volume is empty. Take this capability away and the run
    // token stays on the shared control volume for ever, silently — `#teardown` only logs.
    expect(ctlrm?.body.HostConfig).toMatchObject({ CapDrop: ['ALL'], CapAdd: ['DAC_OVERRIDE'] });
    expect((ctlrm?.body.Cmd ?? []).join('\n')).toBe(`rm -rf /ctl/${FIXTURE_RUN_ID}`);
  });

  /**
   * The negative half of the two capability grants (standing rules 3, 42, 68).
   *
   * A census rather than two assertions: it reads every container this provider created on a
   * whole create-and-destroy, so a helper added later is covered the day it is added (rule 44),
   * and a capability added to *any* of them fails here by name. Measured before it existed:
   * adding `capAdd: ['DAC_OVERRIDE']` to the clone helper left the whole unit tier green.
   */
  it('grants a capability to exactly two helpers and none to any other container', async () => {
    const handle = await created();
    await provider.destroy(handle);
    const granted = daemon.history
      .map((container) => [container.name, container.body.HostConfig?.CapAdd ?? []] as const)
      .filter(([, capabilities]) => capabilities.length > 0);
    expect(Object.fromEntries(granted)).toEqual({
      // `chown` needs it even as root, and the shim must find the directory owned by its own uid.
      [`prep-${FIXTURE_RUN_ID}`]: ['CHOWN'],
      // The agent owns what this one has to delete.
      [`ctlrm-${FIXTURE_RUN_ID}`]: ['DAC_OVERRIDE'],
    });
    expect(daemon.history.length).toBeGreaterThan(granted.length);
    for (const container of daemon.history) {
      expect(container.body.HostConfig?.CapDrop ?? ['ALL']).toEqual(['ALL']);
    }
  });

  it('keeps the workspace volume, because retention owns it', async () => {
    const handle = await created();
    await provider.destroy(handle);
    expect(daemon.volumes.has(handle.volumeName)).toBe(true);
    expect([...daemon.networks.values()].filter((entry) => entry.name.startsWith('run-'))).toEqual(
      [],
    );
  });
});

describe('export', () => {
  it('writes a filtered tarball and reports the branch it pushed', async () => {
    await daemon.stop();
    await startDaemon(() => ({ exitCode: 0, logs: 'SHA=abc1234def\nPUSHED=yes\n' }));
    const handle = await created();
    archives.set(`export-${FIXTURE_RUN_ID}:/work/export.tar`, exportArchive());
    const target = path.join(workDir, 'exports', 'run.tar');
    const result = await provider.export(
      handle,
      { branch: 'agentic/task-1', tarballPath: target, commitMessage: 'wip: take-over' },
      { host: 'git.example.com', username: 'agentic', password: SECRET },
    );
    expect(result).toMatchObject({
      branch: 'agentic/task-1',
      pushed: true,
      commitSha: 'abc1234def',
      droppedLinks: 1,
    });
    const written = await readFile(target);
    // The claim "the export contains the workspace" is a claim, so it is read back.
    expect(parseTar(written).map((entry) => entry.name)).toEqual(['repo/', 'repo/README.md']);
    expect(result.tarballBytes).toBe(written.length);
  });

  it('excludes .git and node_modules in the helper that builds the archive', async () => {
    await daemon.stop();
    await startDaemon(() => ({ exitCode: 0, logs: 'SHA=abc\nPUSHED=no\n' }));
    const handle = await created();
    archives.set(`export-${FIXTURE_RUN_ID}:/work/export.tar`, exportArchive());
    await provider.export(
      handle,
      {
        branch: 'agentic/task-1',
        tarballPath: path.join(workDir, 'out.tar'),
        commitMessage: 'wip:',
      },
      null,
    );
    const helper = daemon.requests
      .filter((recorded) => recorded.path === '/containers/create')
      .map((recorded) => JSON.stringify(recorded.body))
      .join('\n');
    expect(helper).toContain('--exclude=.git');
    expect(helper).toContain('--exclude=node_modules');
  });

  it('pushes nothing and needs no network when there is no credential', async () => {
    await daemon.stop();
    await startDaemon(() => ({ exitCode: 0, logs: 'SHA=abc\nPUSHED=no\n' }));
    const handle = await created();
    const result = await provider.export(
      handle,
      { branch: 'agentic/task-1', tarballPath: null, commitMessage: 'wip:' },
      null,
    );
    expect(result.pushed).toBe(false);
    expect(daemon.byName(`export-${FIXTURE_RUN_ID}`)?.body.HostConfig?.NetworkMode).toBe('none');
  });

  it('refuses an archive whose shape is not the single file it asked for', async () => {
    await daemon.stop();
    await startDaemon(() => ({ exitCode: 0, logs: 'SHA=abc\nPUSHED=no\n' }));
    const handle = await created();
    archives.set(
      `export-${FIXTURE_RUN_ID}:/work/export.tar`,
      writeTar([
        { name: 'export.tar', type: 'file', content: 'a' },
        { name: 'surprise', type: 'file', content: 'b' },
      ]),
    );
    await expect(
      provider.export(
        handle,
        { branch: 'agentic/x', tarballPath: path.join(workDir, 'out.tar'), commitMessage: 'wip:' },
        null,
      ),
    ).rejects.toThrow(/unexpected shape/);
  });
});

describe('retention', () => {
  const expired = '2020-01-01T00:00:00.000Z';

  it('removes an expired volume and keeps a live one', async () => {
    const handle = await created();
    await provider.destroy(handle);
    daemon.volumes.set('ws-old', {
      [WORKSPACE_LABELS.run]: '11111111-2222-4333-8444-555555555555',
      [WORKSPACE_LABELS.role]: 'workspace',
      [WORKSPACE_LABELS.keepUntil]: expired,
    });
    const report = await provider.purgeExpired(new Date('2026-09-10T12:00:00.000Z'));
    expect(report.removed).toBe(1);
    expect(daemon.volumes.has('ws-old')).toBe(false);
    expect(daemon.volumes.has(handle.volumeName)).toBe(true);
  });

  it('keeps an expired volume whose run still has a container', async () => {
    const handle = await created();
    daemon.volumes.set(handle.volumeName, {
      [WORKSPACE_LABELS.run]: FIXTURE_RUN_ID,
      [WORKSPACE_LABELS.role]: 'workspace',
      [WORKSPACE_LABELS.keepUntil]: expired,
    });
    const report = await provider.purgeExpired(new Date());
    expect(report.volumes).toContainEqual(
      expect.objectContaining({ volumeName: handle.volumeName, keptReason: 'in_use' }),
    );
    expect(daemon.volumes.has(handle.volumeName)).toBe(true);
  });

  it('looks only at volumes it labelled as workspaces', async () => {
    daemon.volumes.set('someone-elses-data', {});
    const report = await provider.purgeExpired(new Date());
    expect(report.volumes.some((entry) => entry.volumeName === 'someone-elses-data')).toBe(false);
    expect(daemon.volumes.has('someone-elses-data')).toBe(true);
  });
});

describe('mirror', () => {
  it('clones once and updates afterwards, with gc disabled', async () => {
    const spec = workspaceSpecFixture();
    await provider.updateMirror({ projectId: spec.projectId, repo: spec.repo, credential: null });
    const script = JSON.stringify(
      daemon.requests.find((recorded) => recorded.path === '/containers/create')?.body ?? {},
    );
    expect(script).toContain('remote update --prune');
    expect(script).toContain('gc.auto 0');
  });

  it('never puts the credential in the remote URL', async () => {
    const spec = workspaceSpecFixture();
    await provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: { host: 'git.example.com', username: 'agentic', password: SECRET },
    });
    const body = JSON.stringify(
      daemon.requests.find((recorded) => recorded.path === '/containers/create')?.body ?? {},
    );
    // A URL carrying a password is echoed by git into error messages and written into
    // `.git/config`; a credential helper reading two variables is in neither.
    expect(body).not.toContain(`${SECRET}@`);
    expect(body).toContain('credential.helper');
  });

  it('serialises two updates of the same mirror', async () => {
    const spec = workspaceSpecFixture();
    // Two fetches into one directory race; the second create would also collide on the helper
    // name. Both are the same defect and this is the assertion that neither happens.
    await Promise.all([
      provider.updateMirror({ projectId: spec.projectId, repo: spec.repo, credential: null }),
      provider.updateMirror({ projectId: spec.projectId, repo: spec.repo, credential: null }),
    ]);
    expect(
      daemon.requests.filter((recorded) => recorded.path === '/containers/create'),
    ).toHaveLength(2);
  });
});
