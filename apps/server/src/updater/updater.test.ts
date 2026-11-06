/**
 * The long-running updater (WP-287 (2)) against a fake core, worker, registry and Docker: the order
 * of verify → refuse/pull → drain → idle → apply, and that a refused set is reported once and never
 * pulled.
 */
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { WORKER_PROTOCOL_VERSION } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { asLoggerPort, createLogger } from '../logging.js';
import { createCoreClient } from '../remote-worker/core-client.js';
import { AttestationRefusedError, type AttestationVerifier } from './attestation.js';
import { DEFAULT_UPDATE_POLL_SECONDS, loadUpdaterConfig, type UpdaterConfig } from './config.js';
import type { DockerRun } from './docker.js';
import { HEARTBEAT_EVERY_MS, HEARTBEAT_FILE, HEARTBEAT_STALE_AFTER_MS } from './heartbeat.js';
import { PREVIOUS_TEMPLATE_FILE, readState, statePathOf, updatePlanSchema } from './plan.js';
import { RegistryError } from './registry.js';
import {
  applyContainerArgs,
  createUpdater,
  discoverSelf,
  MAX_POLL_BACKOFF_MS,
  mountSpec,
  nextPollDelayMs,
} from './updater.js';

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
    { Type: 'bind', Source: '/home/dev/worker', Destination: '/var/lib/platform/host-bundle' },
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
  /**
   * The credential file's text (default: the bare credential, as written before WP-294); `null`:
   * no file — a worker not approved yet.
   */
  readonly credentialFile?: string | null;
  /** `core-url` in `worker-state`: a platform chosen on the worker's page (WP-294). */
  readonly storedCoreUrl?: string;
  /**
   * The folder as Docker reports it: Compose's `working_dir` label and the source of the updater's
   * `host-bundle` mount (default `/home/dev/worker`).
   */
  readonly hostDirectory?: string;
  /** The source Docker reports for the mount, when it differs from the label (Docker Desktop). */
  readonly folderSource?: string;
  /** `false`: the updater has no `host-bundle` mount (a compose file from before S-22.21). */
  readonly folderMount?: boolean;
  /** The configured poll interval (default 300 s, the value these tests were written against). */
  readonly pollMs?: number;
  /** The first `n` `GET release` calls answer 503 (a core in trouble). */
  readonly releaseFailures?: number;
  /** The first `docker image pull` fails (a registry that went away after the verification). */
  readonly pullFailsOnce?: boolean;
  /** `run()` is stopped once this many `GET release` calls were made. */
  readonly stopAfterReleases?: number;
  /**
   * What the apply container leaves in `state.json` when it ends (default: nothing, so the state
   * still reads the updater's own `launched` step); `unreadable` overwrites it with text no reader
   * parses.
   */
  readonly applyEnds?: 'succeeded' | 'rolled_back' | 'unreadable';
}) => {
  /**
   * A virtual clock: `sleep` advances it, so `run()`'s loop is driven without waiting, and each
   * `GET release` is stamped with the virtual milliseconds since the start.
   */
  const start = Date.parse('2026-11-05T12:00:00Z');
  let clock = start;
  const releaseAt: number[] = [];
  let stopRun: (() => void) | null = null;
  const stateDir = await mkdtemp(path.join(tmpdir(), 'updater-state-'));
  const workerStateDir = await mkdtemp(path.join(tmpdir(), 'updater-worker-'));
  if (options.credentialFile !== null) {
    await writeFile(path.join(workerStateDir, 'credential'), options.credentialFile ?? CREDENTIAL);
  }
  if (options.storedCoreUrl !== undefined) {
    await writeFile(path.join(workerStateDir, 'core-url'), `${options.storedCoreUrl}\n`);
  }
  const logLines: string[] = [];
  const logger = asLoggerPort(
    createLogger({
      level: 'debug',
      format: 'json',
      role: 'updater',
      destination: { write: (line: string) => logLines.push(line) },
    }),
  );
  const authorizations: string[] = [];
  const templatePath = path.join(stateDir, '..', `template-${path.basename(stateDir)}.yml`);
  await writeFile(templatePath, '# this image’s template\n');
  const events: string[] = [];
  const reports: unknown[] = [];
  let stateReads = 0;
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
    if (authorization !== undefined) authorizations.push(authorization);
    if (url.endsWith('/api/worker/v1/release')) {
      events.push('release');
      releaseAt.push(clock - start);
      if (
        options.stopAfterReleases !== undefined &&
        releaseAt.length >= options.stopAfterReleases
      ) {
        stopRun?.();
      }
      if (releaseAt.length <= (options.releaseFailures ?? 0)) {
        return new Response(null, { status: 503 });
      }
      return Response.json({
        protocol: { current: WORKER_PROTOCOL_VERSION, accepted: [WORKER_PROTOCOL_VERSION] },
        digests: options.advertised,
      });
    }
    if (url.endsWith('/api/worker/v1/update-report')) {
      events.push('report');
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
  let pullFails = options.pullFailsOnce === true;
  const docker: DockerRun = async (args) => {
    calls.push(args);
    if (args[0] === 'container' && args[1] === 'inspect') {
      // The same container, its volumes mounted where this world's directories are.
      const self = {
        ...SELF,
        Config: {
          ...SELF.Config,
          Labels: {
            ...SELF.Config.Labels,
            ...(options.hostDirectory === undefined
              ? {}
              : {
                  'com.docker.compose.project.working_dir': options.hostDirectory,
                  'com.docker.compose.project.environment_file': `${options.hostDirectory}\\.env`,
                }),
          },
        },
        Mounts: [
          ...(options.folderMount === false
            ? []
            : [
                {
                  Type: 'bind',
                  Source: options.folderSource ?? options.hostDirectory ?? '/home/dev/worker',
                  Destination: '/var/lib/platform/host-bundle',
                },
              ]),
          { Type: 'volume', Name: 'agentic-worker_updates', Destination: stateDir },
          { Type: 'volume', Name: 'agentic-worker_worker-state', Destination: workerStateDir },
        ],
      };
      return { stdout: JSON.stringify([self]), stderr: '' };
    }
    if (args[0] === 'image' && args[1] === 'pull') {
      if (pullFails) {
        pullFails = false;
        events.push('pull failed');
        throw new Error('the registry went away');
      }
      events.push(`pull ${args.at(-1)}`);
    }
    if (args[0] === 'container' && args[1] === 'create') {
      events.push('create apply');
      return { stdout: 'apply-1\n', stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'start') events.push('start apply');
    if (args[0] === 'container' && args[1] === 'wait' && options.applyEnds !== undefined) {
      const file = statePathOf(stateDir);
      if (options.applyEnds === 'unreadable') {
        await writeFile(file, 'not a state');
      } else {
        const state = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
        await writeFile(file, JSON.stringify({ ...state, result: options.applyEnds }));
      }
    }
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
    pollMs: options.pollMs ?? 300_000,
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
    logger,
    verifier: options.verifier === false ? null : verifier,
    containerId: 'self',
    templatePath,
    applyEnvironment: { DOCKER_HOST: 'tcp://updater-docker-proxy:2375' },
    now: () => new Date(clock),
    sleep: async (ms) => {
      clock += ms;
    },
  });
  stopRun = () => updater.stop();
  return {
    releaseAt,
    updater,
    events,
    reports,
    calls,
    verified,
    stateDir,
    workerStateDir,
    templatePath,
    logLines,
    authorizations,
  };
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
    // The folder is mounted at the fixed path, from the source Docker reported (S-22.21).
    expect(create.filter((arg) => arg.startsWith('type=bind'))).toEqual([
      'type=bind,source=/home/dev/worker,target=/var/lib/platform/host-bundle',
    ]);
    const plan = updatePlanSchema.parse(
      JSON.parse(
        (create.find((arg) => arg.startsWith('APP_UPDATE_PLAN=')) ?? '').slice(
          'APP_UPDATE_PLAN='.length,
        ),
      ),
    );
    expect(plan.working_dir).toBe('/var/lib/platform/host-bundle');
    // The env file the project was brought up with (`--env-file .env.worker`), by its name.
    expect(plan.env_file).toBe('/var/lib/platform/host-bundle/.env.worker');
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

  it.each([
    [
      'Docker Desktop for Windows',
      'C:\\Users\\dev\\agentic-worker',
      '/run/desktop/mnt/host/c/Users/dev/agentic-worker',
    ],
    [
      'a folder with a space',
      '/Users/dev/Library/Application Support/agentic-worker',
      '/Users/dev/Library/Application Support/agentic-worker',
    ],
  ])(
    'updates a project brought up from %s: the plan names the fixed container path, and the folder is mounted from the source Docker reported (S-22.21, backlog 990)',
    async (_case, hostDirectory, folderSource) => {
      const w = await world({ advertised: digests('b'), hostDirectory, folderSource });
      await w.updater.tick();
      expect(w.events).toEqual([
        'release',
        ...Object.values(refsOf('b')).map((ref) => `pull ${ref}`),
        'drain',
        'create apply',
        'start apply',
      ]);
      expect(w.reports).toEqual([]);
      const create = w.calls.find((args) => args[1] === 'create') ?? [];
      // The label is never read as a path: only the mount's source, handed back as one CSV field.
      if (hostDirectory !== folderSource) expect(create.join(' ')).not.toContain(hostDirectory);
      expect(create.filter((arg) => arg.includes('target=/var/lib/platform/host-bundle'))).toEqual([
        mountSpec(['type=bind', `source=${folderSource}`, 'target=/var/lib/platform/host-bundle']),
      ]);
      const planArg = create.find((arg) => arg.startsWith('APP_UPDATE_PLAN=')) ?? '';
      const plan = updatePlanSchema.parse(JSON.parse(planArg.slice('APP_UPDATE_PLAN='.length)));
      expect(plan).toMatchObject({
        project: 'agentic-worker',
        working_dir: '/var/lib/platform/host-bundle',
        env_file: '/var/lib/platform/host-bundle/.env',
      });
    },
  );

  it('refuses a digest whose attestation does not verify — reported once, nothing pulled, nothing drained', async () => {
    const w = await world({ advertised: digests('b'), refuse: 'carries no build attestation' });
    await w.updater.tick();
    await w.updater.tick();
    expect(w.events.filter((event) => event !== 'release' && event !== 'report')).toEqual([]);
    expect(w.reports).toEqual([
      {
        from: digests('a'),
        to: digests('b'),
        result: 'failed',
        detail: 'carries no build attestation',
      },
    ]);
  });

  it('refuses, before pulling or draining, an update it cannot apply (no host-bundle mount) — reported once, the worker left taking work (S-22.20)', async () => {
    const w = await world({ advertised: digests('b'), folderMount: false });
    await w.updater.tick();
    await w.updater.tick();
    // No pull and no drain: before S-22.20 the refusal came after the drain, every poll.
    expect(w.events).toEqual(['release', 'report', 'release']);
    expect(w.calls.some((args) => args[1] === 'create')).toBe(false);
    expect(w.reports).toEqual([
      expect.objectContaining({ result: 'failed', from: digests('a'), to: digests('b') }),
    ]);
    expect(JSON.stringify(w.reports)).toContain('not mounted at /var/lib/platform/host-bundle');
  });

  it('refuses a downgrade to an older attested build, reported once', async () => {
    const w = await world({ advertised: digests('e') });
    await w.updater.tick();
    await w.updater.tick();
    expect(w.events).toEqual(['release', 'report', 'release']);
    expect(w.reports).toEqual([expect.objectContaining({ result: 'failed', to: digests('e') })]);
    expect(JSON.stringify(w.reports)).toContain('downgrade is refused');
  });

  it('refuses the running platform beside an older attested launcher: four images, one commit (review of PR #38)', async () => {
    const mixed = { ...digests('a'), platform_launcher: digests('e').platform_launcher };
    const w = await world({ advertised: mixed });
    await w.updater.tick();
    expect(w.events).toEqual(['release', 'report']);
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

  it('reads a two-line credential (WP-294: its core on line 2) by its first line: the update runs, the report goes, the credential is in no log (review of PR #42)', async () => {
    const w = await world({
      advertised: digests('b'),
      idleAfter: 2,
      credentialFile: `${CREDENTIAL}\nhttps://core.example.test\n`,
    });
    await w.updater.tick();
    expect(w.events).toContain('create apply');
    expect(w.authorizations[0]).toBe(`Bearer ${CREDENTIAL}`);
    // A refusal is reported with the same first line (`apply.ts`'s `reportResult`).
    const refused = await world({
      advertised: digests('b'),
      verifier: false,
      credentialFile: `${CREDENTIAL}\nhttps://core.example.test\n`,
    });
    await refused.updater.tick();
    expect(refused.reports).toHaveLength(1);
    expect(refused.authorizations.every((value) => value === `Bearer ${CREDENTIAL}`)).toBe(true);
    for (const line of [...w.logLines, ...refused.logLines]) expect(line).not.toContain(CREDENTIAL);
    // A credential recorded for another core is not this core's: nothing is asked with it — the
    // release is asked without one, as for a worker not approved yet, and nothing is reported.
    const other = await world({
      advertised: digests('b'),
      credentialFile: `${CREDENTIAL}\nhttps://other.example.test\n`,
    });
    await other.updater.tick();
    expect(other.events[0]).toBe('release');
    expect(other.authorizations).toEqual([]);
    expect(other.reports).toEqual([]);
  });

  it('follows the platform chosen on the worker’s page when APP_CORE_URL is empty (review of PR #42)', async () => {
    const w = await world({
      advertised: digests('a'),
      coreUrl: null,
      storedCoreUrl: 'https://core.example.test',
    });
    await w.updater.tick();
    expect(w.events).toEqual(['release']);
  });

  it('a transport failure never carries the bearer into the error a log line serialises (review of PR #42)', async () => {
    const bearer = `${CREDENTIAL}\nhttps://core.example.test`;
    const core = createCoreClient({
      baseUrl: 'https://core.example.test',
      fetch: async () => {
        // Node's own words for a refused header value name the value.
        throw new TypeError(`Headers.append: "Bearer ${bearer}" is an invalid header value.`);
      },
    });
    const error = await core.release(bearer).then(
      () => null,
      (caught: unknown) => caught as Error,
    );
    expect(error?.message).toContain('[REDACTED:bearer]');
    expect(error?.message).not.toContain(CREDENTIAL);
    expect(error?.stack ?? '').not.toContain(CREDENTIAL);
  });

  it('refuses by name without a verifier, verifying and pulling nothing', async () => {
    const w = await world({ advertised: digests('b'), verifier: false });
    await w.updater.tick();
    expect(w.verified).toEqual([]);
    expect(w.events).toEqual(['release', 'report']);
    expect(JSON.stringify(w.reports)).toContain('APP_TRUSTED_BUILDER is unset');
  });

  it('does nothing when the core advertises what it runs — and verifies nothing', async () => {
    const w = await world({ advertised: digests('a') });
    expect(await w.updater.tick()).toBe('ok');
    expect(w.events).toEqual(['release']);
    expect(w.reports).toEqual([]);
    expect(w.verified).toEqual([]);
  });

  it('does not verify an advertised set again while the core keeps advertising it (TD-032, 2026-11-06)', async () => {
    const w = await world({
      advertised: digests('b'),
      pullFailsOnce: true,
      applyEnds: 'succeeded',
    });
    // The first poll verifies the target's four and the running set's four, then the pull fails.
    expect(await w.updater.tick()).toBe('failed');
    expect(w.verified).toHaveLength(8);
    expect(w.events).toEqual(['release', 'pull failed']);
    // The same set again: nothing is verified a second time, and the update goes ahead.
    expect(await w.updater.tick()).toBe('ok');
    expect(w.verified).toHaveLength(8);
    expect(w.events).toContain('start apply');
    expect(w.reports).toEqual([]);
  });
});

describe('a worker that holds no credential yet follows its core all the same (2026-11-06)', () => {
  /** The `GET release` calls' headers, as the fake core received them. */
  const releaseHeaders = (w: Awaited<ReturnType<typeof world>>) =>
    w.authorizations.length === 0 ? 'no authorization header' : w.authorizations;

  it('asks the release without an authorization header and applies an advertised other set — verified, pulled, drained — reporting nothing', async () => {
    const w = await world({
      advertised: digests('b'),
      credentialFile: null,
      idleAfter: 1,
      applyEnds: 'succeeded',
    });
    expect(await w.updater.tick()).toBe('ok');
    expect(releaseHeaders(w)).toBe('no authorization header');
    expect(w.verified).toHaveLength(8);
    expect(w.events).toEqual([
      'release',
      ...Object.values(refsOf('b')).map((ref) => `pull ${ref}`),
      'drain',
      'create apply',
      'start apply',
    ]);
    expect(w.reports).toEqual([]);
    expect((await readState(w.stateDir))?.to_digests).toEqual(digests('b'));
  });

  it('still refuses a downgrade and an unverified set — and reports the refusal only once a credential exists, once', async () => {
    const w = await world({ advertised: digests('e'), credentialFile: null });
    await w.updater.tick();
    await w.updater.tick();
    // Refused (nothing pulled, nothing drained) and not reported: there is no credential to report with.
    expect(w.events).toEqual(['release', 'release']);
    expect(w.reports).toEqual([]);
    expect(w.logLines.join('\n')).toContain('the refusal is not reported now');
    // Approved: the next poll reports it, with the credential, and no later poll again.
    await writeFile(path.join(w.workerStateDir, 'credential'), CREDENTIAL);
    await w.updater.tick();
    await w.updater.tick();
    expect(w.reports).toEqual([expect.objectContaining({ result: 'failed', to: digests('e') })]);
    expect(JSON.stringify(w.reports)).toContain('downgrade is refused');
    expect(w.authorizations.every((value) => value === `Bearer ${CREDENTIAL}`)).toBe(true);
    expect(w.authorizations.length).toBeGreaterThan(0);
  });

  it('reports a terminal result the core was never told once the worker is approved — not at start-up without a credential, and only once', async () => {
    // The core advertises what runs, so no poll starts another apply over this state.
    const w = await world({ advertised: digests('a'), credentialFile: null });
    // What a succeeded apply leaves for a worker with no credential: `reported: false`.
    await writeFile(
      statePathOf(w.stateDir),
      JSON.stringify({
        id: '00000000-0000-4000-8000-000000000007',
        mode: 'update',
        step: 'done',
        result: 'succeeded',
        detail: null,
        from_digests: digests('a'),
        to_digests: digests('b'),
        from: refsOf('a'),
        to: refsOf('b'),
        started_at: '2026-11-05T11:00:00.000Z',
        finished_at: '2026-11-05T11:05:00.000Z',
        reported: false,
      }),
    );
    await w.updater.recover();
    await w.updater.tick();
    expect(w.reports).toEqual([]);
    expect((await readState(w.stateDir))?.reported).toBe(false);
    await writeFile(path.join(w.workerStateDir, 'credential'), CREDENTIAL);
    await w.updater.tick();
    await w.updater.tick();
    expect(w.reports).toEqual([
      { from: digests('a'), to: digests('b'), result: 'succeeded', detail: null },
    ]);
    expect((await readState(w.stateDir))?.reported).toBe(true);
  });

  it('with a credential, asks the release with it exactly as before', async () => {
    const w = await world({ advertised: digests('a') });
    await w.updater.tick();
    expect(w.authorizations).toEqual([`Bearer ${CREDENTIAL}`]);
  });
});

describe('the updater’s cadence (TD-032’s 2026-11-06 amendment)', () => {
  it('defaults to a poll every 60 s and keeps the variable and its bounds', () => {
    expect(DEFAULT_UPDATE_POLL_SECONDS).toBe(60);
    expect(loadUpdaterConfig({}).pollMs).toBe(60_000);
    expect(loadUpdaterConfig({ APP_UPDATE_POLL_SECONDS: '30' }).pollMs).toBe(30_000);
    expect(loadUpdaterConfig({ APP_UPDATE_POLL_SECONDS: '300' }).pollMs).toBe(300_000);
    expect(() => loadUpdaterConfig({ APP_UPDATE_POLL_SECONDS: '0' })).toThrow(
      /APP_UPDATE_POLL_SECONDS must be a whole number of seconds from 1 to 86400/,
    );
  });

  it('asks the core at once when it starts, before the first wait (as before the 2026-11-06 amendment)', async () => {
    const w = await world({ advertised: digests('a'), pollMs: 60_000, stopAfterReleases: 1 });
    await w.updater.run();
    expect(w.releaseAt).toEqual([0]);
  });

  it('then asks every interval while the polls work', async () => {
    const w = await world({ advertised: digests('a'), pollMs: 60_000, stopAfterReleases: 4 });
    await w.updater.run();
    expect(w.releaseAt).toEqual([0, 60_000, 120_000, 180_000]);
  });

  it('backs a failed poll off, doubling up to five minutes, and a poll that works resets it', async () => {
    const w = await world({
      advertised: digests('a'),
      pollMs: 60_000,
      releaseFailures: 4,
      stopAfterReleases: 6,
    });
    await w.updater.run();
    // 503 at 0 → wait 120 s; 503 → 240 s; 503 → 300 s (the cap); 503 → 300 s; works → 60 s.
    expect(w.releaseAt).toEqual([0, 120_000, 360_000, 660_000, 960_000, 1_020_000]);
  });

  it('reads an apply that did not end succeeded as a failed poll, and backs off one whose state cannot be read (review of PR #66)', async () => {
    const succeeded = await world({ advertised: digests('b'), applyEnds: 'succeeded' });
    expect(await succeeded.updater.tick()).toBe('ok');
    // Rolled back: failed, and the set is settled — the next poll neither drains nor applies.
    const rolledBack = await world({ advertised: digests('b'), applyEnds: 'rolled_back' });
    expect(await rolledBack.updater.tick()).toBe('failed');
    expect(await rolledBack.updater.tick()).toBe('ok');
    expect(rolledBack.events.filter((event) => event === 'drain')).toHaveLength(1);
    // Unreadable: nothing could settle the set, so each poll drains again — backed off, never every
    // minute.
    const unreadable = await world({
      advertised: digests('b'),
      applyEnds: 'unreadable',
      pollMs: 60_000,
      stopAfterReleases: 3,
    });
    await unreadable.updater.run();
    expect(unreadable.releaseAt).toEqual([0, 120_000, 360_000]);
  });

  it('reads a core that answers 503 as a failed poll', async () => {
    const w = await world({ advertised: digests('a'), releaseFailures: 1 });
    expect(await w.updater.tick()).toBe('failed');
    expect(await w.updater.tick()).toBe('ok');
  });

  it('computes the wait: the interval, doubled per consecutive failure, capped at five minutes or the interval', () => {
    expect(MAX_POLL_BACKOFF_MS).toBe(300_000);
    expect(nextPollDelayMs(60_000, 0)).toBe(60_000);
    expect(nextPollDelayMs(60_000, 1)).toBe(120_000);
    expect(nextPollDelayMs(60_000, 2)).toBe(240_000);
    expect(nextPollDelayMs(60_000, 3)).toBe(300_000);
    expect(nextPollDelayMs(60_000, 1_000)).toBe(300_000);
    expect(nextPollDelayMs(30_000, 1)).toBe(60_000);
    // An operator's longer interval is never shortened, and never stretched past itself.
    expect(nextPollDelayMs(600_000, 0)).toBe(600_000);
    expect(nextPollDelayMs(600_000, 3)).toBe(600_000);
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
      // The person's project by name, from their folder at the fixed mount path (S-22.21).
      project: {
        name: 'agentic-worker',
        workingDir: '/var/lib/platform/host-bundle',
        envFile: '/var/lib/platform/host-bundle/.env.worker',
      },
      hostBundleSource: '/home/dev/worker',
      image: refsOf('a').platform,
      networks: ['agentic-worker_default', 'agentic-worker_updater-docker'],
      updatesVolume: 'agentic-worker_updates',
      workerStateVolume: 'agentic-worker_worker-state',
    });
  });

  it('reads no host path off a label — a Windows working_dir and any env-file label change nothing — and refuses only what no apply can work from', async () => {
    const windows = {
      ...SELF,
      Config: {
        ...SELF.Config,
        Labels: {
          ...SELF.Config.Labels,
          'com.docker.compose.project.working_dir': 'C:\\Users\\dev\\agentic-worker',
          'com.docker.compose.project.environment_file':
            'C:\\Users\\dev\\agentic-worker\\.env.worker',
        },
      },
      Mounts: [
        {
          Type: 'bind',
          Source: '/run/desktop/mnt/host/c/Users/dev/agentic-worker',
          Destination: '/var/lib/platform/host-bundle',
        },
        ...SELF.Mounts.slice(1),
      ],
    };
    const config = {
      stateDir: '/var/lib/platform/updates',
      workerStateDir: '/var/lib/platform/worker-state',
    };
    const self = await discoverSelf(
      async () => ({ stdout: JSON.stringify([windows]), stderr: '' }),
      'self',
      config,
    );
    expect(self.project).toEqual({
      name: 'agentic-worker',
      workingDir: '/var/lib/platform/host-bundle',
      envFile: '/var/lib/platform/host-bundle/.env.worker',
    });
    expect(self.hostBundleSource).toBe('/run/desktop/mnt/host/c/Users/dev/agentic-worker');
    const inspected = (container: unknown) => async () => ({
      stdout: JSON.stringify([container]),
      stderr: '',
    });
    // What stays a refusal, each by name: a state no apply can work from.
    await expect(
      discoverSelf(inspected({ ...SELF, Mounts: SELF.Mounts.slice(1) }), 'self', config),
    ).rejects.toThrow(/not mounted at \/var\/lib\/platform\/host-bundle.*download it again/);
    await expect(
      discoverSelf(inspected({ ...SELF, Mounts: SELF.Mounts.slice(0, 1) }), 'self', config),
    ).rejects.toThrow(/no named volume is mounted at \/var\/lib\/platform\/updates/);
    await expect(
      discoverSelf(inspected({ ...SELF, Config: { Labels: {} } }), 'self', config),
    ).rejects.toThrow(/not a service of a compose project/);
    await expect(
      discoverSelf(
        inspected({ ...SELF, Config: { Labels: { 'com.docker.compose.project': 'My Worker' } } }),
        'self',
        config,
      ),
    ).rejects.toThrow(/"My Worker" is not one Compose accepts/);
    // The env file is kept current only as a file of the folder, and only one of them.
    const withEnvFiles = (environmentFile: string) =>
      inspected({
        ...SELF,
        Config: {
          ...SELF.Config,
          Labels: {
            ...SELF.Config.Labels,
            'com.docker.compose.project.environment_file': environmentFile,
          },
        },
      });
    await expect(
      discoverSelf(
        withEnvFiles('/home/dev/worker/.env,/home/dev/worker/.env.worker'),
        'self',
        config,
      ),
    ).rejects.toThrow(/2 env files/);
    await expect(
      discoverSelf(withEnvFiles('/etc/agentic/worker.env'), 'self', config),
    ).rejects.toThrow(/is not a file in its folder/);
    await expect(
      discoverSelf(withEnvFiles('/home/dev/worker/sub/.env'), 'self', config),
    ).rejects.toThrow(/is not a file in its folder/);
    const plain = await discoverSelf(
      inspected({
        ...SELF,
        Config: {
          ...SELF.Config,
          Labels: {
            'com.docker.compose.project': 'agentic-worker',
            'com.docker.compose.project.working_dir': '/home/dev/worker',
          },
        },
      }),
      'self',
      config,
    );
    expect(plain.project.envFile).toBe('/var/lib/platform/host-bundle/.env');
  });

  it('mounts the worker credential read-only into the apply', () => {
    const args = applyContainerArgs({
      self: {
        project: { name: 'p', workingDir: '/w', envFile: '/w/.env' },
        hostBundleSource: '/run/desktop/mnt/host/c/Users/dev/worker',
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
    // The folder at the fixed path, from the source Docker reported (S-22.21).
    expect(args.filter((arg) => arg.startsWith('type=bind'))).toEqual([
      'type=bind,source=/run/desktop/mnt/host/c/Users/dev/worker,target=/var/lib/platform/host-bundle',
    ]);
    // A source with a comma or a quote stays one CSV field.
    expect(mountSpec(['type=bind', 'source=/a,b', 'target=/t'])).toBe(
      'type=bind,"source=/a,b",target=/t',
    );
    expect(mountSpec(['source=/x"y'])).toBe('"source=/x""y"');
  });
});

describe('the updater’s liveness (backlog 981)', () => {
  it('writes its heartbeat before its first poll — the second by which the next is due — and stops on stop', async () => {
    const w = await world({ advertised: digests('a') });
    const done = w.updater.run();
    w.updater.stop();
    await done;
    // `now` is 12:00:00Z; the beat is good for three 30 s intervals.
    expect(await readFile(path.join(w.stateDir, HEARTBEAT_FILE), 'utf8')).toBe(
      `${Date.parse('2026-11-05T12:01:30Z') / 1000}\n`,
    );
    expect(HEARTBEAT_STALE_AFTER_MS).toBe(3 * HEARTBEAT_EVERY_MS);
  });
});
