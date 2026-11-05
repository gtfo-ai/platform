/**
 * The long-running updater (WP-287 (2)) against a fake core, worker, registry and Docker: the order
 * of verify → refuse/pull → drain → idle → apply, and that a refused set is reported once and never
 * pulled.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { silentLogger } from '@platform/application';
import { WORKER_PROTOCOL_VERSION } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { AttestationRefusedError, type AttestationVerifier } from './attestation.js';
import type { UpdaterConfig } from './config.js';
import type { DockerRun } from './docker.js';
import { PREVIOUS_TEMPLATE_FILE, readState } from './plan.js';
import { RegistryError } from './registry.js';
import { applyContainerArgs, createUpdater, discoverSelf } from './updater.js';

const CREDENTIAL = `wkr_${'a'.repeat(26)}_${'b'.repeat(43)}`;
/** One build's four images: each set's digests are its own (a release rebuilds all four). */
const digests = (hex: string) => ({
  platform: `sha256:${hex.repeat(63)}0`,
  platform_launcher: `sha256:${hex.repeat(63)}1`,
  platform_runtime: `sha256:${hex.repeat(63)}2`,
  platform_egress: `sha256:${hex.repeat(63)}3`,
});
/** The build a digest belongs to: its set's letter, as the fake attestations name it. */
const setOf = (digest: string): string => digest.slice('sha256:'.length, 'sha256:'.length + 1);
/** When each set's attestations were logged: `e` older than `a` (running) older than `b`. */
const LOGGED: Readonly<Record<string, string>> = {
  e: '2026-10-01T00:00:00Z',
  a: '2026-11-01T00:00:00Z',
  b: '2026-11-05T00:00:00Z',
};
const refsOf = (hex: string) => ({
  platform: `ghcr.io/acme/platform@${digests(hex).platform}`,
  platform_launcher: `ghcr.io/acme/platform-launcher@${digests(hex).platform_launcher}`,
  platform_runtime: `ghcr.io/acme/platform-runtime@${digests(hex).platform_runtime}`,
  platform_egress: `ghcr.io/acme/platform-egress@${digests(hex).platform_egress}`,
});

/** The updater's own container as Docker describes it: a compose service with its two volumes. */
const SELF = {
  Id: 'self',
  Config: {
    Image: refsOf('a').platform,
    Labels: {
      'com.docker.compose.project': 'agentic-worker',
      'com.docker.compose.project.working_dir': '/home/dev/worker',
      'com.docker.compose.project.environment_file': '/home/dev/worker/.env.worker',
    },
  },
  Mounts: [
    { Type: 'volume', Name: 'agentic-worker_updates', Destination: '/var/lib/platform/updates' },
    {
      Type: 'volume',
      Name: 'agentic-worker_worker-state',
      Destination: '/var/lib/platform/worker-state',
    },
  ],
  NetworkSettings: {
    Networks: { 'agentic-worker_updater-docker': {}, 'agentic-worker_default': {} },
  },
};

const world = async (options: {
  readonly advertised: ReturnType<typeof digests> | null;
  readonly refuse?: string;
  /** The first verification throws this (a registry that answers 503), later ones answer. */
  readonly transientOnce?: Error;
  readonly verifier?: boolean;
  readonly idleAfter?: number;
  readonly coreUrl?: string | null;
}) => {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'updater-state-'));
  const workerStateDir = await mkdtemp(path.join(tmpdir(), 'updater-worker-'));
  await writeFile(path.join(workerStateDir, 'credential'), CREDENTIAL);
  const templatePath = path.join(stateDir, '..', `template-${path.basename(stateDir)}.yml`);
  await writeFile(templatePath, '# this image’s template\n');
  const events: string[] = [];
  const reports: unknown[] = [];
  let stateReads = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/api/worker/v1/release')) {
      events.push('release');
      return Response.json({
        protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [WORKER_PROTOCOL_VERSION] },
        digests: options.advertised,
      });
    }
    if (url.endsWith('/api/worker/v1/update-report')) {
      reports.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 204 });
    }
    if (url.endsWith('/internal/drain')) {
      events.push('drain');
      return Response.json({}, { status: 202 });
    }
    if (url.endsWith('/internal/state')) {
      stateReads += 1;
      return Response.json({
        idle: stateReads > (options.idleAfter ?? 0),
        connection: 'connected',
      });
    }
    return new Response(null, { status: 404 });
  };
  const calls: (readonly string[])[] = [];
  const docker: DockerRun = async (args) => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'inspect') {
      // The same container, its volumes mounted where this world's directories are.
      const self = {
        ...SELF,
        Mounts: [
          { Type: 'volume', Name: 'agentic-worker_updates', Destination: stateDir },
          { Type: 'volume', Name: 'agentic-worker_worker-state', Destination: workerStateDir },
        ],
      };
      return { stdout: JSON.stringify([self]), stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'pull') events.push(`pull ${args.at(-1)}`);
    if (args[0] === 'container' && args[1] === 'create') {
      events.push('create apply');
      return { stdout: 'apply-1\n', stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'start') events.push('start apply');
    return { stdout: '', stderr: '' };
  };
  const verified: string[] = [];
  let transient = options.transientOnce;
  const verifier: AttestationVerifier = {
    async verify(repository, _image, digest) {
      verified.push(`${repository}@${digest}`);
      if (transient !== undefined) {
        const error = transient;
        transient = undefined;
        throw error;
      }
      if (options.refuse !== undefined && digest === options.advertised?.platform) {
        throw new AttestationRefusedError(options.refuse);
      }
      const set = setOf(digest);
      return {
        repository,
        digest,
        commit: set.repeat(40),
        loggedAt: new Date(LOGGED[set] ?? '2026-11-03T00:00:00Z'),
      };
    },
  };
  const config: UpdaterConfig = {
    coreUrl: options.coreUrl === undefined ? 'https://core.example.test' : options.coreUrl,
    verifier:
      options.verifier === false
        ? null
        : {
            repository: 'ghcr.io/acme/platform',
            builder: {
              repository: 'acme/platform',
              workflowPath: '.github/workflows/image.yml',
              ref: 'refs/heads/main',
            },
          },
    verifierMissing:
      options.verifier === false
        ? 'this worker has no attestation verifier configured, so it does not self-update: APP_TRUSTED_BUILDER is unset'
        : null,
    registryEndpoints: new Map(),
    pollMs: 300_000,
    checkSeconds: 120,
    workerUrl: 'http://remote-worker:8080',
    workerStateDir,
    stateDir,
    running: refsOf('a'),
    logLevel: 'silent',
  };
  const updater = createUpdater({
    config,
    docker,
    fetch,
    logger: silentLogger,
    verifier: options.verifier === false ? null : verifier,
    containerId: 'self',
    templatePath,
    applyEnvironment: { DOCKER_HOST: 'tcp://updater-docker-proxy:2375' },
    now: () => new Date('2026-11-05T12:00:00Z'),
    sleep: async () => undefined,
  });
  return { updater, events, reports, calls, verified, stateDir, templatePath };
};

describe('the updater’s poll', () => {
  it('verifies all four digests, pulls them, drains, waits until idle, then starts the apply from the new image', async () => {
    const w = await world({ advertised: digests('b'), idleAfter: 2 });
    await w.updater.tick();
    const setVerified = (hex: string) => [
      `ghcr.io/acme/platform@${digests(hex).platform}`,
      `ghcr.io/acme/platform-launcher@${digests(hex).platform_launcher}`,
      `ghcr.io/acme/platform-runtime@${digests(hex).platform_runtime}`,
      `ghcr.io/acme/platform-egress@${digests(hex).platform_egress}`,
    ];
    // The advertised four first; then the running four, the downgrade bound's other side.
    expect(w.verified).toEqual([...setVerified('b'), ...setVerified('a')]);
    expect(w.events).toEqual([
      'release',
      ...Object.values(refsOf('b')).map((ref) => `pull ${ref}`),
      'drain',
      'create apply',
      'start apply',
    ]);
    // The rollback's template is this image's, written before the apply starts.
    expect(await readFile(path.join(w.stateDir, PREVIOUS_TEMPLATE_FILE), 'utf8')).toBe(
      '# this image’s template\n',
    );
    const create = w.calls.find((args) => args[1] === 'create') ?? [];
    expect(create.at(-1)).toBe(refsOf('b').platform);
    expect(create).toContain('--rm');
    expect(create).toContain('org.platform.update-apply=agentic-worker');
    expect(create).toContain('type=bind,source=/home/dev/worker,target=/home/dev/worker');
    expect(create).toContain(`type=volume,source=agentic-worker_updates,target=${w.stateDir}`);
    expect(create.join(' ')).not.toContain('com.docker.compose');
    expect(w.calls).toContainEqual([
      'network',
      'connect',
      'agentic-worker_updater-docker',
      'apply-1',
    ]);
    expect((await readState(w.stateDir))?.to_digests).toEqual(digests('b'));
  });

  it('refuses a digest whose attestation does not verify — reported once, nothing pulled, nothing drained', async () => {
    const w = await world({ advertised: digests('b'), refuse: 'carries no build attestation' });
    await w.updater.tick();
    await w.updater.tick();
    expect(w.events.filter((event) => event !== 'release')).toEqual([]);
    expect(w.reports).toEqual([
      {
        from: digests('a'),
        to: digests('b'),
        result: 'failed',
        detail: 'carries no build attestation',
      },
    ]);
  });

  it('refuses a downgrade to an older attested build, reported once', async () => {
    const w = await world({ advertised: digests('e') });
    await w.updater.tick();
    await w.updater.tick();
    expect(w.events).toEqual(['release', 'release']);
    expect(w.reports).toEqual([expect.objectContaining({ result: 'failed', to: digests('e') })]);
    expect(JSON.stringify(w.reports)).toContain('downgrade is refused');
  });

  it('refuses the running platform beside an older attested launcher: four images, one commit (review of PR #38)', async () => {
    const mixed = { ...digests('a'), platform_launcher: digests('e').platform_launcher };
    const w = await world({ advertised: mixed });
    await w.updater.tick();
    expect(w.events).toEqual(['release']);
    expect(w.reports).toEqual([expect.objectContaining({ result: 'failed', to: mixed })]);
    expect(JSON.stringify(w.reports)).toContain('do not name one commit');
  });

  it('asks again after a registry that answered 503 — nothing reported, and the next poll updates (review of PR #38)', async () => {
    const w = await world({
      advertised: digests('b'),
      transientOnce: new RegistryError('ghcr.io answered 503'),
    });
    await w.updater.tick();
    expect(w.events).toEqual(['release']);
    expect(w.reports).toEqual([]);
    await w.updater.tick();
    expect(w.events).toContain('start apply');
    expect(w.reports).toEqual([]);
  });

  it('idles without a core URL: no release asked, nothing reported (S-22.17)', async () => {
    const w = await world({ advertised: digests('b'), coreUrl: null });
    await w.updater.tick();
    expect(w.events).toEqual([]);
    expect(w.reports).toEqual([]);
  });

  it('refuses by name without a verifier, verifying and pulling nothing', async () => {
    const w = await world({ advertised: digests('b'), verifier: false });
    await w.updater.tick();
    expect(w.verified).toEqual([]);
    expect(w.events).toEqual(['release']);
    expect(JSON.stringify(w.reports)).toContain('APP_TRUSTED_BUILDER is unset');
  });

  it('does nothing when the core advertises what it runs', async () => {
    const w = await world({ advertised: digests('a') });
    await w.updater.tick();
    expect(w.events).toEqual(['release']);
    expect(w.reports).toEqual([]);
  });
});

describe('where the updater runs', () => {
  it('reads the project, its directory and env file, its volumes and networks off its own labels', async () => {
    const docker: DockerRun = async () => ({ stdout: JSON.stringify([SELF]), stderr: '' });
    const self = await discoverSelf(docker, 'self', {
      stateDir: '/var/lib/platform/updates',
      workerStateDir: '/var/lib/platform/worker-state',
    });
    expect(self).toEqual({
      project: {
        name: 'agentic-worker',
        workingDir: '/home/dev/worker',
        envFile: '/home/dev/worker/.env.worker',
      },
      image: refsOf('a').platform,
      networks: ['agentic-worker_default', 'agentic-worker_updater-docker'],
      updatesVolume: 'agentic-worker_updates',
      workerStateVolume: 'agentic-worker_worker-state',
    });
  });

  it('refuses an env file outside the project directory, and a container no compose project owns', async () => {
    const outside = {
      ...SELF,
      Config: {
        ...SELF.Config,
        Labels: {
          ...SELF.Config.Labels,
          'com.docker.compose.project.environment_file': '/etc/passwd',
        },
      },
    };
    const config = {
      stateDir: '/var/lib/platform/updates',
      workerStateDir: '/var/lib/platform/worker-state',
    };
    await expect(
      discoverSelf(async () => ({ stdout: JSON.stringify([outside]), stderr: '' }), 'self', config),
    ).rejects.toThrow(/outside its directory/);
    await expect(
      discoverSelf(
        async () => ({ stdout: JSON.stringify([{ ...SELF, Config: { Labels: {} } }]), stderr: '' }),
        'self',
        config,
      ),
    ).rejects.toThrow(/not a service of a compose project/);
  });

  it('mounts the worker credential read-only into the apply', () => {
    const args = applyContainerArgs({
      self: {
        project: { name: 'p', workingDir: '/w', envFile: '/w/.env' },
        image: 'x',
        networks: ['p_default'],
        updatesVolume: 'p_updates',
        workerStateVolume: 'p_worker-state',
      },
      plan: {
        id: '00000000-0000-4000-8000-000000000001',
        mode: 'update',
        project: 'p',
        working_dir: '/w',
        env_file: '/w/.env',
        from: refsOf('a'),
        to: refsOf('b'),
        from_digests: digests('a'),
        to_digests: digests('b'),
        core_url: 'https://core.example.test',
        worker_url: 'http://remote-worker:8080',
        check_seconds: 120,
      },
      image: refsOf('b').platform,
      stateDir: '/var/lib/platform/updates',
      workerStateDir: '/var/lib/platform/worker-state',
      environment: {},
    });
    expect(args).toContain(
      'type=volume,source=p_worker-state,target=/var/lib/platform/worker-state,readonly',
    );
  });
});
