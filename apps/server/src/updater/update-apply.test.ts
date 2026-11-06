/**
 * The apply (WP-287 (2)–(3)) against a fake Docker and a fake core/worker: what it runs, in which
 * order, with which environment — and that the project is named on **every** Compose call.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { silentLogger } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { renderWorkerCompose } from '../workers/compose.js';
import {
  carriedEnvironment,
  NOT_APPROVED_STEADY_MS,
  runApply,
  servicesToUp,
  variablesWithoutDefault,
  waitForHandshake,
} from './apply.js';
import type { DockerRun } from './docker.js';
import { managedReferencesOf, previousOf } from './env-file.js';
import { HOST_BUNDLE_MOUNT, PREVIOUS_TEMPLATE_FILE, readState, type UpdatePlan } from './plan.js';

const CLAUDE_TOKEN = 'FAKE-wp287-claude-token-not-a-credential';
const CREDENTIAL = `wkr_${'a'.repeat(26)}_${'b'.repeat(43)}`;
const digests = (hex: string) => ({
  platform: `sha256:${hex.repeat(64)}`,
  platform_launcher: `sha256:${hex.repeat(64)}`,
  platform_runtime: `sha256:${hex.repeat(64)}`,
  platform_egress: `sha256:${hex.repeat(64)}`,
});
const refs = (hex: string) => ({
  platform: `ghcr.io/acme/platform@sha256:${hex.repeat(64)}`,
  platform_launcher: `ghcr.io/acme/platform-launcher@sha256:${hex.repeat(64)}`,
  platform_runtime: `ghcr.io/acme/platform-runtime@sha256:${hex.repeat(64)}`,
  platform_egress: `ghcr.io/acme/platform-egress@sha256:${hex.repeat(64)}`,
});

/** The shipped template, as the new image carries it. */
const TEMPLATE = readFileSync(
  fileURLToPath(new URL('../../../../compose.worker.yml', import.meta.url)),
  'utf8',
);
/** What the core serves for build `hex` — and what the apply writes back into the folder. */
const rendered = (hex: string): string =>
  renderWorkerCompose(TEMPLATE, {
    digests: digests(hex),
    repository: 'ghcr.io/acme',
    coreUrl: 'https://core.example.test',
  });
/** The install folder as Docker Desktop for Windows reports a `C:\` bind mount's source. */
const FOLDER_SOURCE = '/run/desktop/mnt/host/c/Users/dev/agentic-worker';

/** A compose interpolation, `${inner}`, spelled so it is not read as a template placeholder. */
const ref = (inner: string): string => `$${'{'}${inner}}`;

/**
 * The template as `compose config --no-interpolate` answers it: the shipped services' shape. This is
 * the **image's** template (`APP_CORE_URL` with no default); the fake answers a rendered file with
 * {@link modelOfFile}, whose `APP_CORE_URL` defaults to the core's URL as the render writes it.
 */
const MODEL = {
  services: {
    'launcher-token': { restart: 'no' },
    'pull-runtime-image': { restart: 'no' },
    'remote-worker': {
      restart: 'unless-stopped',
      environment: {
        ROLE: 'remote-worker',
        APP_CORE_URL: ref('APP_CORE_URL:?set APP_CORE_URL'),
        CLAUDE_CODE_OAUTH_TOKEN: ref('CLAUDE_CODE_OAUTH_TOKEN:?set it'),
        APP_WORKER_CONCURRENCY: ref('APP_WORKER_CONCURRENCY:-1'),
        PLATFORM_IMAGE: ref('PLATFORM_IMAGE:-platform:dev'),
        LOG_LEVEL: ref('LOG_LEVEL:-info'),
      },
    },
    launcher: {
      restart: 'unless-stopped',
      environment: {
        APP_WORKSPACE_CONTROL_VOLUME: ref('APP_WORKER_CONTROL_VOLUME:-agentic-worker-ctl'),
      },
    },
    'docker-socket-proxy': { restart: 'unless-stopped' },
    updater: { restart: 'unless-stopped' },
    'updater-docker-proxy': { restart: 'unless-stopped' },
  },
};

/**
 * What `compose config --no-interpolate` answers for `file`: {@link MODEL} for the image's template,
 * and for a rendered file the same with the `${APP_CORE_URL:-<core>}` default the render wrote into it.
 */
const modelOfFile = (file: string, templatePath: string): typeof MODEL => {
  if (file === templatePath) return MODEL;
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return MODEL;
  }
  const core = /\$\{APP_CORE_URL:-([^}]+)\}/.exec(text)?.[1];
  if (core === undefined) return MODEL;
  const worker = MODEL.services['remote-worker'];
  return {
    services: {
      ...MODEL.services,
      'remote-worker': {
        ...worker,
        environment: { ...worker.environment, APP_CORE_URL: ref(`APP_CORE_URL:-${core}`) },
      },
    },
  };
};

interface Call {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const world = async (options: {
  readonly readyAfterUp?: (platform: string) => boolean;
  readonly pullFails?: boolean;
  readonly envFile?: string | null;
  /** The folder's compose file (default: the first install's, the core's render of build `a`). */
  readonly bundle?: string | null;
  /** Compose's `config_files` label on the worker (default: none recorded). */
  readonly configFiles?: string;
  /** The env file's name in the folder (default `.env`; the owner's clone uses `.env.worker`). */
  readonly envFileName?: string;
  /** `false`: no worker credential in `worker-state` — a worker not approved yet. */
  readonly credential?: boolean;
  /** `/readyz`'s `core_handshake` once the new build is up (default `ok`) and its `launcher`. */
  readonly readyzAs?: { readonly coreHandshake: string; readonly launcher?: string };
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'apply-'));
  const stateDir = await mkdtemp(path.join(tmpdir(), 'apply-state-'));
  const workerStateDir = await mkdtemp(path.join(tmpdir(), 'apply-worker-state-'));
  if (options.credential !== false) {
    await writeFile(path.join(workerStateDir, 'credential'), `${CREDENTIAL}\n`);
  }
  const envFile = path.join(directory, options.envFileName ?? '.env');
  if (options.envFile !== null) {
    await writeFile(envFile, options.envFile ?? 'LOG_LEVEL=debug\n');
  }
  // The image's template: the shipped one, outside the folder (it is in the new image).
  const templatePath = path.join(stateDir, '..', `image-template-${path.basename(stateDir)}.yml`);
  await writeFile(templatePath, TEMPLATE);
  const bundleFile = path.join(directory, 'compose.yaml');
  if (options.bundle !== null) await writeFile(bundleFile, options.bundle ?? rendered('a'));
  await writeFile(path.join(stateDir, PREVIOUS_TEMPLATE_FILE), '# the old image’s template\n');
  let workerImage = refs('a').platform;
  const calls: Call[] = [];
  const docker: DockerRun = async (args, runOptions = {}) => {
    calls.push({ args, env: { ...runOptions.env } });
    if (args.includes('config')) {
      const file = args[args.indexOf('-f') + 1] as string;
      return { stdout: JSON.stringify(modelOfFile(file, templatePath)), stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'ls') {
      return { stdout: 'c-worker\nc-launcher\nc-updater\n', stderr: '' };
    }
    if (args[0] === 'container' && args[1] === 'inspect') {
      return {
        stdout: JSON.stringify([
          {
            Id: 'c-worker',
            Config: {
              Image: workerImage,
              Env: [
                `APP_CORE_URL=https://core.example.test`,
                `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}`,
                'APP_WORKER_CONCURRENCY=2',
                'LOG_LEVEL=info',
                `PLATFORM_IMAGE=${workerImage}`,
              ],
              Labels: {
                'com.docker.compose.service': 'remote-worker',
                ...(options.configFiles === undefined
                  ? {}
                  : { 'com.docker.compose.project.config_files': options.configFiles }),
              },
            },
            State: { Running: true },
          },
          {
            Id: 'c-launcher',
            Config: {
              Env: ['APP_WORKSPACE_CONTROL_VOLUME=my-ctl'],
              Labels: { 'com.docker.compose.service': 'launcher' },
            },
            State: { Running: true },
          },
          {
            // The updater, with the install folder mounted as Docker Desktop for Windows reports it.
            Id: 'c-updater',
            Config: { Env: [], Labels: { 'com.docker.compose.service': 'updater' } },
            State: { Running: true },
            Mounts: [
              { Type: 'bind', Source: FOLDER_SOURCE, Destination: HOST_BUNDLE_MOUNT },
              { Type: 'volume', Name: 'agentic-worker-test_updates', Destination: stateDir },
            ],
          },
        ]),
        stderr: '',
      };
    }
    if (args.includes('pull') && options.pullFails === true) {
      throw new Error('pull: manifest unknown');
    }
    if (args.includes('up') && !args.includes('updater')) {
      workerImage = runOptions.env?.PLATFORM_IMAGE ?? workerImage;
    }
    return { stdout: '', stderr: '' };
  };
  const reports: unknown[] = [];
  let clock = Date.parse('2026-11-05T12:00:00Z');
  const fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/readyz') && options.readyzAs !== undefined) {
      const { coreHandshake, launcher } = options.readyzAs;
      const ready = coreHandshake === 'ok' && (launcher ?? 'ok') === 'ok';
      return new Response(
        JSON.stringify({ checks: { core_handshake: coreHandshake, launcher: launcher ?? 'ok' } }),
        { status: ready ? 200 : 503 },
      );
    }
    if (url.endsWith('/readyz')) {
      const ok = (options.readyAfterUp ?? (() => true))(workerImage);
      return new Response(
        JSON.stringify({ checks: { core_handshake: ok ? 'ok' : 'handshaking' } }),
        { status: ok ? 200 : 503 },
      );
    }
    if (url.endsWith('/api/worker/v1/update-report')) {
      reports.push(JSON.parse(String(init?.body)));
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${CREDENTIAL}`);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 404 });
  };
  const plan: UpdatePlan = {
    id: randomUUID(),
    mode: 'update',
    project: 'agentic-worker-test',
    working_dir: directory,
    env_file: envFile,
    from: refs('a'),
    to: refs('b'),
    from_digests: digests('a'),
    to_digests: digests('b'),
    core_url: 'https://core.example.test',
    worker_url: 'http://remote-worker:8080',
    check_seconds: 5,
  };
  const deps = {
    docker,
    fetch,
    logger: silentLogger,
    templatePath,
    stateDir,
    workerStateDir,
    now: () => {
      clock += 1_000;
      return new Date(clock);
    },
    sleep: async () => undefined,
  };
  return { calls, reports, plan, deps, envFile, stateDir, templatePath, bundleFile };
};

const composeCalls = (calls: readonly Call[]) => calls.filter((call) => call.args[0] === 'compose');
const verb = (call: Call): string => {
  const file = call.args.indexOf('-f');
  return call.args.slice(file + 2).join(' ');
};

describe('an update that comes up healthy', () => {
  it('pulls, pins, brings up all but the updater, checks, reports succeeded — and recreates the updater last', async () => {
    const w = await world({});
    const state = await runApply(w.plan, w.deps);
    expect(state).toMatchObject({ result: 'succeeded', step: 'done', reported: true });
    const steps = composeCalls(w.calls)
      .map(verb)
      .filter((line) => !line.startsWith('config'));
    expect(steps).toEqual([
      'pull --quiet',
      'up -d --wait --wait-timeout 5 docker-socket-proxy launcher remote-worker',
      'up -d --no-deps updater',
    ]);
    // Every Compose call names the project and its directory (TD-032 §4).
    for (const call of composeCalls(w.calls)) {
      expect(call.args.slice(0, 5)).toEqual([
        'compose',
        '--project-name',
        'agentic-worker-test',
        '--project-directory',
        w.plan.working_dir,
      ]);
    }
    // The pull asks for the new references; the up runs the template this image carries.
    const pull = composeCalls(w.calls).find((call) => verb(call) === 'pull --quiet');
    expect(pull?.env.PLATFORM_IMAGE).toBe(refs('b').platform);
    expect(pull?.args).toContain(w.templatePath);
    // The folder holds what runs (S-22.21): the new build's compose file, rendered from this image's
    // template, and the managed block — so the up runs that file, and so would the person's own.
    expect(await readFile(w.bundleFile, 'utf8')).toBe(rendered('b'));
    const up = composeCalls(w.calls).find((call) => verb(call).startsWith('up -d --wait'));
    expect(up?.args).toContain(w.bundleFile);
    expect(up?.args).not.toContain(w.templatePath);
    expect(managedReferencesOf(await readFile(w.envFile, 'utf8'))).toEqual(refs('b'));
    expect(await readFile(previousOf(w.envFile), 'utf8')).toBe('LOG_LEVEL=debug\n');
    expect(w.reports).toEqual([
      { from: digests('a'), to: digests('b'), result: 'succeeded', detail: null },
    ]);
    expect(await readState(w.stateDir)).toMatchObject({ result: 'succeeded', reported: true });
  });

  it('carries the shell’s values over through the environment only — never an argument, never the env file', async () => {
    const w = await world({});
    await runApply(w.plan, w.deps);
    const up = composeCalls(w.calls).find((call) => verb(call).startsWith('up -d --wait'));
    expect(up?.env).toMatchObject({ CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN });
    // A setting the template has a default for follows the template, whatever the container held.
    expect(up?.env.APP_WORKER_CONCURRENCY).toBeUndefined();
    expect(up?.env.APP_WORKER_CONTROL_VOLUME).toBeUndefined();
    // LOG_LEVEL is the env file's: the file wins over what the container had.
    expect(up?.env.LOG_LEVEL).toBeUndefined();
    for (const call of w.calls) {
      expect(call.args.join(' ')).not.toContain(CLAUDE_TOKEN);
    }
    expect(await readFile(w.envFile, 'utf8')).not.toContain(CLAUDE_TOKEN);
    expect(JSON.stringify(await readState(w.stateDir))).not.toContain(CLAUDE_TOKEN);
  });

  it('the rendered file’s core URL is the plan’s, never carried from the running worker', async () => {
    const w = await world({});
    const coreUrl = 'https://new-core.example.test';
    await runApply({ ...w.plan, core_url: coreUrl }, w.deps);
    const up = composeCalls(w.calls).find((call) => verb(call).startsWith('up -d --wait'));
    expect(up?.args).toContain(w.bundleFile);
    // The running worker held `https://core.example.test`; the render's default is the plan's.
    expect(await readFile(w.bundleFile, 'utf8')).toContain(ref(`APP_CORE_URL:-${coreUrl}`));
    expect(up?.env.APP_CORE_URL).toBeUndefined();
  });
});

describe('an update that does not come up', () => {
  it('rolls back to the previous env file and template, checks again and reports rolled_back; the updater stays', async () => {
    const w = await world({ readyAfterUp: (platform) => platform === refs('a').platform });
    const state = await runApply(w.plan, w.deps);
    expect(state).toMatchObject({ result: 'rolled_back', reported: true });
    expect(state.detail).toContain('core_handshake');
    const ups = composeCalls(w.calls).filter((call) => verb(call).startsWith('up '));
    expect(ups.map(verb)).toEqual([
      'up -d --wait --wait-timeout 5 docker-socket-proxy launcher remote-worker',
      'up -d --wait --wait-timeout 5 docker-socket-proxy launcher remote-worker',
    ]);
    // The folder's own files back, byte for byte, and the rollback's up runs them.
    expect(ups[1]?.args).toContain(w.bundleFile);
    expect(await readFile(w.bundleFile, 'utf8')).toBe(rendered('a'));
    // The worker is restarted after the rollback's up: if that up left it as it was, it is still the
    // drained process (review of PR #38). Its next start clears a drain's pause, and only a drain's.
    expect(
      composeCalls(w.calls)
        .map(verb)
        .filter((line) => !line.startsWith('config')),
    ).toEqual([
      'pull --quiet',
      'up -d --wait --wait-timeout 5 docker-socket-proxy launcher remote-worker',
      'up -d --wait --wait-timeout 5 docker-socket-proxy launcher remote-worker',
      'restart remote-worker',
    ]);
    expect(ups[1]?.env.PLATFORM_IMAGE).toBe(refs('a').platform);
    expect(await readFile(w.envFile, 'utf8')).toBe('LOG_LEVEL=debug\n');
    expect(w.reports).toEqual([
      expect.objectContaining({ result: 'rolled_back', from: digests('a'), to: digests('b') }),
    ]);
  });

  it('reports failed when the rollback does not come back either', async () => {
    const w = await world({ readyAfterUp: () => false });
    const state = await runApply(w.plan, w.deps);
    expect(state.result).toBe('failed');
    expect(state.detail).toContain('the rollback did not come back either');
  });

  it('changes nothing when the pull fails — and restarts the drained worker', async () => {
    const w = await world({ pullFails: true });
    const state = await runApply(w.plan, w.deps);
    expect(state).toMatchObject({ result: 'failed', reported: true });
    expect(state.detail).toContain('nothing changed');
    expect(await readFile(w.envFile, 'utf8')).toBe('LOG_LEVEL=debug\n');
    await expect(stat(previousOf(w.envFile))).rejects.toThrow();
    expect(await readFile(w.bundleFile, 'utf8')).toBe(rendered('a'));
    expect(
      composeCalls(w.calls)
        .map(verb)
        .filter((line) => !line.startsWith('config')),
    ).toEqual(['pull --quiet', 'restart remote-worker']);
  });

  it('rolls back a crashed apply from the image it runs (mode rollback)', async () => {
    const w = await world({ readyAfterUp: (platform) => platform === refs('a').platform });
    await writeFile(w.envFile, 'LOG_LEVEL=debug\n# a half-written block\n');
    await writeFile(previousOf(w.envFile), 'LOG_LEVEL=debug\n');
    const state = await runApply({ ...w.plan, mode: 'rollback' }, w.deps);
    expect(state.result).toBe('rolled_back');
    expect(await readFile(w.envFile, 'utf8')).toBe('LOG_LEVEL=debug\n');
    const up = composeCalls(w.calls).find((call) => verb(call).startsWith('up '));
    expect(up?.args).toContain(w.templatePath);
    expect(up?.env.PLATFORM_IMAGE).toBe(refs('a').platform);
    expect(composeCalls(w.calls).map(verb)).toContain('restart remote-worker');
  });
});

describe('an update of a worker that holds no credential yet (2026-11-06)', () => {
  it('is good while the new build waits for its Claude sign-in or its approval — not reported, left for the updater', async () => {
    for (const coreHandshake of ['needs_claude', 'logging_in']) {
      const w = await world({ credential: false, readyzAs: { coreHandshake } });
      // Room for the steady reads the check asks of such a worker (NOT_APPROVED_STEADY_MS).
      const state = await runApply({ ...w.plan, check_seconds: 30 }, w.deps);
      expect(state, coreHandshake).toMatchObject({ result: 'succeeded', reported: false });
      // No update-report call at all: there is no credential to make it with.
      expect(w.reports).toEqual([]);
      expect(composeCalls(w.calls).map(verb).at(-1)).toBe('up -d --no-deps updater');
      expect(await readState(w.stateDir)).toMatchObject({ result: 'succeeded', reported: false });
    }
  });

  it('still rolls back a new build whose launcher does not answer, or that lost its platform', async () => {
    for (const readyzAs of [
      { coreHandshake: 'needs_claude', launcher: 'unreachable' },
      { coreHandshake: 'needs_platform' },
      { coreHandshake: 'core_unreachable' },
    ]) {
      const w = await world({ credential: false, readyzAs });
      const state = await runApply({ ...w.plan, check_seconds: 30 }, w.deps);
      expect(state.result, JSON.stringify(readyzAs)).not.toBe('succeeded');
      expect(state.detail).toContain('needs_claude or logging_in');
      expect(w.reports).toEqual([]);
    }
  });

  it('an approved worker that reads needs_claude is not done: it must hand-shake, as before', async () => {
    const w = await world({ readyzAs: { coreHandshake: 'needs_claude' } });
    const state = await runApply(w.plan, w.deps);
    expect(state.result).not.toBe('succeeded');
    expect(state.detail).not.toContain('needs_claude or logging_in');
    expect(w.reports).toEqual([expect.objectContaining({ result: state.result })]);
  });
});

describe('the apply’s check waits for the worker’s launcher too (backlog 980)', () => {
  /** A worker whose `/readyz` answers each body of `answers` in turn, the last one for ever. */
  const readyz = (answers: readonly { status: number; checks: Record<string, string> }[]) => {
    let calls = 0;
    let clock = 0;
    return {
      calls: () => calls,
      deps: {
        fetch: async () => {
          const answer = answers[Math.min(calls, answers.length - 1)] as (typeof answers)[number];
          calls += 1;
          return new Response(JSON.stringify({ checks: answer.checks }), {
            status: answer.status,
          });
        },
        sleep: async () => {
          clock += 2_000;
        },
        now: () => new Date(clock),
      },
    };
  };

  it('is not done while the worker is connected but its launcher does not answer, and is once it does', async () => {
    const worker = readyz([
      { status: 503, checks: { core_handshake: 'ok', launcher: 'unreachable' } },
      { status: 503, checks: { core_handshake: 'ok', launcher: 'unreachable' } },
      { status: 200, checks: { core_handshake: 'ok', launcher: 'ok' } },
    ]);
    const result = await waitForHandshake(worker.deps, 'http://remote-worker:8080', 60);
    expect(result).toEqual({ ok: true, last: '200 core_handshake=ok launcher=ok' });
    expect(worker.calls()).toBe(3);
  });

  it('fails the check — so the update rolls back — when the launcher never answers', async () => {
    const worker = readyz([
      { status: 200, checks: { core_handshake: 'ok', launcher: 'unreachable' } },
    ]);
    const result = await waitForHandshake(worker.deps, 'http://remote-worker:8080', 10);
    expect(result).toEqual({ ok: false, last: '200 core_handshake=ok launcher=unreachable' });
  });

  it('accepts needs_claude or logging_in only for a worker that holds no credential', async () => {
    for (const handshake of ['needs_claude', 'logging_in']) {
      const waiting = readyz([
        { status: 503, checks: { core_handshake: handshake, launcher: 'ok' } },
      ]);
      expect(
        await waitForHandshake(waiting.deps, 'http://remote-worker:8080', 10, {
          notApproved: true,
        }),
      ).toEqual({ ok: true, last: `503 core_handshake=${handshake} launcher=ok` });
      const approved = readyz([
        { status: 503, checks: { core_handshake: handshake, launcher: 'ok' } },
      ]);
      expect((await waitForHandshake(approved.deps, 'http://remote-worker:8080', 10)).ok).toBe(
        false,
      );
    }
    const unknown = readyz([
      { status: 503, checks: { core_handshake: 'needs_claude', launcher: 'unknown' } },
    ]);
    expect(
      (await waitForHandshake(unknown.deps, 'http://remote-worker:8080', 10, { notApproved: true }))
        .ok,
    ).toBe(false);
  });

  it('does not take a not-approved build that answers once and then crash-loops', async () => {
    let calls = 0;
    let clock = 0;
    const deps = {
      fetch: async () => {
        calls += 1;
        // Up, then gone, then up again — never steady for NOT_APPROVED_STEADY_MS.
        if (calls % 2 === 0) throw new Error('connect ECONNREFUSED remote-worker:8080');
        return new Response(
          JSON.stringify({ checks: { core_handshake: 'needs_claude', launcher: 'ok' } }),
          { status: 503 },
        );
      },
      sleep: async () => {
        clock += 2_000;
      },
      now: () => new Date(clock),
    };
    const result = await waitForHandshake(deps, 'http://remote-worker:8080', 30, {
      notApproved: true,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBeGreaterThan(10);
    // Steady from the first read: taken once NOT_APPROVED_STEADY_MS has passed, not before.
    const steady = readyz([
      { status: 503, checks: { core_handshake: 'needs_claude', launcher: 'ok' } },
    ]);
    expect(
      (await waitForHandshake(steady.deps, 'http://remote-worker:8080', 30, { notApproved: true }))
        .ok,
    ).toBe(true);
    expect(steady.calls()).toBe(Math.ceil(NOT_APPROVED_STEADY_MS / 2_000) + 1);
  });

  it('accepts a worker build that reports no launcher check (a rollback to one before it)', async () => {
    const worker = readyz([{ status: 200, checks: { core_handshake: 'ok' } }]);
    const result = await waitForHandshake(worker.deps, 'http://remote-worker:8080', 10);
    expect(result).toEqual({ ok: true, last: '200 core_handshake=ok launcher=absent' });
  });
});

describe('the install folder, kept current (S-22.21, TD-032 decision 4, backlog 990)', () => {
  it('the shipped template mounts the folder into the updater, and only there, at the fixed path the apply uses', () => {
    const mount = `- ${ref('APP_WORKER_BUNDLE_DIR:-.')}:${HOST_BUNDLE_MOUNT}`;
    const services = TEMPLATE.split(/\n {2}(?=[a-z][a-z-]*:\n)/);
    const mounting = services.filter((block) => block.includes(mount)).map((b) => b.split(':')[0]);
    expect(mounting).toEqual(['updater']);
    // Rendering for a first install leaves the mount as it is.
    expect(rendered('a')).toContain(mount);
  });

  it('hands Docker back the folder source it reported for the updater’s mount (a Windows folder), on every Compose call', async () => {
    const w = await world({});
    await runApply(w.plan, w.deps);
    // Every call that reaches the daemon: `config --no-interpolate` only reads the file.
    const calls = composeCalls(w.calls).filter((call) => !call.args.includes('config'));
    expect(calls.length).toBeGreaterThan(2);
    // From the folder as project directory, `${APP_WORKER_BUNDLE_DIR:-.}` would name the
    // container's path; the recreated updater must mount the person's folder again.
    for (const call of calls) expect(call.env.APP_WORKER_BUNDLE_DIR).toBe(FOLDER_SOURCE);
    // A source Docker reported is passed through as a value, never as an argument.
    for (const call of calls) expect(call.args.join(' ')).not.toContain(FOLDER_SOURCE);
  });

  it('leaves the folder so a person’s own `docker compose up` there cannot go back: its file and its .env pin the build that runs', async () => {
    const w = await world({});
    await runApply(w.plan, w.deps);
    const file = await readFile(w.bundleFile, 'utf8');
    const env = await readFile(w.envFile, 'utf8');
    for (const [key, variable] of [
      ['platform', 'PLATFORM_IMAGE'],
      ['platform_launcher', 'PLATFORM_LAUNCHER_IMAGE'],
      ['platform_runtime', 'PLATFORM_RUNTIME_IMAGE'],
      ['platform_egress', 'PLATFORM_EGRESS_IMAGE'],
    ] as const) {
      // The file's default and the env file's block both name the new build; neither the old.
      expect(file).toContain(`${ref(`${variable}:-${refs('b')[key]}`)}`);
      expect(file).not.toContain(refs('a')[key]);
      expect(env).toContain(`${variable}=${refs('b')[key]}`);
    }
    // The person's own line is kept.
    expect(env).toContain('LOG_LEVEL=debug');
  });

  it('writes compose.yaml into a folder that had none, and a rollback removes it again', async () => {
    const w = await world({
      bundle: null,
      readyAfterUp: (platform) => platform === refs('a').platform,
    });
    const state = await runApply(w.plan, w.deps);
    expect(state.result).toBe('rolled_back');
    await expect(stat(w.bundleFile)).rejects.toThrow();
    // With no compose file of its own, the rollback runs the previous image's template.
    const ups = composeCalls(w.calls).filter((call) => verb(call).startsWith('up '));
    expect(ups[1]?.args).toContain(path.join(w.stateDir, PREVIOUS_TEMPLATE_FILE));
  });

  it('rewrites the file Compose recorded it ran — by its name only, from a Windows label', async () => {
    const w = await world({
      bundle: null,
      configFiles: 'C:\\Users\\dev\\agentic-worker\\my-worker.yml',
    });
    const own = path.join(path.dirname(w.bundleFile), 'my-worker.yml');
    await writeFile(own, rendered('a'));
    await runApply(w.plan, w.deps);
    expect(await readFile(own, 'utf8')).toBe(rendered('b'));
    await expect(stat(w.bundleFile)).rejects.toThrow();
  });

  it('never rewrites another project’s compose file in the folder', async () => {
    const w = await world({ bundle: null });
    const core = path.join(path.dirname(w.bundleFile), 'compose.yml');
    await writeFile(core, 'services:\n  app:\n    image: postgres\n');
    await runApply(w.plan, w.deps);
    expect(await readFile(core, 'utf8')).toBe('services:\n  app:\n    image: postgres\n');
    expect(await readFile(w.bundleFile, 'utf8')).toBe(rendered('b'));
  });

  it('leaves a git checkout’s tracked files alone: the env file is pinned, the image’s template runs', async () => {
    const w = await world({});
    await mkdir(path.join(path.dirname(w.bundleFile), '.git'));
    const state = await runApply(w.plan, w.deps);
    expect(state.result).toBe('succeeded');
    expect(await readFile(w.bundleFile, 'utf8')).toBe(rendered('a'));
    expect(managedReferencesOf(await readFile(w.envFile, 'utf8'))).toEqual(refs('b'));
    const up = composeCalls(w.calls).find((call) => verb(call).startsWith('up -d --wait'));
    expect(up?.args).toContain(w.templatePath);
  });

  it('keeps the person’s own file name (compose.worker.yml, the old README’s)', async () => {
    const w = await world({ bundle: null });
    const own = path.join(path.dirname(w.bundleFile), 'compose.worker.yml');
    await writeFile(own, rendered('a'));
    await runApply(w.plan, w.deps);
    expect(await readFile(own, 'utf8')).toBe(rendered('b'));
    await expect(stat(w.bundleFile)).rejects.toThrow();
  });
});

describe('the owner’s layout and a write that fails (review of PR #57)', () => {
  it('a clone run with --env-file .env.worker -f compose.worker.yml: only .env.worker is pinned; .env and the tracked file stay byte for byte', async () => {
    const w = await world({
      bundle: null,
      envFileName: '.env.worker',
      configFiles: '/Users/dev/www/agentic-platform/compose.worker.yml',
    });
    const folder = path.dirname(w.bundleFile);
    await mkdir(path.join(folder, '.git'));
    // The core's own .env beside it, which the worker must never read or be written into.
    const coreEnv = `${'# the core\nLOG_LEVEL=trace\n'.repeat(2_000)}APP_WORKSPACE_GIT_IMAGE=core-only\n`;
    await writeFile(path.join(folder, '.env'), coreEnv);
    const tracked = path.join(folder, 'compose.worker.yml');
    await writeFile(tracked, TEMPLATE);
    const state = await runApply(w.plan, w.deps);
    expect(state.result).toBe('succeeded');
    expect(await readFile(path.join(folder, '.env'), 'utf8')).toBe(coreEnv);
    await expect(stat(path.join(folder, '.env.previous'))).rejects.toThrow();
    expect(await readFile(tracked, 'utf8')).toBe(TEMPLATE);
    expect(w.envFile).toBe(path.join(folder, '.env.worker'));
    expect(managedReferencesOf(await readFile(w.envFile, 'utf8'))).toEqual(refs('b'));
    expect(await readFile(previousOf(w.envFile), 'utf8')).toBe('LOG_LEVEL=debug\n');
    const up = composeCalls(w.calls).find((call) => verb(call).startsWith('up -d --wait'));
    expect(up?.args.slice(5, 7)).toEqual(['--env-file', w.envFile]);
    expect(up?.args).toContain(w.templatePath);
    // The core's values reach no Compose call: the worker's env file is the only one read.
    for (const call of composeCalls(w.calls)) {
      expect(call.env.APP_WORKSPACE_GIT_IMAGE).toBeUndefined();
      expect(call.args).not.toContain(path.join(folder, '.env'));
    }
  });

  it('a compose file that cannot be written leaves the folder as it was — the pinned .env put back — and reports failed', async () => {
    const w = await world({});
    const folder = path.dirname(w.bundleFile);
    // Its temporary file is a directory: the atomic write fails, as on a Windows editor's lock.
    await mkdir(path.join(folder, `.compose.yaml.updater-${process.pid}`));
    const state = await runApply(w.plan, w.deps);
    expect(state).toMatchObject({ result: 'failed', reported: true });
    expect(state.detail).toContain('could not be written, so nothing of it was changed');
    expect(await readFile(w.envFile, 'utf8')).toBe('LOG_LEVEL=debug\n');
    expect(await readFile(w.bundleFile, 'utf8')).toBe(rendered('a'));
    expect(
      composeCalls(w.calls)
        .map(verb)
        .filter((line) => !line.startsWith('config')),
    ).toEqual(['pull --quiet', 'restart remote-worker']);
  });

  it('a folder that cannot be put back either is reported as such, never swallowed', async () => {
    const w = await world({});
    const folder = path.dirname(w.bundleFile);
    await mkdir(path.join(folder, `.compose.yaml.updater-${process.pid}`));
    // `copyFileAtomically`'s temporary name: `.<file name>.restore-<pid>` (`..env.restore-…` for `.env`).
    await mkdir(path.join(folder, `.${path.basename(w.envFile)}.restore-${process.pid}`));
    const state = await runApply(w.plan, w.deps);
    expect(state.result).toBe('failed');
    expect(state.detail).toContain('could not be put back (the env file:');
    expect(w.reports).toEqual([
      expect.objectContaining({ result: 'failed', detail: expect.stringContaining('put back') }),
    ]);
  });

  it('never overwrites a compose.yaml that is not a worker bundle, and reads one saved with CRLF as one', async () => {
    const w = await world({ bundle: 'services:\n  db:\n    image: postgres\n' });
    await runApply(w.plan, w.deps);
    expect(await readFile(w.bundleFile, 'utf8')).toBe('services:\n  db:\n    image: postgres\n');
    expect(managedReferencesOf(await readFile(w.envFile, 'utf8'))).toEqual(refs('b'));
    const crlf = await world({ bundle: rendered('a').replaceAll('\n', '\r\n') });
    await runApply(crlf.plan, crlf.deps);
    expect(await readFile(crlf.bundleFile, 'utf8')).toBe(rendered('b'));
  });
});

describe('the pure pieces', () => {
  it('brings up every long-running service but the updater and its proxy', () => {
    expect(servicesToUp(MODEL)).toEqual(['docker-socket-proxy', 'launcher', 'remote-worker']);
  });

  it('carries a whole-value reference only, never a managed key, never one the env file sets', () => {
    const running = new Map([
      [
        'remote-worker',
        new Map([
          ['CLAUDE_CODE_OAUTH_TOKEN', CLAUDE_TOKEN],
          ['PLATFORM_IMAGE', 'old'],
          ['APP_CORE_URL', 'https://core.example.test'],
        ]),
      ],
    ]);
    expect(carriedEnvironment(MODEL, running, new Set(['APP_CORE_URL']))).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
    });
  });

  /** One service's environment, uninterpolated, as `compose config --no-interpolate` answers it. */
  const modelOf = (environment: Record<string, string>) => ({
    services: { updater: { restart: 'unless-stopped', environment } },
  });
  const runningAs = (environment: Record<string, string>) =>
    new Map([['updater', new Map(Object.entries(environment))]]);

  it('never carries a variable the template has a non-empty default for, whatever the container holds', () => {
    const model = modelOf({
      APP_UPDATE_POLL_SECONDS: ref('APP_UPDATE_POLL_SECONDS:-60'),
      APP_UPDATE_CHECK_SECONDS: ref('APP_UPDATE_CHECK_SECONDS-120'),
    });
    // The 2026-11-06 defect: an older template's default, `300`, baked in as if a person chose it.
    const running = runningAs({ APP_UPDATE_POLL_SECONDS: '300', APP_UPDATE_CHECK_SECONDS: '90' });
    expect(carriedEnvironment(model, running, new Set())).toEqual({});
  });

  it('carries a variable the template declares with no default — the shell’s token', () => {
    const model = modelOf({
      CLAUDE_CODE_OAUTH_TOKEN: ref('CLAUDE_CODE_OAUTH_TOKEN'),
      APP_CORE_URL: ref('APP_CORE_URL:?set APP_CORE_URL'),
      APP_WORKER_CORE_CANDIDATES: ref('APP_WORKER_CORE_CANDIDATES?set it'),
    });
    const running = runningAs({
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      APP_CORE_URL: 'https://core.example.test',
      APP_WORKER_CORE_CANDIDATES: 'https://a.example.test',
    });
    expect(carriedEnvironment(model, running, new Set())).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      APP_CORE_URL: 'https://core.example.test',
      APP_WORKER_CORE_CANDIDATES: 'https://a.example.test',
    });
  });

  it('carries an empty default, `:-` and `-`, as no default', () => {
    const model = modelOf({
      CLAUDE_CODE_OAUTH_TOKEN: ref('CLAUDE_CODE_OAUTH_TOKEN:-'),
      SENTRY_DSN: ref('SENTRY_DSN-'),
    });
    const running = runningAs({
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      SENTRY_DSN: 'https://sentry.example.test/1',
    });
    expect(carriedEnvironment(model, running, new Set())).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      SENTRY_DSN: 'https://sentry.example.test/1',
    });
  });

  it('carries a variable used twice, once with a default and once without — from the use with none', () => {
    const model = {
      services: {
        launcher: {
          restart: 'unless-stopped',
          environment: { APP_WORKSPACE_CONTROL_VOLUME: ref('APP_WORKER_CONTROL_VOLUME:-ctl') },
        },
        updater: {
          restart: 'unless-stopped',
          environment: { CONTROL_VOLUME: ref('APP_WORKER_CONTROL_VOLUME') },
        },
      },
    };
    const running = new Map([
      ['launcher', new Map([['APP_WORKSPACE_CONTROL_VOLUME', 'from-the-defaulted-use']])],
      ['updater', new Map([['CONTROL_VOLUME', 'my-ctl']])],
    ]);
    expect(carriedEnvironment(model, running, new Set())).toEqual({
      APP_WORKER_CONTROL_VOLUME: 'my-ctl',
    });
    // A use inside a longer value counts as a use too, though it is no source.
    const embedded = modelOf({
      APP_UPDATE_POLL_SECONDS: ref('APP_UPDATE_POLL_SECONDS:-60'),
      NOTE: `every ${ref('APP_UPDATE_POLL_SECONDS')} s, $$HOME stays literal`,
    });
    expect(variablesWithoutDefault(embedded)).toEqual(new Set(['APP_UPDATE_POLL_SECONDS']));
    expect(
      carriedEnvironment(embedded, runningAs({ APP_UPDATE_POLL_SECONDS: '300' }), new Set()),
    ).toEqual({ APP_UPDATE_POLL_SECONDS: '300' });
  });

  it('never takes a `:+`/`+` use as a source: the container holds the alternative, not the variable', () => {
    const model = modelOf({
      TOKEN_SET: ref('CLAUDE_CODE_OAUTH_TOKEN:+yes'),
      TOKEN_ALSO_SET: ref('CLAUDE_CODE_OAUTH_TOKEN+yes'),
      NOTE: `token ${ref('CLAUDE_CODE_OAUTH_TOKEN')}`,
    });
    const running = runningAs({ TOKEN_SET: 'yes', TOKEN_ALSO_SET: 'yes', NOTE: 'token x' });
    expect(variablesWithoutDefault(model)).toEqual(new Set(['CLAUDE_CODE_OAUTH_TOKEN']));
    expect(carriedEnvironment(model, running, new Set())).toEqual({});
  });

  it('never carries a variable the env file sets, defaulted or not', () => {
    const model = modelOf({
      CLAUDE_CODE_OAUTH_TOKEN: ref('CLAUDE_CODE_OAUTH_TOKEN:-'),
      APP_UPDATE_POLL_SECONDS: ref('APP_UPDATE_POLL_SECONDS:-60'),
    });
    const running = runningAs({
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      APP_UPDATE_POLL_SECONDS: '300',
    });
    expect(
      carriedEnvironment(
        model,
        running,
        new Set(['CLAUDE_CODE_OAUTH_TOKEN', 'APP_UPDATE_POLL_SECONDS']),
      ),
    ).toEqual({});
  });
});
