/**
 * The workspace e2e against a real daemon, its git half: mount escapes, the export, one project's
 * mirror (WP-75) and a minted run credential against a credentialled git server (WP-76).
 *
 * Moved whole out of `docker-workspace.e2e.test.ts` (BACKLOG 1654), whose docblock carries what the
 * three files are built around — every flag read back from the daemon, every property attempted —
 * and which images they run; `test/e2e/support/docker-workspace-suite.ts` is the fixture they
 * share and says why they may run at once.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import {
  allowAnyIntegrationHost,
  type CredentialRevocationAddress,
  createIntegrationActionExecutor,
  createMemoryAuditLog,
  createVirtualTimer,
  type GitProviderPort,
  type MintedCredential,
  noSecretsRedactor,
  runCredentialHandle,
  runCredentialRevocations,
  runCredentialWrites,
} from '@platform/application';
import type { Id } from '@platform/contracts';
import { fixedClock } from '@platform/domain';
import { workspace } from '@platform/infrastructure';
import { createFakeGitProvider } from '@platform/integrations';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ALPINE_IMAGE,
  type CredentialedGitServer,
  type DockerFixture,
  docker,
  exportPath,
  GIT_IMAGE,
  plantInWorkspace,
  probeUnderRunContainerConfig,
  REPO_ROOT,
  RUNTIME_IMAGE,
  startCredentialedGitServer,
} from '../support/docker-workspace.js';
import { shipped, useDockerFixture } from '../support/docker-workspace-suite.js';
import { harnessProbe } from '../support/harness-volumes.js';

let fixture: DockerFixture;
const { specFor, startRun } = useDockerFixture((started) => {
  fixture = started;
});

describe('mount escapes', () => {
  it('refuses a run id that could name another directory', async () => {
    for (const runId of [
      '../other-run',
      '..%2fother-run',
      `${randomUUID()}/../other`,
      `${randomUUID()}\0../other`,
    ]) {
      await expect(fixture.provider.create(...shipped(specFor({ runId })))).rejects.toMatchObject({
        code: 'invalid_spec',
      });
    }
  });

  it('refuses a bind source that is a symlink, because the daemon would follow it', async () => {
    const dir = await workspace.shortTempDir('agentic-e2e-link-');
    try {
      const link = path.join(dir, 'repo');
      await symlink('/', link);
      expect(() => workspace.assertSafeBindSource(link)).toThrow(/is a symlink/);
      // And the guard is not merely refusing everything: the real repository passes.
      expect(workspace.assertSafeBindSource(REPO_ROOT)).toBe(REPO_ROOT);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  /**
   * The measurement that replaced the deny-list (`hardening.ts` § "Why an allow-condition").
   *
   * On this machine `/var/run/docker.sock` is a symlink into `$HOME`, so passing *it* would be
   * refused by the symlink branch and prove nothing about the branch under test; the daemon
   * resolves a bind source itself, so the realpath is the value that matters and the value the
   * guard must refuse. The round-1 guard accepted it and the daemon recorded the bind.
   */
  it('refuses the docker socket at the realpath the daemon would bind', () => {
    const socket = realpathSync('/var/run/docker.sock');
    expect(() => workspace.assertSafeBindSource(socket)).toThrow(/not a checkout/);
    // Paired with the positive, so a guard that refused everything could not pass (rule 42).
    expect(workspace.assertSafeBindSource(REPO_ROOT)).toBe(REPO_ROOT);
  });

  it('drops a symlink that escapes the workspace from the exported archive', async () => {
    const { handle } = await startRun();
    try {
      await plantInWorkspace(
        fixture,
        handle.volumeName,
        'ln -sf ../../../../etc/passwd /work/repo/escape && ln -sf README.md /work/repo/inside',
      );
      const target = exportPath(fixture, `${handle.runId}.tar`);
      const result = await fixture.provider.export(
        handle,
        { branch: 'agentic/e2e', tarballPath: target, commitMessage: 'wip: e2e' },
        null,
      );
      expect(result.droppedLinks).toBe(1);
      const names = workspace.parseTar(await readFile(target)).map((entry) => entry.name);
      expect(names).toContain('repo/README.md');
      expect(names.some((name) => name.endsWith('/escape'))).toBe(false);
      // The link that stays inside is kept: a filter that dropped every link would pass the
      // assertion above and quietly mangle every repository that uses one.
      expect(names.some((name) => name.endsWith('/inside'))).toBe(true);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);
});

describe('export', () => {
  it('pushes the branch to the fixture repository and writes a tarball without .git', async () => {
    const { handle } = await startRun();
    try {
      await plantInWorkspace(
        fixture,
        handle.volumeName,
        'printf "agent work\\n" > /work/repo/AGENT.md',
      );
      const target = exportPath(fixture, `${handle.runId}-push.tar`);
      const result = await fixture.provider.export(
        handle,
        { branch: 'agentic/e2e-push', tarballPath: target, commitMessage: 'wip: e2e push' },
        { host: fixture.repoContainer, username: 'agentic', password: 'unused-by-git-daemon' },
      );
      expect(result.pushed).toBe(true);
      expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);

      // Read the branch back out of the *fixture repository*, not out of the workspace: "the push
      // landed" is a claim about the remote.
      const refs = await docker([
        'run',
        '--rm',
        ...harnessProbe(),
        '--network',
        fixture.network,
        '--entrypoint',
        'git',
        'alpine/git:v2.49.1',
        'ls-remote',
        fixture.repoUrl,
        'refs/heads/agentic/e2e-push',
      ]);
      expect(refs.stdout).toContain('refs/heads/agentic/e2e-push');

      const names = workspace.parseTar(await readFile(target)).map((entry) => entry.name);
      expect(names).toContain('repo/AGENT.md');
      expect(names.some((name) => name.split('/').includes('.git'))).toBe(false);
      expect(names.some((name) => name.split('/').includes('node_modules'))).toBe(false);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);
});

/**
 * **WP-75 — one project's mirror, not every project's** (PROGRESS backlog 148, TD-021:9's
 * *"per-project bare mirror ro at `/cache`"*).
 *
 * Two projects' mirrors on **one** `repo-cache` volume — `acme` (the run's) and `beta` (another
 * project's, the same remote under a different key: what separates two projects on the volume is
 * the directory, and the directory is what the mount scopes). Every assertion is read off the
 * daemon: the mounts it recorded for the run container and was asked for by the export helper, and
 * what a container under the run container's own recorded `HostConfig` can list and read (standing
 * rule 82). Each negative has the positive that gives it a subject (rule 42): `beta`'s `config` and
 * `packed-refs` **are** readable by uid 1000 through a whole-volume mount — the pre-WP-75 shape — so
 * "refused inside the run" is the scoping, not a mirror that is not there; and the planted hooks
 * **do** fire under a plain `git commit` in the same tree, so "no side effect after the export" is
 * the export disabling them, not a hook that could never run.
 *
 * The cache volume is a **plain named volume** in the daemon's own storage — production's shape,
 * and not the bind-backed shape the control volume has in this file (standing rule 69).
 */
describe('one project’s mirror, not every project’s (WP-75)', () => {
  const OTHER_KEY = 'beta';
  interface MountRecord {
    readonly Type: string;
    readonly Source: string;
    readonly Target: string;
    readonly ReadOnly?: boolean;
    readonly VolumeOptions?: { readonly Subpath?: string };
  }
  const cacheMountsOf = (body: unknown): MountRecord[] =>
    ((body as { HostConfig?: { Mounts?: MountRecord[] } }).HostConfig?.Mounts ?? []).filter(
      (mount) => mount.Source === fixture.cacheVolume,
    );
  const OWN_MIRROR_MOUNT = {
    Type: 'volume',
    Target: '/cache/acme.git',
    ReadOnly: true,
    VolumeOptions: { Subpath: 'acme.git' },
  };

  beforeAll(async () => {
    await fixture.provider.updateMirror({
      projectId: randomUUID(),
      repo: specFor({ repo: { cacheKey: OTHER_KEY } }).repo,
      credential: null,
    });
    // The positive (rule 42): uid 1000, the run's uid, reads the other project's mirror through a
    // mount of the whole volume — which is what the run container had before WP-75.
    const whole = await docker([
      'run',
      '--rm',
      ...harnessProbe(),
      '--network',
      'none',
      '--user',
      '1000:1000',
      '-v',
      `${fixture.cacheVolume}:/cache:ro`,
      ALPINE_IMAGE,
      'sh',
      '-c',
      `ls -A /cache; cat /cache/${OTHER_KEY}.git/config /cache/${OTHER_KEY}.git/packed-refs`,
    ]);
    expect(whole.stdout).toContain(`${OTHER_KEY}.git`);
    expect(whole.stdout).toContain('[remote "origin"]');
    expect(whole.stdout).toContain('refs/heads/main');
  }, 240_000);

  it('mounts the run’s own mirror at the path its alternates name, and no other project’s', async () => {
    const { handle } = await startRun();
    try {
      const inspect = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
        HostConfig: { Mounts: MountRecord[] };
        Mounts: { Destination: string }[];
      };
      const recorded = cacheMountsOf(inspect);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject(OWN_MIRROR_MOUNT);
      expect(inspect.Mounts.map((mount) => mount.Destination).sort()).toEqual([
        '/cache/acme.git',
        '/ctl',
        '/work',
      ]);

      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        [
          'echo "LS=$(ls -A /cache | tr "\\n" " ")"',
          `if cat /cache/${OTHER_KEY}.git/config >/dev/null 2>&1; then echo B_CONFIG=read; else echo B_CONFIG=refused; fi`,
          `if cat /cache/${OTHER_KEY}.git/packed-refs >/dev/null 2>&1; then echo B_REFS=read; else echo B_REFS=refused; fi`,
          'cat /work/repo/.git/objects/info/alternates',
          // Nothing local: every object this clone has, it has through the alternates — so the
          // `log -p` below reads the mirror, not a copy (rule 43).
          'git -C /work/repo count-objects -v | grep -E "^(count|in-pack):"',
          'git -C /work/repo log -1 -p --format=COMMIT=%H HEAD; echo "LOG_EXIT=$?"',
        ].join('\n'),
        { image: RUNTIME_IMAGE },
      );
      expect(probe.output).toContain('LS=acme.git \n');
      expect(probe.output).toContain('B_CONFIG=refused');
      expect(probe.output).toContain('B_REFS=refused');
      expect(probe.output).toContain('/cache/acme.git/objects');
      expect(probe.output).toContain('count: 0');
      expect(probe.output).toContain('in-pack: 0');
      // An object older than the run, decoded through the alternates: the regression the narrowing
      // risks, measured rather than argued.
      expect(probe.output).toMatch(/COMMIT=[0-9a-f]{40}/);
      expect(probe.output).toContain('+# fixture repository');
      expect(probe.output).toContain('LOG_EXIT=0');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  it('refuses a checkout whose mirror was never made by name, before the run container is asked for', async () => {
    const from = fixture.engine.createdNames.length;
    const spec = specFor({ repo: { cacheKey: 'never-mirrored' } });
    await expect(fixture.provider.create(...shipped(spec))).rejects.toMatchObject({
      code: 'workspace_failed',
      message: /no mirror to clone from/,
    });
    // The clone helper is the last container this create asked for before its own teardown
    // (`ctlempty`, `ctlrm` — `create`'s catch): no skills, no sidecar, no run container, so the
    // daemon's sub-path refusal was never reachable (the WP-74 case above asserts the other
    // direction, a repo-ful create that asks for `ws`).
    expect(
      fixture.engine.createdNames
        .slice(from)
        .filter((name) => name.endsWith(`-${spec.runId}`))
        .map((name) => name.slice(0, -`-${spec.runId}`.length)),
    ).toEqual(['prep', 'clone', 'ctlempty', 'ctlrm']);
    // What the check pre-empts, measured on this daemon rather than assumed from the control
    // volume's case: a container mounting a mirror that does not exist by sub-path is refused.
    // Named, and removed below whatever happened: a `run` whose start the daemon refuses can leave
    // the created container behind, and `--rm` only acts on one that started.
    const probe = `agentic-e2e-subpath-${spec.runId}`;
    const refused = await docker(
      [
        'run',
        '--rm',
        ...harnessProbe(),
        '--name',
        probe,
        '--network',
        'none',
        '--mount',
        `type=volume,src=${fixture.cacheVolume},dst=/cache/never-mirrored.git,readonly,volume-subpath=never-mirrored.git`,
        ALPINE_IMAGE,
        'true',
      ],
      { allowFailure: true },
    );
    await docker(['rm', '-f', '-v', probe], { allowFailure: true });
    expect(refused.ok).toBe(false);
    expect(refused.stderr).toMatch(/never-mirrored\.git/);
  }, 180_000);

  /**
   * **What the run owns under `.git/` runs nothing in the export** (WP-75, backlogs 148 and 152).
   *
   * The positive control comes **first and on a copy** (`/work/pc`): the export replaces the
   * checkout's `.git/config` and removes its hooks, so a control run afterwards would be measuring the
   * platform's configuration rather than the run's. Each vector writes `/work/MARK-<name>`; the copy
   * shows every one of them firing under plain git in the same tree, same uid, same one-mirror mount;
   * the markers are cleared, the copy removed, and only then is the export run.
   */
  const markers = async (volume: string): Promise<string[]> => {
    const listing = await docker([
      'run',
      '--rm',
      ...harnessProbe(),
      '--network',
      'none',
      '-v',
      `${volume}:/work:ro`,
      ALPINE_IMAGE,
      'ls',
      '-A',
      '/work',
    ]);
    return listing.stdout.split('\n').filter((name) => name.startsWith('MARK-'));
  };
  const clearControl = async (volume: string): Promise<void> => {
    await docker([
      'run',
      '--rm',
      ...harnessProbe(),
      '--network',
      'none',
      '-v',
      `${volume}:/work`,
      ALPINE_IMAGE,
      'sh',
      '-c',
      'rm -rf /work/pc /work/MARK-*',
    ]);
  };
  /** Plain git — no platform wrapper, no replaced configuration — on a copy of the run's tree. */
  const underPlainGit = async (
    volume: string,
    commands: readonly string[],
    { inPlace = false }: { readonly inPlace?: boolean } = {},
  ): Promise<void> => {
    await docker([
      'run',
      '--rm',
      ...harnessProbe(),
      '--network',
      'none',
      '--user',
      '1000:1000',
      '-e',
      'HOME=/tmp',
      '-v',
      `${volume}:/work`,
      '--mount',
      `type=volume,src=${fixture.cacheVolume},dst=/cache/acme.git,readonly,volume-subpath=acme.git`,
      '--entrypoint',
      'sh',
      GIT_IMAGE,
      '-c',
      [
        "git config --global --add safe.directory '*'",
        'git config --global user.email probe@example.invalid',
        'git config --global user.name probe',
        // In place only when a copy cannot be made faithfully — a directory the run left
        // unreadable is one `cp -a` cannot copy either.
        inPlace ? 'cd /work/repo' : 'cp -a /work/repo /work/pc && cd /work/pc',
        ...commands.map((command) => `${command} >/dev/null 2>&1 || true`),
      ].join('\n'),
    ]);
  };
  const exportPushing = (handle: Awaited<ReturnType<typeof startRun>>['handle']) =>
    fixture.provider.export(
      handle,
      { branch: `agentic/e2e-${handle.runId}`, tarballPath: null, commitMessage: 'wip' },
      { host: fixture.repoContainer, username: 'agentic', password: 'unused-by-git-daemon' },
    );
  const remoteHas = async (branch: string): Promise<boolean> => {
    const refs = await docker([
      'run',
      '--rm',
      ...harnessProbe(),
      '--network',
      fixture.network,
      '--entrypoint',
      'git',
      GIT_IMAGE,
      'ls-remote',
      fixture.repoUrl,
      `refs/heads/${branch}`,
    ]);
    return refs.stdout.includes(`refs/heads/${branch}`);
  };

  const HOOKS = [
    'pre-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'reference-transaction',
    'post-index-change',
    'pre-push',
  ];
  const plantHooks = (dir: string): string =>
    [
      `mkdir -p ${dir}`,
      ...HOOKS.map(
        (hook) =>
          `printf '#!/bin/sh\\ntouch /work/MARK-hook-${hook}\\n' > ${dir}/${hook} && chmod 755 ${dir}/${hook}`,
      ),
    ].join(' && ');

  it.each([
    ['in .git/hooks', plantHooks('/work/repo/.git/hooks')],
    [
      'behind the run’s own core.hooksPath',
      `${plantHooks('/work/hooks')} && printf '[core]\\n\\thooksPath = /work/hooks\\n' >> /work/repo/.git/config`,
    ],
  ])(
    'the export mounts one mirror and fires no hook the run planted %s',
    async (_where, plant) => {
      const { handle } = await startRun();
      try {
        await plantInWorkspace(
          fixture,
          handle.volumeName,
          `${plant} && printf "agent work\\n" > /work/repo/AGENT.md`,
        );
        // The positive (rule 42), first and on a copy: the planted hooks are live.
        await underPlainGit(handle.volumeName, ['git add -A', 'git commit -q -m probe']);
        expect(await markers(handle.volumeName)).toEqual(
          expect.arrayContaining([
            'MARK-hook-pre-commit',
            'MARK-hook-commit-msg',
            'MARK-hook-post-commit',
            'MARK-hook-post-index-change',
          ]),
        );
        await clearControl(handle.volumeName);

        const result = await exportPushing(handle);
        expect(result.pushed).toBe(true);
        expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/);
        expect(await markers(handle.volumeName)).toEqual([]);
        const asked = cacheMountsOf(fixture.engine.createdBodies.get(`export-${handle.runId}`));
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject(OWN_MIRROR_MOUNT);
      } finally {
        await fixture.provider.destroy(handle);
      }
    },
    240_000,
  );

  it('executes nothing the run wrote into .git/config or .gitattributes, and pushes to the platform’s URL', async () => {
    const { handle } = await startRun();
    try {
      const script = (name: string, body: string): string =>
        `printf '#!/bin/sh\\n${body}\\n' > /work/v/${name} && chmod 755 /work/v/${name}`;
      await plantInWorkspace(
        fixture,
        handle.volumeName,
        [
          'mkdir -p /work/v',
          script('fsmonitor', 'touch /work/MARK-fsmonitor'),
          script('clean', 'touch /work/MARK-filter\\ncat'),
          script('gpg', 'touch /work/MARK-gpg\\nexit 1'),
          script('cred', 'touch /work/MARK-credential\\necho username=x\\necho password=y'),
          `printf '#!/bin/sh\\ntouch /work/MARK-hook-post-index-change\\n' > /work/repo/.git/hooks/post-index-change`,
          'chmod 755 /work/repo/.git/hooks/post-index-change',
          "printf '* filter=evil\\n' > /work/repo/.gitattributes",
          // `printf '%s\n'` with the lines as arguments, because two of them carry `%`.
          "printf '%s\\n' '[core]' 'fsmonitor = /work/v/fsmonitor' '[filter \"evil\"]' 'clean = /work/v/clean' " +
            "'[commit]' 'gpgSign = true' '[gpg]' 'program = /work/v/gpg' " +
            "'[remote \"origin\"]' 'pushurl = ext::sh -c touch% /work/MARK-pushurl' " +
            "'[protocol \"ext\"]' 'allow = always' " +
            "'[url \"ext::sh -c touch% /work/MARK-insteadof% #\"]' 'insteadOf = git://' " +
            "'[credential]' 'helper = /work/v/cred' >> /work/repo/.git/config",
          'printf "agent work\\n" > /work/repo/AGENT.md',
        ].join(' && '),
      );
      // The positive (rule 42): every vector fires under plain git in a copy of this tree.
      await underPlainGit(handle.volumeName, [
        'git status --porcelain',
        'git add -A',
        'git commit -q -m probe',
        'git push origin HEAD:refs/heads/probe',
        `git push ${fixture.repoUrl} HEAD:refs/heads/probe`,
        // Not a command the pre-WP-75 export ran (rule 43): it pushed over `git://`, which asks no
        // credential helper. This line shows the run's helper is **live** in this tree — that the
        // old export would have been handed the password needs an `https` push this fixture has not.
        "printf 'protocol=https\\nhost=example.invalid\\n\\n' | git credential fill",
      ]);
      expect((await markers(handle.volumeName)).sort()).toEqual([
        'MARK-credential',
        'MARK-filter',
        'MARK-fsmonitor',
        'MARK-gpg',
        'MARK-hook-post-index-change',
        'MARK-insteadof',
        'MARK-pushurl',
      ]);
      await clearControl(handle.volumeName);

      const result = await exportPushing(handle);
      expect(result.pushed).toBe(true);
      expect(await markers(handle.volumeName)).toEqual([]);
      // The push went where the platform's mirror says, not where the run's config pointed.
      expect(await remoteHas(`agentic/e2e-${handle.runId}`)).toBe(true);
      // The configuration the export left is the platform's, and a pre-run object still decodes
      // through the alternates — which are a file, not configuration.
      const after = await docker([
        'run',
        '--rm',
        ...harnessProbe(),
        '--network',
        'none',
        '--user',
        '1000:1000',
        '-e',
        'HOME=/tmp',
        '-e',
        'GIT_CONFIG_NOSYSTEM=1',
        '-v',
        `${handle.volumeName}:/work:ro`,
        '--mount',
        `type=volume,src=${fixture.cacheVolume},dst=/cache/acme.git,readonly,volume-subpath=acme.git`,
        '--entrypoint',
        'sh',
        GIT_IMAGE,
        '-c',
        'cat /work/repo/.git/config; echo ---; ' +
          "git -c safe.directory='*' -c core.hooksPath=/dev/null -C /work/repo show HEAD~1:README.md",
      ]);
      const [config = '', decoded = ''] = after.stdout.split('---');
      expect(config).toContain(fixture.repoUrl);
      for (const planted of ['fsmonitor', 'filter', 'gpg', 'pushurl', 'insteadOf', 'credential']) {
        expect(config).not.toContain(planted);
      }
      expect(decoded).toContain('# fixture repository');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  /** Writes into the run's tree **with git**, as uid 1000 — the agent's own commands, for the plants that need a repository. */
  const plantWithGit = async (volume: string, commands: readonly string[]): Promise<void> => {
    await docker([
      'run',
      '--rm',
      ...harnessProbe(),
      '--network',
      'none',
      '--user',
      '1000:1000',
      '-e',
      'HOME=/tmp',
      '-v',
      `${volume}:/work`,
      '--mount',
      `type=volume,src=${fixture.cacheVolume},dst=/cache/acme.git,readonly,volume-subpath=acme.git`,
      '--entrypoint',
      'sh',
      GIT_IMAGE,
      '-c',
      [
        'set -e',
        "git config --global --add safe.directory '*'",
        'git config --global user.email agent@example.invalid',
        'git config --global user.name agent',
        'mkdir -p /work/v',
        "printf '#!/bin/sh\\ntouch /work/MARK-nested-fsmonitor\\n' > /work/v/nested",
        'chmod 755 /work/v/nested',
        'cd /work/repo',
        ...commands,
      ].join('\n'),
    ]);
  };

  /**
   * **A nested repository's own configuration** (review round 2, measured there): a gitlink whose
   * repository sets `core.fsmonitor` ran it from the export's `git add -A`. The refusal is by name,
   * before the first git command that reads the work tree. Two shapes: the gitlink committed in the checkout (the
   * reviewer's), and a nested repository the run never added — which git 2.49.1 turns into a gitlink
   * on the first `add -A` without running its fsmonitor (measured on a throwaway container), and
   * whose fsmonitor then runs on the **next** tree walk; so its positive control is two `add`s.
   */
  it.each([
    [
      'a committed gitlink',
      [
        'git init -q sub',
        '(cd sub && echo a > x && git add x && git commit -q -m nested)',
        'git add sub',
        'git commit -q -m gitlink',
        'git -C sub config core.fsmonitor /work/v/nested',
        'echo dirty > sub/x',
      ],
      ['git add -A'],
    ],
    [
      'an untracked nested repository',
      [
        'git init -q sub',
        '(cd sub && echo a > x && git add x && git commit -q -m nested)',
        'git -C sub config core.fsmonitor /work/v/nested',
        'echo dirty > sub/x',
      ],
      ['git add -A', 'git add -A'],
    ],
  ])(
    'refuses to export a checkout holding %s, by name, and runs its fsmonitor nowhere',
    async (_shape, plant, control) => {
      const { handle } = await startRun();
      try {
        await plantWithGit(handle.volumeName, plant);
        await underPlainGit(handle.volumeName, control);
        expect(await markers(handle.volumeName)).toEqual(['MARK-nested-fsmonitor']);
        await clearControl(handle.volumeName);
        await expect(exportPushing(handle)).rejects.toMatchObject({
          code: 'workspace_failed',
          message: /refusing to export: the checkout holds a nested repository/,
        });
        expect(await markers(handle.volumeName)).toEqual([]);
        expect(await remoteHas(`agentic/e2e-${handle.runId}`)).toBe(false);
      } finally {
        await fixture.provider.destroy(handle);
      }
    },
    240_000,
  );

  /**
   * **An unreadable directory must not hide a nested repository** (review round 3, measured there on
   * the real script): the export runs as the run's own uid, so a directory the run left at mode
   * 0111 cannot be listed by `find`, while git reaches the nested repository through the index. The
   * positive control is plain `git status` **in place** (a copy of an unreadable tree is not the
   * tree); the export normalises the tree first, so its walk completes and the refusal is the
   * nested repository's, by name.
   */
  it('refuses a nested repository behind a directory the run made unlistable (mode 0111)', async () => {
    const { handle } = await startRun();
    try {
      await plantWithGit(handle.volumeName, [
        'mkdir d',
        'git init -q d/sub',
        '(cd d/sub && echo a > x && git add x && git commit -q -m nested)',
        'git add d/sub',
        'git commit -q -m gitlink',
        'git -C d/sub config core.fsmonitor /work/v/nested',
        'echo dirty > d/sub/x',
        'chmod 0111 d',
      ]);
      await underPlainGit(handle.volumeName, ['git status --porcelain'], { inPlace: true });
      expect(await markers(handle.volumeName)).toEqual(['MARK-nested-fsmonitor']);
      await clearControl(handle.volumeName);
      await expect(exportPushing(handle)).rejects.toMatchObject({
        code: 'workspace_failed',
        message: /refusing to export: the checkout holds a nested repository/,
      });
      expect(await markers(handle.volumeName)).toEqual([]);
      expect(await remoteHas(`agentic/e2e-${handle.runId}`)).toBe(false);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  /**
   * The other direction of the ruling (rule 42): a committed gitlink with **no** `.git` behind it —
   * the shape a project with submodules has in every checkout, since the clone initialises none —
   * exports and pushes normally. The committed-gitlink case above differs from this one by the
   * nested repository alone, so the refusal is the `.git`, not the gitlink.
   */
  it('exports a committed gitlink with no nested .git behind it, and pushes', async () => {
    const { handle } = await startRun();
    try {
      await plantWithGit(handle.volumeName, [
        'git init -q sub',
        '(cd sub && echo a > x && git add x && git commit -q -m nested)',
        'git add sub',
        'git commit -q -m gitlink',
        // What a clone leaves for an uninitialised submodule: the gitlink, and an empty directory.
        'rm -rf sub && mkdir sub',
        'printf "agent work\\n" > AGENT.md',
      ]);
      const result = await exportPushing(handle);
      expect(result.pushed).toBe(true);
      expect(await remoteHas(`agentic/e2e-${handle.runId}`)).toBe(true);
      expect(await markers(handle.volumeName)).toEqual([]);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 240_000);

  it.each([
    ['a symlink', 'mv /work/repo/.git /work/real-git && ln -s /work/real-git /work/repo/.git'],
    [
      'a gitfile',
      "mv /work/repo/.git /work/real-git && printf 'gitdir: /work/real-git\\n' > /work/repo/.git",
    ],
    // A linked worktree's `.git` is a directory whose `commondir` names the configuration git reads.
    ['a linked worktree (commondir)', "printf '/work/elsewhere\\n' > /work/repo/.git/commondir"],
  ])(
    'refuses to export a checkout whose .git is %s, by name',
    async (_shape, plant) => {
      const { handle } = await startRun();
      try {
        await plantInWorkspace(fixture, handle.volumeName, plant);
        await expect(exportPushing(handle)).rejects.toMatchObject({
          code: 'workspace_failed',
          message:
            /refusing to export: the checkout’s \.git is not the directory the platform cloned/,
        });
      } finally {
        await fixture.provider.destroy(handle);
      }
    },
    240_000,
  );
});

/**
 * **WP-76 — a minted run credential against a git server that reads it** (TD-028's WP-76
 * amendment; criteria (3)–(6) and (9); PROGRESS backlog 133 and 152).
 *
 * The remote is {@link startCredentialedGitServer}: `git http-backend` behind Basic auth that
 * **refuses anonymous access** and grants exactly the values the provider minted, by scope. The
 * credential is minted the production way — `runCredentialWrites` through a real
 * `IntegrationActionExecutor`, one audit row per mint and per revoke — over `FakeGitProvider`, whose
 * mint and revoke are mirrored onto the server's token list, so the value the server checks is the
 * value the provider handed out and nothing a test typed. The launcher's half is the production
 * `RunCredentialBroker`, holding what the create request would carry.
 *
 * Every refusal is paired with the acceptance that differs from it by the credential alone
 * (standing rule 42): the anonymous mirror fails where the read-credentialled one succeeds, and the
 * read credential's push is refused where the push credential's lands.
 */
describe('a minted run credential against a credentialled git server (WP-76)', () => {
  const PRIVATE_KEY = 'private';
  let server: CredentialedGitServer;

  beforeAll(async () => {
    server = await startCredentialedGitServer(fixture);
  }, 180_000);

  afterAll(async () => {
    await server?.stop();
  }, 60_000);

  /** The provider's mint and revoke, mirrored onto the server's token list. */
  const minting = () => {
    const git = createFakeGitProvider({
      integrationId: '00000000-0000-4000-8000-00000000e761',
      projects: [{ path: 'acme/api' }],
    });
    // The server grants by value and the port revokes by **address** (WP-77), so the address is
    // mapped back to the value here — as GitLab maps a token id to the token it deletes.
    const valueByAddress = new Map<string, string>();
    const port: GitProviderPort = Object.assign(Object.create(git) as GitProviderPort, {
      mintCredential: async (request: Parameters<GitProviderPort['mintCredential']>[0]) => {
        const minted = await git.mintCredential(request);
        await server.grant(minted.value, minted.scope);
        if (minted.revokeId !== null) valueByAddress.set(minted.revokeId, minted.value);
        return minted;
      },
      revokeCredential: async (address: CredentialRevocationAddress) => {
        await git.revokeCredential(address);
        const value = address.revokeId === null ? undefined : valueByAddress.get(address.revokeId);
        if (value === undefined) {
          throw new Error(`the credentialed git server has no token at ${address.revokeId}`);
        }
        await server.revoke(value);
      },
    });
    const auditLog = createMemoryAuditLog();
    const executor = createIntegrationActionExecutor({
      egress: allowAnyIntegrationHost(),
      auditLog,
      redactor: noSecretsRedactor(),
      timer: createVirtualTimer({ autoAdvance: true }),
      clock: fixedClock('2026-06-01T09:00:00.000Z', 1000),
    });
    const writes = runCredentialWrites(
      {
        executor,
        git: { port, ref: git.ref, project: 'acme/api', redactor: noSecretsRedactor() },
        taskManagement: null,
        communication: null,
      },
      { isRetired: async () => false },
    );
    // WP-80 (TD-028 decision 10): revoked through the integration that minted.
    const revocations = runCredentialRevocations({
      executor,
      port,
      ref: git.ref,
      redactor: noSecretsRedactor(),
    });
    const mint = async (runId: string, scope: 'read' | 'push') => {
      const answer = await writes.mint({
        runId: runId as Id,
        taskId: randomUUID() as Id,
        projectId: randomUUID() as Id,
        mode: 'normal',
        scope,
        branchPatterns: ['agentic/*'],
        ttlSeconds: 86_400,
        defaultBranch: 'main',
      });
      if (answer.kind !== 'minted') {
        throw new Error(
          `expected a credential, got ${answer.kind === 'unavailable' ? answer.reason : answer.kind}`,
        );
      }
      return answer.credential;
    };
    const revoke = async (runId: string, credential: MintedCredential) =>
      revocations.revoke(runCredentialHandle(credential, git.ref), {
        runId: runId as Id,
        taskId: randomUUID() as Id,
        projectId: randomUUID() as Id,
        mode: 'normal',
      });
    return { git, auditLog, mint, revoke };
  };

  /** The launcher's broker, holding what the create request carried. */
  const held = (runId: string, readOnly: boolean, credential: MintedCredential) => {
    const broker = new workspace.RunCredentialBroker();
    broker.hold({
      runId,
      readOnly,
      credential: {
        host: server.host,
        username: credential.username ?? 'agentic',
        password: credential.value,
        scope: credential.scope,
        expiresAt: credential.expiresAt,
      },
    });
    return broker;
  };

  const privateSpec = (runId: string, readOnly: boolean) =>
    workspace.workspaceSpecFixture({
      runId,
      readOnly,
      repo: { url: server.repoUrl, cacheKey: PRIVATE_KEY },
    });

  /** Plain git in a copy of the run's tree, the run's own mirror mounted — the positive control. */
  const underPlainGit = async (volume: string, commands: readonly string[]): Promise<void> => {
    await docker([
      'run',
      '--rm',
      ...harnessProbe(),
      '--network',
      'none',
      '--user',
      '1000:1000',
      '-e',
      'HOME=/tmp',
      '-v',
      `${volume}:/work`,
      '--mount',
      `type=volume,src=${fixture.cacheVolume},dst=/cache/${PRIVATE_KEY}.git,readonly,volume-subpath=${PRIVATE_KEY}.git`,
      '--entrypoint',
      'sh',
      GIT_IMAGE,
      '-c',
      [
        "git config --global --add safe.directory '*'",
        'git config --global user.email probe@example.invalid',
        'git config --global user.name probe',
        'cp -a /work/repo /work/pc && cd /work/pc',
        ...commands.map((command) => `${command} >/dev/null 2>&1 || true`),
      ].join('\n'),
    ]);
  };
  const markers = async (volume: string): Promise<string[]> =>
    (
      await docker([
        'run',
        '--rm',
        ...harnessProbe(),
        '--network',
        'none',
        '-v',
        `${volume}:/work:ro`,
        ALPINE_IMAGE,
        'ls',
        '-A',
        '/work',
      ])
    ).stdout
      .split('\n')
      .filter((name) => name.startsWith('MARK-'));

  it('mirrors a private repository with a minted read credential, and not anonymously', async () => {
    const runId = randomUUID();
    const spec = privateSpec(runId, true);
    const { mint, revoke } = minting();
    // The refusal first (rule 42): the same fetch with no credential is what a read-only run got
    // before WP-76 (backlog 133 (2)), and the server refuses it.
    await expect(
      fixture.provider.updateMirror({
        projectId: spec.projectId,
        repo: spec.repo,
        credential: null,
      }),
    ).rejects.toMatchObject({ code: 'workspace_failed' });
    const credential = await mint(runId, 'read');
    const broker = held(runId, true, credential);
    await expect(
      fixture.provider.updateMirror({
        projectId: spec.projectId,
        repo: spec.repo,
        credential: broker.credentialFor(runId),
      }),
    ).resolves.toMatchObject({ updated: true });
    const fetched = (await server.requests()).filter(
      (request) => request.granted && request.service === 'git-upload-pack',
    );
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((request) => request.password === credential.value)).toBe(true);
    await revoke(runId, credential);
  }, 240_000);

  it('refuses the read credential a push, lands the push credential’s branch, and revokes each once', async () => {
    const { git, auditLog, mint, revoke } = minting();
    const push = async (scope: 'read' | 'push') => {
      const runId = randomUUID();
      const spec = privateSpec(runId, scope === 'read');
      const credential = await mint(runId, scope);
      const broker = held(runId, scope === 'read', credential);
      await fixture.provider.updateMirror({
        projectId: spec.projectId,
        repo: spec.repo,
        credential: broker.credentialFor(runId),
      });
      const handle = await fixture.provider.create(...shipped(spec));
      try {
        await plantInWorkspace(
          fixture,
          handle.volumeName,
          'printf "agent work\\n" > /work/repo/AGENT.md',
        );
        const branch = `agentic/e2e-${scope}-${runId}`;
        const result = await fixture.provider.export(
          handle,
          { branch, tarballPath: null, commitMessage: 'wip: e2e' },
          broker.credentialFor(runId),
        );
        return { runId, credential, branch, result, handle };
      } finally {
        broker.forget(runId);
        await fixture.provider.destroy(handle);
        await revoke(runId, credential);
      }
    };

    const read = await push('read');
    expect(read.result.pushed).toBe(false);
    expect(await server.refs()).not.toContain(read.branch);
    const refused = (await server.requests()).filter(
      (request) =>
        request.password === read.credential.value && request.service === 'git-receive-pack',
    );
    expect(refused.length).toBeGreaterThan(0);
    expect(refused.every((request) => !request.granted && request.scope === 'read')).toBe(true);

    const written = await push('push');
    expect(written.result.pushed).toBe(true);
    expect(await server.refs()).toContain(`refs/heads/${written.branch}`);

    // Criteria (2) and (3), counted: one audit row per mint and per revoke, and the provider saw
    // exactly one revocation of each credential it minted.
    expect(auditLog.entriesFor('mint_credential')).toHaveLength(2);
    expect(auditLog.entriesFor('revoke_credential')).toHaveLength(2);
    expect(git.credentials.map((record) => [record.scope, record.revocations])).toEqual([
      ['read', 1],
      ['push', 1],
    ]);
    // A revoked credential is refused by the server — the revocation is real, not a flag.
    const dead = await docker(
      [
        'run',
        '--rm',
        ...harnessProbe(),
        '--network',
        fixture.network,
        '--entrypoint',
        'git',
        GIT_IMAGE,
        'ls-remote',
        server.repoUrl.replace('http://', `http://oauth2:${written.credential.value}@`),
      ],
      { allowFailure: true },
    );
    expect(dead.ok).toBe(false);
  }, 480_000);

  it('keeps the credential out of the run container’s environment and the launcher’s log (criterion 5)', async () => {
    const runId = randomUUID();
    const spec = privateSpec(runId, false);
    const { mint, revoke } = minting();
    const credential = await mint(runId, 'push');
    const broker = held(runId, false, credential);
    const warningsBefore = fixture.warnings.length;
    await fixture.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: broker.credentialFor(runId),
    });
    const handle = await fixture.provider.create(...shipped(spec));
    try {
      const inspected = await docker([
        'inspect',
        '--format',
        '{{json .Config.Env}}',
        handle.containerId,
      ]);
      expect(inspected.stdout).toContain('PATH=');
      expect(inspected.stdout).not.toContain(credential.value);
      const exported = await fixture.provider.export(
        handle,
        { branch: `agentic/e2e-env-${runId}`, tarballPath: null, commitMessage: 'wip' },
        broker.credentialFor(runId),
      );
      expect(exported.pushed).toBe(true);
      expect(JSON.stringify(fixture.warnings.slice(warningsBefore))).not.toContain(
        credential.value,
      );
    } finally {
      broker.forget(runId);
      await fixture.provider.destroy(handle);
      await revoke(runId, credential);
    }
  }, 240_000);

  /**
   * Criterion (9), backlog 152's credential half: WP-75's planted vectors, re-run with the export
   * **pushing under a minted credential** to a server that records which credential and which path
   * each request carried. The positive control runs first, on a copy (WP-75's reason).
   */
  it('executes nothing the run planted and pushes with the platform’s helper to the platform’s URL', async () => {
    const runId = randomUUID();
    const spec = privateSpec(runId, false);
    const { mint, revoke } = minting();
    const credential = await mint(runId, 'push');
    const broker = held(runId, false, credential);
    await fixture.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: broker.credentialFor(runId),
    });
    const handle = await fixture.provider.create(...shipped(spec));
    try {
      const script = (name: string, body: string): string =>
        `printf '#!/bin/sh\\n${body}\\n' > /work/v/${name} && chmod 755 /work/v/${name}`;
      const evilUrl = server.repoUrl.replace('/acme.git', '/evil.git');
      await plantInWorkspace(
        fixture,
        handle.volumeName,
        [
          'mkdir -p /work/v',
          script('fsmonitor', 'touch /work/MARK-fsmonitor'),
          script('clean', 'touch /work/MARK-filter\\ncat'),
          script('gpg', 'touch /work/MARK-gpg\\nexit 1'),
          script(
            'cred',
            'touch /work/MARK-credential\\necho username=planted\\necho password=planted-password',
          ),
          `printf '#!/bin/sh\\ntouch /work/MARK-hook-post-index-change\\n' > /work/repo/.git/hooks/post-index-change`,
          'chmod 755 /work/repo/.git/hooks/post-index-change',
          "printf '* filter=evil\\n' > /work/repo/.gitattributes",
          "printf '%s\\n' '[core]' 'fsmonitor = /work/v/fsmonitor' '[filter \"evil\"]' 'clean = /work/v/clean' " +
            "'[commit]' 'gpgSign = true' '[gpg]' 'program = /work/v/gpg' " +
            `'[remote "origin"]' 'pushurl = ${evilUrl}' ` +
            "'[credential]' 'helper = /work/v/cred' >> /work/repo/.git/config",
          'printf "agent work\\n" > /work/repo/AGENT.md',
        ].join(' && '),
      );
      // The positive (rule 42): every local vector fires under plain git in a copy of this tree.
      await underPlainGit(handle.volumeName, [
        'git status --porcelain',
        'git add -A',
        'git commit -q -m probe',
        "printf 'protocol=http\\nhost=example.invalid\\n\\n' | git credential fill",
      ]);
      expect((await markers(handle.volumeName)).sort()).toEqual([
        'MARK-credential',
        'MARK-filter',
        'MARK-fsmonitor',
        'MARK-gpg',
        'MARK-hook-post-index-change',
      ]);
      await docker([
        'run',
        '--rm',
        ...harnessProbe(),
        '--network',
        'none',
        '-v',
        `${handle.volumeName}:/work`,
        ALPINE_IMAGE,
        'sh',
        '-c',
        'rm -rf /work/pc /work/MARK-*',
      ]);
      const requestsBefore = (await server.requests()).length;

      const branch = `agentic/e2e-planted-${runId}`;
      const result = await fixture.provider.export(
        handle,
        { branch, tarballPath: null, commitMessage: 'wip' },
        broker.credentialFor(runId),
      );
      expect(result.pushed).toBe(true);
      expect(await markers(handle.volumeName)).toEqual([]);
      expect(await server.refs()).toContain(`refs/heads/${branch}`);
      const during = (await server.requests()).slice(requestsBefore);
      // The push URL is the platform's: nothing reached the planted `pushurl`.
      expect(during.some((request) => request.path.startsWith('/evil.git'))).toBe(false);
      // The credential helper is the platform's: every authenticated request carried the minted
      // value, and the planted helper's password reached nothing.
      const authenticated = during.filter((request) => request.password !== null);
      expect(authenticated.length).toBeGreaterThan(0);
      expect(
        authenticated.every(
          (request) =>
            request.password === credential.value &&
            request.path.startsWith('/acme.git/') &&
            request.granted,
        ),
      ).toBe(true);
      expect(during.some((request) => request.password === 'planted-password')).toBe(false);
    } finally {
      broker.forget(runId);
      await fixture.provider.destroy(handle);
      await revoke(runId, credential);
    }
  }, 240_000);
});
