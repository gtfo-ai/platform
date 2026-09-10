import { existsSync, realpathSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_LABELS } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { shortTempDir, workspaceSpecFixture } from './fixtures.js';
import {
  assertSafeBindSource,
  type DockerCreateBody,
  RUNTIME_SOURCE_MOUNT,
  runContainerCreateBody,
  sidecarCreateBody,
  type WorkspaceImages,
} from './hardening.js';

const images: WorkspaceImages = {
  runtime: 'platform-runtime:test',
  egress: 'tinyproxy:test',
  git: 'git:test',
  runtimeSourceDir: null,
};

const build = (overrides: Partial<Parameters<typeof runContainerCreateBody>[0]> = {}) =>
  runContainerCreateBody({
    spec: workspaceSpecFixture(),
    images,
    controlVolume: 'ctl',
    cacheVolume: 'repo-cache',
    labels: { [WORKSPACE_LABELS.run]: workspaceSpecFixture().runId },
    command: [],
    entrypoint: null,
    env: { HOME: '/tmp' },
    ...overrides,
  });

describe('run container hardening (technical/05)', () => {
  it('carries every flag technical/05 names', () => {
    const body = build();
    expect(body.User).toBe('1000:1000');
    expect(body.HostConfig.CapDrop).toEqual(['ALL']);
    expect(body.HostConfig.CapAdd).toEqual([]);
    expect(body.HostConfig.SecurityOpt).toEqual(['no-new-privileges:true']);
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.Tmpfs).toEqual({ '/tmp': 'size=64m,mode=1777,nosuid,nodev' });
    expect(body.HostConfig.Memory).toBe(512 * 1024 * 1024);
    expect(body.HostConfig.NanoCpus).toBe(1e9);
    expect(body.HostConfig.PidsLimit).toBe(256);
    expect(body.HostConfig.Init).toBe(true);
    expect(body.HostConfig.Runtime).toBe('runc');
    expect(body.StopTimeout).toBe(20);
    expect(body.HostConfig.NetworkMode).toBe(`run-${workspaceSpecFixture().runId}`);
  });

  it('bounds swap to the memory limit, so the limit bounds something', () => {
    // Left at Docker's default, a container over `Memory` swaps instead of failing and the limit
    // stops being a limit. The assertion is here because the field is easy to drop in a refactor
    // and nothing else would notice.
    const body = build();
    expect(body.HostConfig.MemorySwap).toBe(body.HostConfig.Memory);
  });

  it('takes the tmpfs size and the runtime from the spec rather than a constant', () => {
    const body = build({
      spec: workspaceSpecFixture({ limits: { tmpfsMb: 128 }, runtime: 'runsc' }),
    });
    expect(body.HostConfig.Tmpfs['/tmp']).toContain('size=128m');
    expect(body.HostConfig.Runtime).toBe('runsc');
  });

  /**
   * Standing rule 37: enumerate the output type's members, not the call sites. A test that lists
   * the fields we remembered to set says nothing about a field we forgot — so this walks the whole
   * create body and fails on any value that names the host, publishes a port or re-adds a
   * capability, whatever key it arrives under.
   */
  it('has nothing anywhere in the body that reaches the host', () => {
    const body = build();
    const flat = JSON.stringify(body);
    expect(flat).not.toContain('docker.sock');
    expect(flat).not.toContain('/var/run');
    expect(flat).not.toContain('"Privileged":true');
    expect(flat).not.toContain('"PublishAllPorts":true');
    expect(flat).not.toContain('Binds');
    for (const [key, value] of Object.entries(body.HostConfig)) {
      if (key === 'Mounts') {
        continue;
      }
      expect(JSON.stringify({ [key]: value })).not.toMatch(/"\/(proc|sys|dev|etc|boot)"/);
    }
  });

  it('mounts exactly the three volumes TD-025 §2 describes, and no bind at all', () => {
    const spec = workspaceSpecFixture();
    const mounts = build().HostConfig.Mounts;
    expect(mounts.map((mount) => mount.Type)).toEqual(['volume', 'volume', 'volume']);
    expect(mounts[0]).toMatchObject({
      Source: `ws-${spec.runId}`,
      Target: '/work',
      ReadOnly: false,
    });
    expect(mounts[1]).toMatchObject({
      Source: 'ctl',
      Target: '/ctl',
      ReadOnly: false,
      VolumeOptions: { Subpath: spec.runId },
    });
    expect(mounts[2]).toMatchObject({ Source: 'repo-cache', Target: '/cache', ReadOnly: true });
  });

  it('adds the repository bind, read-only, only when the image substitute is configured', () => {
    const body = build({
      images: { ...images, runtimeSourceDir: '/srv/checkout' },
      // Both filesystem questions are injected rather than answered by this machine: `/tmp` is its
      // own realpath on Linux and a symlink to `/private/tmp` on macOS, and no directory this test
      // could name is a checkout on both. The guard against *this* platform is measured below.
      bindChecks: { resolve: (candidate) => candidate, exists: () => true },
    });
    const bind = body.HostConfig.Mounts.find((mount) => mount.Type === 'bind');
    expect(bind).toMatchObject({ Target: RUNTIME_SOURCE_MOUNT, ReadOnly: true });
  });
});

describe('bind source guard', () => {
  /** "This directory, and only this directory, holds the marker." */
  const marker = (directory: string) => (candidate: string) =>
    candidate === path.join(directory, 'pnpm-workspace.yaml');

  const resolver = (map: Record<string, string>) => (candidate: string) => {
    const resolved = map[candidate];
    if (resolved === undefined) {
      const error: NodeJS.ErrnoException = new Error('ENOENT');
      error.code = 'ENOENT';
      throw error;
    }
    return resolved;
  };

  it('accepts an absolute path that is its own realpath', () => {
    expect(
      assertSafeBindSource('/srv/repo', {
        resolve: resolver({ '/srv/repo': '/srv/repo' }),
        exists: marker('/srv/repo'),
      }),
    ).toBe('/srv/repo');
  });

  it('strips a trailing separator before comparing', () => {
    expect(
      assertSafeBindSource('/srv/repo/', {
        resolve: resolver({ '/srv/repo': '/srv/repo' }),
        exists: marker('/srv/repo'),
      }),
    ).toBe('/srv/repo');
  });

  /**
   * The case that matters, and the reason `realpath` is called at all: Docker resolves a bind
   * source on the **daemon's** filesystem, so a symlink at the path we hand over is followed by
   * the daemon and never by us. `/home/ci/repo -> /` mounts the host root into a container running
   * an agent, and every string check passes it.
   */
  it('refuses a bind source that is a symlink', () => {
    expect(() =>
      assertSafeBindSource('/home/ci/repo', {
        resolve: resolver({ '/home/ci/repo': '/' }),
        exists: marker('/'),
      }),
    ).toThrow(/is a symlink/);
  });

  /**
   * The roots a mistake reaches for, refused **by the checkout condition** rather than by their
   * names — which is the point of the change: the resolver here maps each onto itself, so the
   * symlink branch cannot be what fires, and the message is asserted so the case cannot pass for
   * the wrong reason (standing rule 10).
   */
  it.each([['/'], ['/proc'], ['/sys'], ['/dev'], ['/var/run'], ['/etc'], ['/home/ci']])(
    'refuses %s as a bind source',
    (candidate) => {
      expect(() =>
        assertSafeBindSource(candidate, {
          resolve: resolver({ [candidate]: candidate }),
          exists: marker('/srv/repo'),
        }),
      ).toThrow(/not a checkout/);
    },
  );

  it('refuses a relative path before it touches the filesystem', () => {
    let touched = false;
    expect(() =>
      assertSafeBindSource('../repo', {
        resolve: () => {
          touched = true;
          return '/repo';
        },
      }),
    ).toThrow(/not an absolute path/);
    expect(touched).toBe(false);
  });

  it('refuses a path that does not exist', () => {
    expect(() => assertSafeBindSource('/nope', { resolve: resolver({}) })).toThrow(
      /does not exist/,
    );
  });
});

/**
 * The same guard against **this machine's** realpaths, which is the measurement the resolver-driven
 * cases above cannot make.
 *
 * Round 1 shipped a deny-list — `/`, `/proc`, `/sys`, `/dev`, `/run`, `/var/run`, `/etc`, `/boot`
 * — and its tests fed it a resolver that mapped each of those onto itself. On this platform they
 * do not: `/etc` resolves to `/private/etc` and `/var/run` to `/private/var/run`, so the deny
 * branch never fired at all, while the two paths that actually hand over the machine sailed
 * through because they *are* their own realpath. The reviewer measured both: `$HOME` was accepted,
 * bound at `/repo`, and `~/.ssh/id_ed25519` (432 B) read from inside the workspace container; the
 * Docker socket's realpath was accepted and the daemon recorded the bind.
 *
 * A deny-list of paths inherits the platform's symlink layout rather than the author's intent, so
 * the guard is now an allow-condition: the resolved directory must contain the marker of a
 * checkout of this repository. These cases feed it the real `realpathSync`, so a platform whose
 * layout differs from the author's assumption fails here rather than in production.
 */
describe('bind source guard, against this platform', () => {
  const repositoryRoot = realpathSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..'),
  );

  it('accepts a checkout of this repository, which is the one thing the knob is for', () => {
    expect(existsSync(path.join(repositoryRoot, 'pnpm-workspace.yaml'))).toBe(true);
    expect(assertSafeBindSource(repositoryRoot)).toBe(repositoryRoot);
  });

  it('refuses $HOME, where the ssh keys and the docker credentials are', () => {
    const home = realpathSync(homedir());
    // Stated rather than assumed: if a home directory ever *were* a checkout, this case would be
    // asserting something else, and it should fail rather than quietly change meaning.
    expect(existsSync(path.join(home, 'pnpm-workspace.yaml'))).toBe(false);
    expect(() => assertSafeBindSource(home)).toThrow(/not a checkout/);
  });

  it('refuses a real unix socket, the shape the docker socket has', async () => {
    const dir = await shortTempDir('agentic-bind-sock-');
    // Resolved, because `/tmp` is a symlink to `/private/tmp` on this platform and the case is
    // about the socket, not about the temp directory's own indirection.
    const socketPath = path.join(realpathSync(dir), 'docker.sock');
    const server = createServer();
    try {
      await new Promise<void>((resolve) => server.listen(socketPath, resolve));
      // The realpath is what Docker binds, so the realpath is what the guard must refuse —
      // `/var/run/docker.sock` is a symlink on this platform and would be caught by the wrong
      // branch (standing rule 10).
      expect(realpathSync(socketPath)).toBe(socketPath);
      expect(() => assertSafeBindSource(socketPath)).toThrow(/not a checkout/);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a directory that is merely inside the checkout, not the checkout', () => {
    // The knob mounts a *checkout*; `packages/` is not one, and neither is a temp directory. The
    // case exists because "contains the marker" must not be read as "is under something that
    // does".
    expect(() => assertSafeBindSource(path.join(repositoryRoot, 'packages'))).toThrow(
      /not a checkout/,
    );
  });
});

describe('egress sidecar', () => {
  const body: DockerCreateBody = sidecarCreateBody({
    spec: workspaceSpecFixture(),
    images,
    labels: {},
    command: [],
    entrypoint: null,
    configVolume: 'egress-config',
  });

  it('is hardened like the run container and publishes nothing', () => {
    expect(body.User).toBe('1000:1000');
    expect(body.HostConfig.CapDrop).toEqual(['ALL']);
    expect(body.HostConfig.ReadonlyRootfs).toBe(true);
    expect(body.HostConfig.PublishAllPorts).toBe(false);
    expect(body.HostConfig.PortBindings).toEqual({});
  });

  it('reads its allow-list from a read-only volume', () => {
    expect(body.HostConfig.Mounts).toEqual([
      { Type: 'volume', Source: 'egress-config', Target: '/etc/egress', ReadOnly: true },
    ]);
  });
});
