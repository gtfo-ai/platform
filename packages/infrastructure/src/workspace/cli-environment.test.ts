/**
 * WP-118 (TD-025's amendment, PROGRESS backlog 342): the container facts the `claude` process needs
 * in its own environment, answered by the launcher from **the same function** that writes the run
 * container's environment.
 *
 * Measured before the fix (the WP-118 notes): none of `HTTPS_PROXY`, `HTTP_PROXY`, `NO_PROXY`,
 * `HOME`, `CLAUDE_CONFIG_DIR`, `PATH` or the credential helper's `GIT_CONFIG_*` reached the CLI,
 * because the shim replaces its child's environment with the spawn frame's. What is asserted here is
 * the launcher half: the answer exists, it agrees with the container, `PATH` is the image's own, and
 * nothing in it is a secret. The daemon half is `scripts/launcher-control-plane-check.mjs`, and the
 * runner half is this one:
 * `packages/infrastructure/src/runner/options.test.ts` › "cliEnvironment (WP-118)".
 */
import { mkdir, realpath, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { type WorkspaceCliEnvironment, WorkspaceError } from '@platform/application';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectSecrets } from '../redaction/pattern-redaction.js';
import { cliEnvironmentVariables, numberGitConfig } from './cli-environment.js';
import { DockerEngine } from './engine.js';
import { FakeWorkspaceProvider } from './fake.js';
import { SKILL_CATALOGUE_FIXTURE, shortTempDir, workspaceSpecFixture } from './fixtures.js';
import { DockerWorkspaceProvider } from './provider.js';
import { FAKE_IMAGE_PATH, FakeDockerDaemon } from './testing.js';

const RUNTIME = 'platform-runtime:test';

let daemon: FakeDockerDaemon;
let workDir: string;
let controlRoot: string;

const providerOn = async (
  imageEnv: ReadonlyMap<string, readonly string[] | null> = new Map(),
  runtimeSourceDir: string | null = null,
): Promise<DockerWorkspaceProvider> => {
  daemon = new FakeDockerDaemon({ imageEnv });
  const socketPath = await daemon.start();
  daemon.seedSubpath('repo-cache', 'acme.git');
  daemon.networks.set('net-platform', { name: 'platform', internal: false });
  return new DockerWorkspaceProvider({
    engine: new DockerEngine({ socketPath }),
    images: { runtime: RUNTIME, egress: 'tinyproxy:test', git: 'git:test', runtimeSourceDir },
    controlVolume: 'ctl',
    controlRoot,
    cacheVolume: 'repo-cache',
    helperNetwork: 'platform',
    egressNetwork: 'platform',
    runnerUid: 1000,
    skills: SKILL_CATALOGUE_FIXTURE,
    mintToken: () => 'a'.repeat(32),
    now: () => new Date('2026-09-10T12:00:00.000Z'),
  });
};

/** The run container's `Env`, as the daemon was sent it, as a record. */
const containerEnv = (containerId: string): Record<string, string> =>
  Object.fromEntries(
    (daemon.containers.get(containerId)?.body.Env ?? []).map((entry) => [
      entry.slice(0, entry.indexOf('=')),
      entry.slice(entry.indexOf('=') + 1),
    ]),
  );

/** Every string value of an answer, for the TD-012 detector. */
const valuesOf = (answer: WorkspaceCliEnvironment): string[] => [
  ...(answer.proxy === null ? [] : [answer.proxy.url, answer.proxy.noProxy]),
  answer.home,
  answer.claudeConfigDir,
  answer.path,
  ...answer.gitConfig.flatMap((entry) => [entry.key, entry.value]),
];

beforeEach(async () => {
  workDir = await shortTempDir('agentic-wp118-');
  controlRoot = path.join(workDir, 'ctl');
  await mkdir(controlRoot, { recursive: true });
});

afterEach(async () => {
  await daemon?.stop();
  await rm(workDir, { recursive: true, force: true });
});

describe('the launcher’s answer and the run container’s environment come from one function (WP-118)', () => {
  it('writes every answered value onto the container, name for name and value for value', async () => {
    const provider = await providerOn();
    const handle = await provider.create(workspaceSpecFixture());
    const answer = await provider.cliEnvironment(handle);
    const env = containerEnv(handle.containerId);
    const rendered = { ...cliEnvironmentVariables(answer), ...numberGitConfig(answer.gitConfig) };
    // The canary for "one side edited": a value changed on the container alone, or on the answer
    // alone, is a key whose two values differ here (both directions were mutated; WP-118 notes).
    for (const [name, value] of Object.entries(rendered)) {
      expect(env[name], name).toBe(value);
    }
    expect(answer.proxy?.url).toBe(`http://egress-${handle.runId}:8888`);
    expect(env['HTTPS_PROXY']).toBe(answer.proxy?.url);
    expect(answer.gitConfig).toEqual([
      { key: 'credential.helper', value: '!agentic-runlet credential --socket /ctl/cred.sock' },
    ]);
  });

  /**
   * WP-118 review round 1: the case above compared only the answered names, so a name added to the
   * container alone — backlog 342's mechanism coming back — survived it (a reviewer's `LANG` canary
   * did). The container's names are therefore held **exactly** to a stated partition: the project's
   * `spec.env`, the answer, and the container's own — the shim's five `RUNLET_*` coordinates, which
   * must never reach the CLI, and the opt-out copy kept for a `docker exec`. A name outside it fails
   * by name, and so does a name of it that went missing.
   */
  it('writes exactly the project’s names, the answer’s and the shim’s own onto the container', async () => {
    const provider = await providerOn();
    const spec = workspaceSpecFixture({ env: { CI: 'true', NODE_ENV: 'test' } });
    const handle = await provider.create(spec);
    const answer = await provider.cliEnvironment(handle);
    const containerOnly = [
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC',
      'RUNLET_CHILD_GID',
      'RUNLET_CHILD_UID',
      'RUNLET_CONTROL_SOCKET',
      'RUNLET_CREDENTIAL_SOCKET',
      'RUNLET_TOKEN_FILE',
    ];
    const expected = [
      ...Object.keys(spec.env),
      ...Object.keys(cliEnvironmentVariables(answer)),
      ...Object.keys(numberGitConfig(answer.gitConfig)),
      ...containerOnly,
    ].sort();
    expect(Object.keys(containerEnv(handle.containerId)).sort()).toEqual(expected);
  });

  it('answers no proxy for a run with no sidecar, and the container has none either', async () => {
    const provider = await providerOn();
    const handle = await provider.create(
      workspaceSpecFixture({ egress: { hosts: [], connectPorts: [443] } }),
    );
    const answer = await provider.cliEnvironment(handle);
    expect(answer.proxy).toBeNull();
    expect(
      Object.keys(containerEnv(handle.containerId)).filter((n) => n.endsWith('PROXY')),
    ).toEqual([]);
  });

  it('answers the same values from the handle alone, as a restarted launcher would', async () => {
    const first = await providerOn();
    const handle = await first.create(workspaceSpecFixture());
    const answered = await first.cliEnvironment(handle);
    await daemon.stop();
    const restarted = await providerOn();
    expect(await restarted.cliEnvironment(handle)).toEqual(answered);
  });
});

describe('PATH is the run image’s own declared value (WP-118)', () => {
  it('reads it off the image’s Config.Env where the CLI path is verified', async () => {
    const provider = await providerOn(
      new Map([[RUNTIME, ['NODE_VERSION=24', 'PATH=/opt/tools/bin:/usr/bin:/bin']]]),
    );
    const handle = await provider.create(workspaceSpecFixture());
    expect((await provider.cliEnvironment(handle)).path).toBe('/opt/tools/bin:/usr/bin:/bin');
    expect(containerEnv(handle.containerId)['PATH']).toBe('/opt/tools/bin:/usr/bin:/bin');
    // Asked of the image by name, once per process — beside `test -x`, not per run.
    await provider.create(workspaceSpecFixture({ runId: 'aaaaaaaa-1111-4111-8111-111111111111' }));
    const inspects = daemon.requests.filter(
      (request) => request.method === 'GET' && request.path.startsWith('/images/'),
    );
    expect(inspects.map((request) => request.path)).toEqual([
      `/images/${encodeURIComponent(RUNTIME)}/json`,
    ]);
  });

  it('is the Debian/node value when the image declares that', async () => {
    const provider = await providerOn();
    const handle = await provider.create(workspaceSpecFixture());
    expect((await provider.cliEnvironment(handle)).path).toBe(FAKE_IMAGE_PATH);
  });

  it('refuses an image that declares no PATH, as invalid_spec naming the image, before any run exists', async () => {
    for (const env of [null, ['NODE_VERSION=24']]) {
      const provider = await providerOn(new Map([[RUNTIME, env]]));
      const attempt = provider.create(workspaceSpecFixture());
      await expect(attempt).rejects.toBeInstanceOf(WorkspaceError);
      await expect(provider.create(workspaceSpecFixture())).rejects.toMatchObject({
        code: 'invalid_spec',
        message: expect.stringContaining(`the run image ${RUNTIME} declares no PATH`),
      });
      expect(daemon.volumes.has(`ws-${workspaceSpecFixture().runId}`)).toBe(false);
      await daemon.stop();
    }
  });

  it('refuses a PATH that is not a list of absolute directories', async () => {
    const provider = await providerOn(new Map([[RUNTIME, ['PATH=bin:/usr/bin']]]));
    await expect(provider.create(workspaceSpecFixture())).rejects.toMatchObject({
      code: 'invalid_spec',
      message: expect.stringContaining('not a list of absolute directories'),
    });
  });
});

describe('no secret is added to the spawn frame (WP-118, TD-012)', () => {
  it('finds no secret shape in any value the launcher answers, with or without a source mount', async () => {
    const answers: WorkspaceCliEnvironment[] = [];
    // A development source mount, as `hardening.ts` accepts one: a real path (macOS's temporary
    // directory is a symlink) holding the repository's workspace marker.
    const sourceMount = path.join(await realpath(workDir), 'src');
    await mkdir(sourceMount);
    await writeFile(path.join(sourceMount, 'pnpm-workspace.yaml'), 'packages: []\n');
    for (const sourceDir of [null, sourceMount]) {
      const provider = await providerOn(new Map(), sourceDir);
      const handle = await provider.create(workspaceSpecFixture());
      answers.push(await provider.cliEnvironment(handle));
      await daemon.stop();
    }
    const fake = new FakeWorkspaceProvider({ controlRoot, skills: SKILL_CATALOGUE_FIXTURE });
    await fake.updateMirror({
      projectId: workspaceSpecFixture().projectId,
      repo: workspaceSpecFixture().repo as NonNullable<
        ReturnType<typeof workspaceSpecFixture>['repo']
      >,
      credential: null,
    });
    answers.push(await fake.cliEnvironment(await fake.create(workspaceSpecFixture())));
    for (const answer of answers) {
      for (const value of valuesOf(answer)) {
        expect(detectSecrets(value), value).toEqual([]);
      }
    }
    // The source-mounted helper command is the only value that varies with configuration.
    expect(answers[1]?.gitConfig[0]?.value).toContain('apps/runlet/src/index.ts credential');
  });
});

describe('numberGitConfig', () => {
  it('numbers from 0, contiguously, with the count equal to the length', () => {
    expect(
      numberGitConfig([
        { key: 'credential.helper', value: 'h' },
        { key: 'core.fsmonitor', value: 'false' },
      ]),
    ).toEqual({
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'credential.helper',
      GIT_CONFIG_VALUE_0: 'h',
      GIT_CONFIG_KEY_1: 'core.fsmonitor',
      GIT_CONFIG_VALUE_1: 'false',
    });
    expect(numberGitConfig([])).toEqual({ GIT_CONFIG_COUNT: '0' });
  });

  it('refuses a key given twice, by name, folding case as git does', () => {
    expect(() =>
      numberGitConfig([
        { key: 'core.fsmonitor', value: 'false' },
        { key: 'CORE.fsmonitor', value: 'true' },
      ]),
    ).toThrow(/CORE\.fsmonitor is given twice/);
  });
});
