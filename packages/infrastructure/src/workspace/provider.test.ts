import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import path from 'node:path';
import { WORKSPACE_LABELS, type WorkspaceHandle } from '@platform/application';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DockerEngine } from './engine.js';
import {
  FIXTURE_RUN_ID,
  SKILL_CATALOGUE_FIXTURE,
  shortTempDir,
  workspaceSpecFixture,
} from './fixtures.js';
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
/** Control sockets this file opened, closed in `afterEach` so no listener outlives its case. */
const listeners: Server[] = [];

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

/**
 * The same provider with a different control-socket bound.
 *
 * A seam, not a knob: the shipped bound is 30 s, and a test that waited it out would be asserting the
 * hardware (standing rule 2). Nothing in production passes it.
 */
const providerWithSocketTimeout = (controlSocketTimeoutMs: number): DockerWorkspaceProvider =>
  new DockerWorkspaceProvider({
    engine: new DockerEngine({ socketPath: daemon.socketPath }),
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
    skills: SKILL_CATALOGUE_FIXTURE,
    mintToken: () => TOKEN,
    now: () => new Date('2026-09-10T12:00:00.000Z'),
    controlSocketTimeoutMs,
  });

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
    skills: SKILL_CATALOGUE_FIXTURE,
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
  for (const server of listeners.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  await rm(workDir, { recursive: true, force: true });
});

/**
 * Everything the *shim* does on the control volume, which in this tier is a real directory: write the
 * token (the prepare helper's job) and **listen** on the socket.
 *
 * The socket is real rather than a plain file: `attach` waits for one since WP-15g, and it asks
 * `stat().isSocket()` — a `writeFile` would pass a check for existence and not this one, which is the
 * difference between "the shim has booted" and "something made a file". Measured: without it, `attach`
 * waits out its whole timeout.
 */
const created = async (): Promise<WorkspaceHandle> => {
  const spec = workspaceSpecFixture();
  const handle = await provider.create(spec);
  await mkdir(path.join(controlRoot, spec.runId), { recursive: true });
  await writeFile(path.join(controlRoot, spec.runId, 'token'), `${TOKEN}\n`);
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(path.join(controlRoot, spec.runId, 'ctl.sock'), resolve);
  });
  listeners.push(server);
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

  /**
   * WP-14a: the skills the spec names, written **after** the clone (`git clone` refuses a target
   * that already has content) and inside the checkout, where the CLI resolves a relative plugin
   * path against its `cwd`.
   *
   * What this asserts is the argument vector the provider sends — a string this repository wrote
   * (standing rule 3). That the files are then in a real container's filesystem, and that the
   * project's own `.claude/skills` survives, is `docker-workspace.e2e.test.ts`.
   */
  it('writes the spec’s platform skills into the workspace, as a plugin directory', async () => {
    await provider.create(workspaceSpecFixture());
    const skills = daemon.byName(`skills-${FIXTURE_RUN_ID}`);
    const script = (skills?.body.Cmd ?? []).join('\n');
    expect(script).toContain('/work/repo/.agentic-run/plugins/agentic/skills/ask-human/SKILL.md');
    expect(script).toContain('/work/repo/.agentic-run/plugins/agentic/skills/kb/SKILL.md');
    // Nothing is written inside the project's own `.claude/`.
    expect(script).not.toContain('.claude/skills');
    const env = skills?.body.Env ?? [];
    expect(env.join('\n')).toContain('fixture kb body');
    expect(skills?.body.User).toBe('1000:1000');
    expect(skills?.body.HostConfig?.NetworkMode).toBe('none');
  });

  it('excludes the platform’s directory from the checkout, locally to the clone', async () => {
    await provider.create(workspaceSpecFixture());
    const script = (daemon.byName(`skills-${FIXTURE_RUN_ID}`)?.body.Cmd ?? []).join('\n');
    // `.git/info/exclude`, never `.gitignore`: the second is a file of the project's, and the
    // Developer role's `git add -A` would otherwise sweep the platform's directory into the MR.
    expect(script).toContain('/work/repo/.git/info/exclude');
    expect(script).toContain("'/.agentic-run/'");
    expect(script).not.toContain('.gitignore');
  });

  it('starts no helper at all for a role with no skills', async () => {
    await provider.create(workspaceSpecFixture({ skills: [] }));
    expect(daemon.byName(`skills-${FIXTURE_RUN_ID}`)).toBeUndefined();
  });

  it('refuses a spec naming a skill this deployment does not ship, before the run starts', async () => {
    await expect(
      provider.create(workspaceSpecFixture({ skills: ['not-a-shipped-skill'] })),
    ).rejects.toMatchObject({ code: 'invalid_spec' });
    // `create`'s own teardown: either a handle or nothing.
    expect(daemon.containers.get(`ws-${FIXTURE_RUN_ID}`)?.state).not.toBe('running');
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

  /**
   * PROGRESS backlog 7's third obligation, as a behaviour rather than as a knob.
   *
   * The launcher has `APP_WORKSPACE_EGRESS_IMAGE` and no companion for a *command*, because in
   * production `platform-egress`'s entrypoint is tinyproxy. Point that variable at a stand-in with
   * no long-lived process and the sidecar exits the moment it starts; the run then succeeds at
   * everything that needs no network and fails on the agent's first fetch, with nothing saying why,
   * because `HTTPS_PROXY` names the container that just died.
   *
   * Both directions, because an assertion that a create fails proves nothing about *which* create
   * (standing rule 42): the sidecar that stays up is the happy path every other case here exercises,
   * and this one differs from it in exactly one fact the daemon reports.
   */
  it('refuses the run when the egress sidecar exited as soon as it started', async () => {
    await daemon.stop();
    await startDaemon((container) =>
      container.name.startsWith('egress-')
        ? { exitCode: 3, logs: 'tinyproxy: could not read config file\n', exited: true }
        : { exitCode: 0, logs: '' },
    );
    const failure = await provider
      .create(workspaceSpecFixture())
      .then(() => null)
      .catch((error: unknown) => error as { code: string; message: string; detail: string | null });
    expect(failure?.code).toBe('workspace_failed');
    expect(failure?.message).toContain('egress sidecar is exited (exit 3)');
    // The image is named, because the operator who mis-set the variable is reading this line.
    expect(failure?.message).toContain('tinyproxy:test');
    expect(failure?.detail).toContain('could not read config file');
    // And `create` is still all-or-nothing: the run container it had already started is gone.
    expect(daemon.created.filter((container) => container.state === 'running')).toEqual([]);
    expect(daemon.created.map((container) => container.name)).toEqual([]);
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

  /**
   * **The half the timeout case cannot state** (standing rule 42, found by WP-15g's review round 1):
   * that the wait *waits*.
   *
   * Every other success case here opens the socket **before** `attach` is called, so shortening the
   * loop to a single look — `const deadline = Date.now() - 1`, behaviourally the pre-WP-15g code —
   * left `provider.test.ts` at 37/37. Only the timeout direction was asserted, on the very branch
   * whose absence was the live defect. So here the shim boots **late**, which is what it really does:
   * `create` returns when the container has *started* and the shim inside it then has to boot Node and
   * `listen()`.
   *
   * The numbers, because one of them is wall-clock: the socket appears after 120 ms against a 2 s
   * bound polled every 50 ms — a 16x margin, and the assertion is that `attach` **resolves**, never how
   * long it took (standing rule 2). Measured on this machine at load 6: the resolve lands in ~150 ms.
   */
  it('waits for a shim that starts listening after attach was called', async () => {
    provider = providerWithSocketTimeout(2_000);
    const spec = workspaceSpecFixture();
    const handle = await provider.create(spec);
    await mkdir(path.join(controlRoot, spec.runId), { recursive: true });
    await writeFile(path.join(controlRoot, spec.runId, 'token'), `${TOKEN}\n`);
    const socketPath = path.join(controlRoot, spec.runId, 'ctl.sock');

    const server = createServer();
    listeners.push(server);
    const listening = new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      setTimeout(() => server.listen(socketPath, resolve), 120);
    });

    const attachment = await provider.attach(handle);
    await listening;
    expect(attachment).toEqual({ socketPath, token: TOKEN, workdir: '/work/repo' });
  });

  /**
   * The other side of the same boundary: a shim that never listens is reported rather than waited on
   * for ever.
   *
   * `workspace_failed` rather than `not_found`, because `classifyProvisionFailure` reads the code and
   * a shim that is slow to boot is the **retryable** case — Q59(a)'s bounded start retry is what
   * absorbs it, which is also why the defect this wait closes costs one failed `runs` row and 30 s per
   * task rather than a lost task.
   */
  it('waits for the shim’s control socket and reports a shim that never listened', async () => {
    provider = providerWithSocketTimeout(50);
    const spec = workspaceSpecFixture();
    const handle = await provider.create(spec);
    await mkdir(path.join(controlRoot, spec.runId), { recursive: true });
    await writeFile(path.join(controlRoot, spec.runId, 'token'), `${TOKEN}\n`);
    // A plain file at the socket's path is not a socket, and the check asks which it is.
    await writeFile(path.join(controlRoot, spec.runId, 'ctl.sock'), '');
    await expect(provider.attach(handle)).rejects.toMatchObject({
      code: 'workspace_failed',
      detail: path.join(controlRoot, spec.runId, 'ctl.sock'),
    });
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

  it('reclaims the control directory with no capability, by using the uid that owns it', async () => {
    const handle = await created();
    await provider.destroy(handle);
    const empty = daemon.byName(`ctlempty-${FIXTURE_RUN_ID}`);
    const remove = daemon.byName(`ctlrm-${FIXTURE_RUN_ID}`);
    // The agent may `chmod 000` its own directory and anything in it, and root with `CapDrop: ALL`
    // is an ordinary non-owner — it cannot descend, cannot `chmod`, cannot even `chown -R`. The
    // way out is the uid, not a capability: everything under the directory is owned by 1000 and
    // the agent has no `CAP_CHOWN` to change that, so uid 1000 is the owner of every mode it can
    // set. Measured on a named volume *and* on a bind-backed one, benign / locked / already gone:
    // rc 0 and the volume empty in all six.
    expect(empty?.body.User).toBe('1000:1000');
    expect(remove?.body.User).toBe('0:0');
    const unlock = (empty?.body.Cmd ?? []).join('\n');
    expect(unlock).toContain(`chmod -R u+rwX /ctl/${FIXTURE_RUN_ID}`);
    // Load-bearing, and the step the first draft of this left out: uid 0 cannot look inside a
    // `0700` directory it does not own, so step 2 exits 1 on a named volume without this line.
    expect(unlock).toContain(`chmod 755 /ctl/${FIXTURE_RUN_ID}`);
    // **One argument, never a list.** The first draft deleted with `rm -rf $dir/*`, and an agent
    // defeated reclamation by making the argument list too long: measured, 8 000 files of
    // 240-character names gave `rm: Argument list too long`, exit **0**, and the token still on
    // the shared volume. `find … -exec rm -rf {} +` was the obvious repair and is also wrong —
    // `find` reads the directory while `rm` empties it and 3 944 of 8 002 entries survived, with
    // no error from either program. `rm -rf $dir` is one argument and one walker; it is expected
    // to fail on its last act, unlinking the directory itself, which is step 2's job.
    expect(unlock).toContain(`rm -rf /ctl/${FIXTURE_RUN_ID}\n`);
    expect(unlock).not.toMatch(/rm -rf \S*\*/);
    expect(unlock).not.toContain('find ');
    // And it retries, because a single pass is not enough either: deleting invalidates the
    // directory cursor the walk is reading, so `find -exec` left 3 944 of 8 002 entries and a bare
    // `rm -rf $dir` left 3 991, neither reporting an error. Bounded, so a pathological directory
    // fails the step instead of looping: 8 passes were needed on a bind-backed volume, 1 on a
    // named one.
    expect(unlock).toContain('while [ -e ');
    expect(unlock).toContain('if [ $n -gt 20 ]; then break; fi');
    // **And the emptiness test is the verdict, not `exit 0`.** `rm -rf $dir` always ends non-zero
    // here by design, and busybox `find -exec … +` does not propagate a failing `rm` either, so
    // and `#helper` throws on a non-zero exit, which is what keeps step 2 from running against a
    // directory step 1 did not empty (standing rule 67: a step that cannot fail has a failure
    // branch nobody executes).
    expect(unlock).toContain(`test -z "$(ls -A /ctl/${FIXTURE_RUN_ID} | head -c 1)"`);
    expect(unlock.trimEnd().endsWith('fi')).toBe(true);
    expect((remove?.body.Cmd ?? []).join('\n')).toBe(`rm -rf /ctl/${FIXTURE_RUN_ID}`);
  });

  /**
   * The negative half: **one** capability is granted anywhere in this provider, and it is `CHOWN`
   * on the prepare helper (standing rules 3, 42, 68).
   *
   * Two things this census got wrong on its first draft, both found by review and both fixed by
   * asking the daemon a different question:
   *
   *  - it read `CapDrop` as `body.HostConfig?.CapDrop ?? ['ALL']`, so a container that emitted **no
   *    `CapDrop` at all** — Docker's full default capability set, the worst case the check exists
   *    to catch — passed. An absent value read as the safe one is standing rule 18 inside a
   *    security check. It is now read as emitted, and `undefined` fails;
   *  - its docblock claimed "a helper added later is covered the day it is added", and that was
   *    false: it drove one create-and-destroy, while `export` and `updateMirror` create helpers on
   *    paths that sequence never takes. Measured: `capAdd: ['SYS_ADMIN']` on the export helper left
   *    all 171 workspace unit tests green. Every method that creates a container is driven below,
   *    and the names are asserted — so the *scope* of this census is itself checkable (rule 44) and
   *    a new helper on a covered path lands in `history` and must be declared here.
   */
  it('grants exactly one capability across every container it creates, on any path', async () => {
    await daemon.stop();
    await startDaemon(() => ({ exitCode: 0, logs: 'SHA=abc1234def\nPUSHED=yes\n' }));
    const spec = workspaceSpecFixture();
    await provider.updateMirror({ projectId: spec.projectId, repo: spec.repo, credential: null });
    const handle = await created();
    archives.set(`export-${FIXTURE_RUN_ID}:/work/export.tar`, exportArchive());
    await provider.export(
      handle,
      {
        branch: 'agentic/task-1',
        tarballPath: path.join(workDir, 'census.tar'),
        commitMessage: 'wip',
      },
      { host: 'git.example.com', username: 'agentic', password: SECRET },
    );
    await provider.destroy(handle);

    const granted = daemon.history
      .map((container) => [container.name, container.body.HostConfig?.CapAdd ?? []] as const)
      .filter(([, capabilities]) => capabilities.length > 0);
    expect(Object.fromEntries(granted)).toEqual({
      // `chown` needs it even as root, and the shim must find the directory owned by its own uid.
      [`prep-${FIXTURE_RUN_ID}`]: ['CHOWN'],
    });

    // Read as emitted. `toEqual(['ALL'])` on a missing field fails, which is the point: no
    // `CapDrop` is the full default set, not the empty one.
    for (const container of daemon.history) {
      expect(container.body.HostConfig?.CapDrop).toEqual(['ALL']);
    }

    // And the scope claim, checkable: these are the container-creating paths this provider has.
    const roles = new Set(daemon.history.map((container) => container.name.split('-')[0]));
    expect([...roles].sort()).toEqual([
      'clone',
      'ctlempty',
      'ctlrm',
      'egress',
      // The sidecar's config volume is written by its own helper. It was not in the first draft
      // of this list and the census named it on the first run, which is the check working.
      'egresscfg',
      'export',
      'mirror',
      'prep',
      // WP-14a's skills copy, which this census named on its first run — the check working a
      // second time.
      'skills',
      'ws',
    ]);
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
