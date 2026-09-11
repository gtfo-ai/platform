/**
 * WP-14's acceptance criterion: the launcher against a real Docker daemon, with a fixture
 * repository in a container, and **the security flags demonstrated rather than asserted**.
 *
 * ## The distinction this file is built around
 *
 * `hardening.test.ts` asserts the create body the provider sends. That is a test of a string this
 * repository wrote (standing rule 3). What is here instead:
 *
 *  - every flag is read back from `docker inspect` — the **daemon's** record of the container, not
 *    our argument vector;
 *  - and for the flags that buy a property, the property is attempted inside a container running
 *    under exactly that recorded `HostConfig`: a write outside the workspace, a
 *    capability-requiring syscall, `NoNewPrivs` as the kernel reports it, the memory ceiling as
 *    the cgroup reports it, and a route off the run network.
 *
 * Each negative is paired with the positive that makes it mean something (standing rule 42): the
 * `chown` that fails without `CAP_CHOWN` succeeds with it, the write that fails at `/etc` succeeds
 * at `/work/repo`, and the host that is unreachable from the workspace is reachable from a
 * container on the other network.
 *
 * ## What this file does not show, stated at each site
 *
 * The `platform-runtime` and `platform-egress` images are WP-22's and do not exist; the stand-ins
 * and their consequences are in `test/e2e/support/docker-workspace.ts`. The most important
 * consequence: **tinyproxy filters nothing here**, so what is demonstrated about egress is the
 * *topology* — the workspace's network is `internal: true` and has no route off it, and the
 * sidecar is the only container of a run attached to two networks.
 */
import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { workspace } from '@platform/infrastructure';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runWorkspaceProviderContractSuite } from '../../contract/support/workspace/provider-suite.js';
import {
  ALPINE_IMAGE,
  type DockerFixture,
  docker,
  exportPath,
  plantInWorkspace,
  probeUnderRunContainerConfig,
  REPO_ROOT,
  relaxControlDirectoryForHost,
  startDockerFixture,
} from '../support/docker-workspace.js';

let fixture: DockerFixture;

const specFor = (overrides: Parameters<typeof workspace.workspaceSpecFixture>[0] = {}) =>
  workspace.workspaceSpecFixture({
    runId: randomUUID(),
    ...overrides,
    repo: { url: fixture.repoUrl, cacheKey: 'acme', ...overrides.repo },
  });

const startRun = async (overrides: Parameters<typeof workspace.workspaceSpecFixture>[0] = {}) => {
  const spec = specFor(overrides);
  await fixture.provider.updateMirror({
    projectId: spec.projectId,
    repo: spec.repo,
    credential: null,
  });
  return { spec, handle: await fixture.provider.create(spec) };
};

beforeAll(async () => {
  fixture = await startDockerFixture();
}, 300_000);

afterAll(async () => {
  await fixture?.cleanup();
}, 120_000);

describe('the workspace lifecycle against a real daemon', () => {
  it('mirrors from the fixture repository container and clones with the mirror as its source', async () => {
    const spec = specFor();
    const mirror = await fixture.provider.updateMirror({
      projectId: spec.projectId,
      repo: spec.repo,
      credential: null,
    });
    expect(mirror.cachePath).toBe('/cache/acme.git');
    const handle = await fixture.provider.create(spec);
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'cat /work/repo/README.md; cat /work/repo/.git/objects/info/alternates',
      );
      expect(probe.exitCode).toBe(0);
      expect(probe.output).toContain('# fixture repository');
      // technical/05 §1: the clone's objects come from the shared mirror, which is why gc is
      // disabled on it while a workspace references it.
      expect(probe.output).toContain('/cache/acme.git/objects');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  /**
   * The control volume's root must admit the `prep-<run-id>` helper, and that helper is **not** an
   * omnipotent root: `CapDrop: ALL` with only `CAP_CHOWN` added leaves it without
   * `CAP_DAC_OVERRIDE`, so it is an ordinary process subject to the directory's mode bits.
   *
   * This is the assertion `main` was missing for six red runs. The whole failure —
   * `mkdir: can't create directory '/ctl/<uuid>': Permission denied`, three tiers of cases
   * downstream of it — was this one `mkdir`, and nothing named it. It is deliberately *not* routed
   * through the provider: a probe that starts one container says which permission failed, where a
   * `create` says only that a helper exited 1.
   *
   * **What it is worth on each platform.** Against a *named* volume it is worth the same on both,
   * which is the point of using one: a fresh named volume is `root:root 0755` on Docker Desktop
   * and on a Linux runner alike (measured on each). The platform difference lives entirely in the
   * fixture's bind-backed control root, and that is precisely why this case must not use it —
   * standing rule 69 the other way round.
   */
  it('admits the prep helper into a control volume root: root, CAP_DAC_OVERRIDE dropped', async () => {
    // A **throwaway named volume**, deliberately not `fixture.controlVolume`. The fixture's control
    // root is bind-backed and loosened to `0777` so this process can empty it, which would make the
    // probe a tautology: measured, `--user 1000:1000 --cap-drop ALL --cap-add CHOWN` cannot `mkdir`
    // into a `root:root 0755` root but can into a `0777` one, so run `#prepare` as any uid and the
    // e2e would stay green while production broke. A fresh named volume is `root:root 0755` — what
    // `APP_WORKSPACE_CONTROL_VOLUME` is in production — so this is that shape and no other.
    const volume = `agentic-e2e-ctlshape-${randomUUID()}`;
    await docker(['volume', 'create', volume]);
    try {
      const shape = await docker([
        'run',
        '--rm',
        '-v',
        `${volume}:/ctl`,
        ALPINE_IMAGE,
        'ls',
        '-ldn',
        '/ctl',
      ]);
      expect(shape.stdout).toMatch(/^drwxr-xr-x\s+\d+\s+0\s+0\b/);
      const result = await docker(
        [
          'run',
          '--rm',
          '--user',
          '0:0',
          '--cap-drop',
          'ALL',
          '--cap-add',
          'CHOWN',
          '--network',
          'none',
          '-v',
          `${volume}:/ctl`,
          ALPINE_IMAGE,
          'sh',
          '-c',
          `mkdir /ctl/${randomUUID()} && echo ADMITTED`,
        ],
        { allowFailure: true },
      );
      expect(`${result.stdout}${result.stderr}`).toContain('ADMITTED');
      expect(result.ok).toBe(true);
    } finally {
      await docker(['volume', 'rm', '-f', volume], { allowFailure: true });
    }
  }, 60_000);

  /**
   * The engine never pulls; `docker run` does. A `create` through the API answers **404** when the
   * image is absent — measured on this daemon, `{"message":"No such image: <tag>"}` — so an image
   * the fixture assumes rather than ensures is green on every machine that has run the suite
   * before and 21 failures on a clean runner, which is what happened (standing rules 4 and 69).
   */
  it('has every image it will create a container from, because the engine never pulls', async () => {
    const missing: string[] = [];
    for (const image of fixture.images) {
      const present = await docker(['image', 'inspect', image], { allowFailure: true });
      if (!present.ok) {
        missing.push(image);
      }
    }
    expect(missing).toEqual([]);
    // The mapping itself, so a reader never has to take "404 means no such image" on trust — and
    // so the message names the image, which cost this project a CI round when it did not.
    const absent = `alpine:does-not-exist-${randomUUID()}`;
    await expect(
      fixture.engine.createContainer(`agentic-e2e-absent-${randomUUID()}`, {
        Image: absent,
        Cmd: ['true'],
      }),
    ).rejects.toMatchObject({ code: 'not_found', message: expect.stringContaining(absent) });
  }, 60_000);

  it('creates the control sub-directory before the container starts (WP-13 obligation 1)', async () => {
    // Measured on Docker 29.7.2: the daemon refuses a `volume-subpath` that does not exist, which
    // is what makes the ordering load-bearing rather than tidy. Re-measured here so the model in
    // `workspace/testing.ts` is anchored to the daemon rather than to a memory of it.
    const missing = await docker(
      [
        'run',
        '--rm',
        '--mount',
        `type=volume,source=${fixture.controlVolume},target=/ctl,volume-subpath=${randomUUID()}`,
        'alpine:3.21',
        'true',
      ],
      { allowFailure: true },
    );
    expect(missing.ok).toBe(false);
    expect(missing.stderr).toMatch(/no such file or directory/i);

    const { handle } = await startRun();
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        handle.containerId,
        'ls -la /ctl; stat -c "%u:%g %a" /ctl/token',
      );
      expect(probe.output).toContain('token');
      // Owned by the uid the shim runs as, and 0600 — Q51's fail-closed choice.
      expect(probe.output).toContain('1000:1000 600');
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);

  it('shows one run only its own control directory', async () => {
    const first = await startRun();
    const second = await startRun();
    try {
      const probe = await probeUnderRunContainerConfig(
        fixture.engine,
        first.handle.containerId,
        'ls /ctl',
      );
      // `volume-subpath` is TD-025 §2's whole isolation mechanism: one `ctl` volume, one
      // sub-directory per run, and a workspace that cannot see a sibling's token.
      expect(probe.output).toContain('token');
      expect(probe.output).not.toContain(second.handle.runId);
    } finally {
      await fixture.provider.destroy(first.handle);
      await fixture.provider.destroy(second.handle);
    }
  }, 180_000);

  /**
   * `destroy` says it removes the control directory "which holds the run token"; until now only
   * the *script* was asserted (`provider.test.ts`), never the outcome.
   *
   * It did not hold on Linux. `#prepare` hands the directory to uid 1000 as `0700`, and the
   * `ctlrm-<run-id>` helper is root with `CapDrop: ALL` and nothing added — no `CAP_DAC_OVERRIDE`,
   * so it cannot descend into a directory it no longer owns. `#teardown` runs the step through
   * `step()`, which logs `workspace teardown partial` and carries on, so the token simply stayed on
   * the shared control volume. Measured on the daemon before the fix: `rm -rf /ctl/<id>` exits 1.
   *
   * The listing is taken by a container, not from the host, so this reads the volume rather than
   * the bind's macOS view of it.
   */
  const controlVolumeListing = async (): Promise<string> => {
    const listing = await docker([
      'run',
      '--rm',
      '--network',
      'none',
      '-v',
      `${fixture.controlVolume}:/ctl`,
      ALPINE_IMAGE,
      'ls',
      '-A',
      '/ctl',
    ]);
    return listing.stdout;
  };

  it('destroy leaves nothing of the run on the control volume, token and all', async () => {
    const { handle } = await startRun();
    await fixture.provider.destroy(handle);
    expect(await controlVolumeListing()).not.toContain(handle.runId);
  }, 180_000);

  /**
   * The adversary is the agent, and it owns the directory the launcher has to reclaim.
   *
   * `<ctl>/<run-id>` is mounted into the run container read-write and chowned to uid 1000, so the
   * agent may `chmod 000` it — and root with `CapDrop: ALL` is an ordinary non-owner. Measured:
   * with `CAP_CHOWN` only, `chown -R` + `chmod -R` + `rm -rf` exits 1 and the directory survives
   * holding the run token; with `CAP_DAC_OVERRIDE` a plain `rm -rf` exits 0. Nothing else would
   * ever collect it — `purgeExpired` lists *volumes* by `role=workspace` and never looks inside
   * this one — and `#teardown` only logs, so the leak is silent.
   *
   * The write is done from a container on the run's own `volume-subpath` mount as uid 1000 rather
   * than through the agent, because the agent is a stand-in until WP-22; the *mount* and the *uid*
   * are the real ones, read back from the run container's own configuration.
   */
  it('destroy reclaims the control directory even after the agent locks it', async () => {
    const { handle } = await startRun();
    const hostile = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'chmod 000 /ctl; stat -c "MODE=%a OWNER=%u" /ctl',
      { user: '1000:1000' },
    );
    // The lock takes on both platforms — measured, `MODE=0 OWNER=1000` through the subpath mount
    // on Docker Desktop as well as on Linux — so this is asserted, not hedged. An earlier revision
    // of this case guessed the opposite and carried a `process.platform` escape hatch for a
    // condition that never occurs.
    expect(hostile.output).toContain('MODE=0 ');
    const before = fixture.warnings.length;
    await fixture.provider.destroy(handle);
    expect(await controlVolumeListing()).not.toContain(handle.runId);
    // And it did not merely *appear* to work. `#teardown` logs a failed step and carries on, so
    // the volume listing alone would also pass if the directory had never been created. The
    // `control-dir` step specifically — `rm-network` partials are this fixture's own doing, since
    // a probe container of this file can still be attached to the run network when it is removed.
    const failed = fixture.warnings
      .slice(before)
      .filter((entry) => entry.message === 'workspace teardown step failed')
      .map((entry) => entry.fields['step']);
    expect(failed).not.toContain('control-dir');
  }, 180_000);
});

describe('the hardening flags, as the daemon recorded them and as the kernel enforces them', () => {
  let handle: Awaited<ReturnType<typeof startRun>>['handle'];

  beforeAll(async () => {
    handle = (await startRun()).handle;
  }, 180_000);

  afterAll(async () => {
    await fixture.provider.destroy(handle);
  }, 120_000);

  it('recorded every flag technical/05 names', async () => {
    const inspect = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
      Config: { User: string };
      HostConfig: Record<string, unknown>;
    };
    expect(inspect.Config.User).toBe('1000:1000');
    expect(inspect.HostConfig['CapDrop']).toEqual(['ALL']);
    expect(inspect.HostConfig['SecurityOpt']).toEqual(['no-new-privileges:true']);
    expect(inspect.HostConfig['ReadonlyRootfs']).toBe(true);
    expect(inspect.HostConfig['Init']).toBe(true);
    expect(inspect.HostConfig['PidsLimit']).toBe(256);
    expect(inspect.HostConfig['Memory']).toBe(512 * 1024 * 1024);
    expect(inspect.HostConfig['NanoCpus']).toBe(1_000_000_000);
    expect(inspect.HostConfig['Privileged']).toBe(false);
    expect(inspect.HostConfig['PublishAllPorts']).toBe(false);
    expect(inspect.HostConfig['Binds']).toBeFalsy();
  });

  it('--read-only refuses a write outside the workspace and allows one inside it', async () => {
    const outside = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'echo compromised > /etc/probe 2>&1',
    );
    expect(outside.exitCode).not.toBe(0);
    expect(outside.output).toMatch(/read-only file system/i);

    // The other half: without it, a container where *every* write failed would pass the negative.
    const inside = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'echo ok > /work/repo/.probe && cat /work/repo/.probe && rm /work/repo/.probe',
    );
    expect(inside.exitCode).toBe(0);
    expect(inside.output).toContain('ok');
  });

  it('--user 1000 runs the workspace as a non-root uid', async () => {
    const probe = await probeUnderRunContainerConfig(fixture.engine, handle.containerId, 'id -u');
    expect(probe.output.trim()).toBe('1000');
  });

  it('--cap-drop ALL refuses a capability-requiring syscall that succeeds with the capability', async () => {
    const script = 'touch /tmp/f && chown 0:0 /tmp/f 2>&1; echo "rc=$?"';
    const dropped = await probeUnderRunContainerConfig(fixture.engine, handle.containerId, script);
    expect(dropped.output).toMatch(/operation not permitted|not permitted/i);
    expect(dropped.output).toContain('rc=1');

    // The positive control, and the reason the negative is evidence: the same command, the same
    // image, the same mounts — only `CAP_CHOWN` added and the uid raised — succeeds. Without this,
    // a `chown` that failed for an unrelated reason would read as the capability working.
    const granted = await probeUnderRunContainerConfig(fixture.engine, handle.containerId, script, {
      user: '0:0',
      capAdd: ['CHOWN'],
    });
    expect(granted.output).toContain('rc=0');
  });

  it('no-new-privileges is what the kernel reports, not what we passed', async () => {
    const probe = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'grep NoNewPrivs /proc/self/status',
    );
    expect(probe.output).toMatch(/NoNewPrivs:\s*1/);
  });

  it('--init makes a reaper PID 1, so an orphan inside the workspace is not the shim', async () => {
    const probe = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'cat /proc/1/comm',
    );
    expect(probe.output.trim()).toBe('docker-init');
  });

  it('the memory limit is the one the cgroup enforces', async () => {
    const probe = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      'cat /sys/fs/cgroup/memory.max 2>/dev/null || cat /sys/fs/cgroup/memory/memory.limit_in_bytes',
    );
    // 512 MiB, read out of the container's own cgroup rather than out of `docker inspect`.
    expect(probe.output.trim()).toBe(String(512 * 1024 * 1024));
  });

  it('the workspace has no route off its internal network, and the sidecar has two networks', async () => {
    const reachable = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      // The fixture repository is on the bridge network; the workspace is on `run-<id>`, which is
      // `internal: true`. Bounded so a firewalled environment fails fast rather than hanging.
      `nc -z -w 3 ${fixture.repoContainer} 9418; echo "rc=$?"; ip route | grep -c "^default"`,
    );
    expect(reachable.output).toContain('rc=1');
    // No default route at all — the same thing WP-13 measured, now for a network this provider
    // created. (busybox `ip route show default` ignores its own selector; the line is matched.)
    expect(reachable.output.trim().endsWith('0')).toBe(true);

    // And the neighbour it *can* name is the sidecar, by container name on the embedded resolver.
    //
    // `getent hosts`, not `nslookup`. This assertion was `nslookup … ; rc=0` and it was the last
    // red test on `main`: busybox `nslookup` also queries `<name>.<search-domain>`, the embedded
    // resolver forwards that upstream, an `internal` network has no route upstream, and the whole
    // invocation exits 1 while the name resolves. A developer machine has no `search` line; a
    // cloud runner's host does, and Docker copies it into every container. Measured on one
    // internal network, varying nothing but that: `nslookup` rc 0 → 1, `getent hosts` rc 0 → 0,
    // same address both times. So the old probe's false branch meant "the name did not resolve
    // **or** some other query in the same process did not" (standing rule 56).
    //
    // The address is asserted and not only the status, and the pair is completed by a name that
    // *would* resolve if this network had a route off it — `example.com` rather than something
    // `.invalid`, which would fail for the wrong reason and make the negative vacuous (rule 42).
    const neighbour = await probeUnderRunContainerConfig(
      fixture.engine,
      handle.containerId,
      [
        `getent hosts egress-${handle.runId} | head -1 | sed 's/^/neighbour=/'`,
        `getent hosts egress-${handle.runId} >/dev/null; echo "neighbour_rc=$?"`,
        'getent hosts example.com >/dev/null; echo "upstream_rc=$?"',
      ].join('\n'),
      // The upstream half is a query the internal network drops, so it costs a full resolver
      // timeout: 10 s at the default budget, 2 s at this one — measured, same two answers. The
      // trade, since bounding a timeout can always hide a slow success: an `internal` network has
      // no route at all, so the packet is dropped rather than answered late, and a network that
      // *did* have a route would be answered by the host resolver far inside one second. The
      // "no route at all" claim does not rest on this either way — `nc` and the default-route
      // count above carry it (standing rule 43).
      { dnsOptions: ['timeout:1', 'attempts:1'] },
    );
    expect(neighbour.output).toContain('neighbour_rc=0');
    expect(neighbour.output).toMatch(/neighbour=\d+\.\d+\.\d+\.\d+\s/);
    expect(neighbour.output).not.toContain('upstream_rc=0');

    const sidecar = (await fixture.engine.inspectContainer(
      handle.sidecarContainerId ?? '',
    )) as unknown as { NetworkSettings: { Networks: Record<string, unknown> } };
    // One container on two networks *is* the network policy. The stand-in image runs `sleep`
    // rather than tinyproxy (support file), so nothing here shows a request being filtered.
    expect(Object.keys(sidecar.NetworkSettings.Networks)).toHaveLength(2);
    const runContainer = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
      NetworkSettings: { Networks: Record<string, unknown> };
    };
    expect(Object.keys(runContainer.NetworkSettings.Networks)).toHaveLength(1);
  });

  it('mounts no host path into the run container', async () => {
    const inspect = (await fixture.engine.inspectContainer(handle.containerId)) as unknown as {
      Mounts: { Type: string; Source: string; Destination: string; RW: boolean }[];
    };
    const binds = inspect.Mounts.filter((mount) => mount.Type === 'bind');
    // Exactly one, and it is the named hole: the repository, read-only, because the
    // `platform-runtime` image does not exist yet (WP-22). Every other mount is a named volume.
    expect(binds).toHaveLength(1);
    expect(binds[0]).toMatchObject({ Destination: '/repo', RW: false });
    // Docker Desktop rewrites a bind source to `/host_mnt/<path>`; on Linux it is the path
    // verbatim. Measured, not assumed — the first run of this file reported the prefix.
    expect(binds[0]?.Source.endsWith(REPO_ROOT)).toBe(true);
    expect(inspect.Mounts.some((mount) => mount.Source.includes('docker.sock'))).toBe(false);
  });
});

describe('mount escapes', () => {
  it('refuses a run id that could name another directory', async () => {
    for (const runId of [
      '../other-run',
      '..%2fother-run',
      `${randomUUID()}/../other`,
      `${randomUUID()}\0../other`,
    ]) {
      await expect(fixture.provider.create(specFor({ runId }))).rejects.toMatchObject({
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

describe('teardown ends the pid namespace (WP-13 obligation 3)', () => {
  const sizeFromVolume = async (volumeName: string): Promise<number> => {
    const probe = await docker([
      'run',
      '--rm',
      '-v',
      `${volumeName}:/work`,
      'alpine:3.21',
      'sh',
      '-c',
      'wc -c < /work/tick 2>/dev/null || echo 0',
    ]);
    return Number.parseInt(probe.stdout.trim() || '0', 10);
  };

  /**
   * The criterion in the plan row: *a run whose child forked a detached grandchild leaves no
   * process behind, including on the paths where the shim exited first and the launcher is only
   * tidying up.*
   *
   * ## What the first attempt at this test measured instead, and why it is worth recording
   *
   * The container was first given a command that forked the grandchild and **exited 0** — "the
   * shim exited first", literally. The grandchild never wrote a byte: when a container's PID 1
   * exits, the daemon tears the pid namespace down with it, so a detached grandchild cannot
   * outlive its own container's main process. Measured on Docker 29.7.2.
   *
   * That is not a reason to drop the case; it is the shape of the real risk, sharpened. The
   * dangerous state is the one where the container is **still up**: the shim's flush window
   * re-arms on progress (WP-13, standing rule 50), so a grandchild holding the stdout pipe and
   * dribbling keeps the shim alive and the container running for as long as it likes. So PID 1
   * here sleeps — standing in for a shim that is still draining — while a grandchild in its own
   * session writes, and nothing has signalled anything. Then the launcher tidies up.
   */
  it('a detached grandchild does not survive destroy', async () => {
    const { handle } = await startRun();
    const inspect = await fixture.engine.inspectContainer(handle.containerId);
    const name = `agentic-e2e-orphan-${randomUUID().slice(0, 8)}`;
    const orphanId = await fixture.engine.createContainer(name, {
      Image: 'alpine:3.21',
      Entrypoint: ['/bin/sh', '-c'],
      // The grandchild is `setsid`, so it is in a new session and a new process group: a signal to
      // the main pid, or to the main pid's group, cannot reach it. PID 1 then sleeps, which is the
      // shim still holding the run open.
      Cmd: [
        'setsid sh -c "while :; do printf x >> /work/tick; sleep 0.1; done" >/dev/null 2>&1 & ' +
          'sleep 600',
      ],
      User: inspect.Config.User ?? '1000:1000',
      HostConfig: inspect.HostConfig,
    });
    try {
      await fixture.engine.startContainer(orphanId);

      // Positive first: the grandchild is really running, and nothing has signalled anything.
      // Polled to a deadline — a lower bound on progress, never a sleep-then-assert.
      const deadline = Date.now() + 60_000;
      let growing = 0;
      for (;;) {
        growing = await sizeFromVolume(handle.volumeName);
        if (growing > 0) {
          break;
        }
        if (Date.now() > deadline) {
          throw new Error('the detached grandchild never wrote: the premise did not hold');
        }
        await new Promise((resolve) => setTimeout(resolve, 200));
      }

      await fixture.provider.destroy({ ...handle, containerId: orphanId });

      const afterDestroy = await sizeFromVolume(handle.volumeName);
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      const later = await sizeFromVolume(handle.volumeName);
      // It was writing every 100 ms, so two seconds of silence is about twenty missed writes. The
      // assertion is equality of a counter that would otherwise have moved by ~20; a slower
      // machine only makes it safer.
      expect(later).toBe(afterDestroy);
      expect(afterDestroy).toBeGreaterThan(0);

      const gone = await docker(['inspect', orphanId], { allowFailure: true });
      expect(gone.ok).toBe(false);
    } finally {
      await docker(['rm', '-f', orphanId], { allowFailure: true });
      await fixture.provider.destroy(handle);
    }
  }, 300_000);
});

describe('retention', () => {
  it('keeps a volume inside its window and removes one past it', async () => {
    const { handle } = await startRun();
    await fixture.provider.destroy(handle);

    const kept = await fixture.provider.purgeExpired(new Date('2020-01-01T00:00:00.000Z'));
    expect(kept.volumes).toContainEqual(
      expect.objectContaining({ volumeName: handle.volumeName, keptReason: 'not_expired' }),
    );
    const stillThere = await docker(['volume', 'inspect', handle.volumeName], {
      allowFailure: true,
    });
    expect(stillThere.ok).toBe(true);

    const purged = await fixture.provider.purgeExpired(new Date('2099-01-01T00:00:00.000Z'));
    expect(purged.volumes).toContainEqual(
      expect.objectContaining({ volumeName: handle.volumeName, removed: true }),
    );
    // The data is really gone, not merely reported gone.
    const afterwards = await docker(['volume', 'inspect', handle.volumeName], {
      allowFailure: true,
    });
    expect(afterwards.ok).toBe(false);
  }, 240_000);

  it('keeps a volume whose run still has a container', async () => {
    const { handle } = await startRun();
    try {
      const report = await fixture.provider.purgeExpired(new Date('2099-01-01T00:00:00.000Z'));
      expect(report.volumes).toContainEqual(
        expect.objectContaining({ volumeName: handle.volumeName, keptReason: 'in_use' }),
      );
      expect(
        (await docker(['volume', 'inspect', handle.volumeName], { allowFailure: true })).ok,
      ).toBe(true);
    } finally {
      await fixture.provider.destroy(handle);
    }
  }, 180_000);
});

describe('create is atomic', () => {
  it('leaves no container, network or sidecar behind when a step fails', async () => {
    const before = await docker(['ps', '-aq', '--filter', 'label=com.agentic.run']);
    const spec = specFor({ repo: { cacheKey: 'no-such-mirror' } });
    await expect(fixture.provider.create(spec)).rejects.toMatchObject({
      code: 'workspace_failed',
    });
    const after = await docker(['ps', '-aq', '--filter', 'label=com.agentic.run']);
    expect(after.stdout.split('\n').filter(Boolean)).toEqual(
      before.stdout.split('\n').filter(Boolean),
    );
    const network = await docker(['network', 'inspect', `run-${spec.runId}`], {
      allowFailure: true,
    });
    expect(network.ok).toBe(false);
  }, 180_000);
});

/**
 * The shared `WorkspaceProvider` contract suite, against a real daemon.
 *
 * The same file the fake runs in the contract tier. Running it twice is the whole mechanism that
 * keeps the fake from drifting (standing rule 23): a promise taught to one implementation and not
 * the other fails here.
 *
 * It is slow — every case builds a network, two volumes, four helper containers and two
 * long-lived ones — and that is the price of the fake being trustworthy for WP-15.
 */
runWorkspaceProviderContractSuite('DockerWorkspaceProvider', {
  supportsPurge: true,
  // What the daemon was asked to do to this run's container, recorded by the engine itself rather
  // than inferred from the port's return values.
  containerOps: (handle) => fixture.engine.opsFor(handle.containerId),
  provider: async () => {
    // A mirror per case: the suite has a case that asserts `create` refuses *before* the mirror
    // exists, and a shared fixture would already have one. The fake gets a fresh provider per
    // case; this is how the Docker runner gets the same freshness.
    const runId = randomUUID();
    const spec = specFor({ runId, repo: { cacheKey: `acme-${runId}` } });
    let created: string | null = null;
    return {
      provider: {
        updateMirror: (input) => fixture.provider.updateMirror(input),
        create: async (input) => {
          const handle = await fixture.provider.create(input);
          created = handle.runId;
          // Q51, admitted: this process is not uid 1000, and `attach` reads a 0600 file owned by
          // it. The real mode is measured in its own case above, before anything relaxes it.
          await relaxControlDirectoryForHost(fixture, handle.runId);
          return handle;
        },
        attach: (handle) => fixture.provider.attach(handle),
        kill: (handle) => fixture.provider.kill(handle),
        destroy: (handle) => fixture.provider.destroy(handle),
        export: (handle, request, credential) =>
          fixture.provider.export(handle, request, credential),
        purgeExpired: (now) => fixture.provider.purgeExpired(now),
      },
      spec,
      tarballPath: exportPath(fixture, `${spec.runId}.tar`),
      plantEscapingLink: async (handle) => {
        await plantInWorkspace(
          fixture,
          handle.volumeName,
          'ln -sf ../../../../etc/passwd /work/repo/escape',
        );
      },
      cleanup: async () => {
        if (created !== null) {
          await docker(['rm', '-f', `ws-${created}`, `egress-${created}`], { allowFailure: true });
          await docker(['network', 'rm', `run-${created}`], { allowFailure: true });
          await docker(['volume', 'rm', '-f', `ws-${created}`, `egress-${created}`], {
            allowFailure: true,
          });
        }
      },
    };
  },
});
