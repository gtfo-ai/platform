/**
 * The apply (WP-287 (2)–(3)) against a fake Docker and a fake core/worker: what it runs, in which
 * order, with which environment — and that the project is named on **every** Compose call.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { silentLogger } from '@platform/application';
import { describe, expect, it } from 'vitest';
import { carriedEnvironment, runApply, servicesToUp, waitForHandshake } from './apply.js';
import type { DockerRun } from './docker.js';
import { managedReferencesOf, previousOf } from './env-file.js';
import { PREVIOUS_TEMPLATE_FILE, readState, type UpdatePlan } from './plan.js';

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

/** A compose interpolation, `${inner}`, spelled so it is not read as a template placeholder. */
const ref = (inner: string): string => `$${'{'}${inner}}`;

/** The template as `compose config --no-interpolate` answers it: the shipped services' shape. */
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

interface Call {
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

const world = async (options: {
  readonly readyAfterUp?: (platform: string) => boolean;
  readonly pullFails?: boolean;
  readonly envFile?: string | null;
}) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'apply-'));
  const stateDir = await mkdtemp(path.join(tmpdir(), 'apply-state-'));
  const workerStateDir = await mkdtemp(path.join(tmpdir(), 'apply-worker-state-'));
  await writeFile(path.join(workerStateDir, 'credential'), `${CREDENTIAL}\n`);
  const envFile = path.join(directory, '.env');
  if (options.envFile !== null) {
    await writeFile(envFile, options.envFile ?? 'LOG_LEVEL=debug\n');
  }
  const templatePath = path.join(directory, 'image-template.yml');
  await writeFile(templatePath, '# the new image’s template\n');
  await writeFile(path.join(stateDir, PREVIOUS_TEMPLATE_FILE), '# the old image’s template\n');
  let workerImage = refs('a').platform;
  const calls: Call[] = [];
  const docker: DockerRun = async (args, runOptions = {}) => {
    calls.push({ args, env: { ...runOptions.env } });
    if (args.includes('config')) return { stdout: JSON.stringify(MODEL), stderr: '' };
    if (args[0] === 'container' && args[1] === 'ls') {
      return { stdout: 'c-worker\nc-launcher\n', stderr: '' };
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
              Labels: { 'com.docker.compose.service': 'remote-worker' },
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
  return { calls, reports, plan, deps, envFile, stateDir, templatePath };
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
    expect(up?.env).toMatchObject({
      CLAUDE_CODE_OAUTH_TOKEN: CLAUDE_TOKEN,
      APP_CORE_URL: 'https://core.example.test',
      APP_WORKER_CONCURRENCY: '2',
      APP_WORKER_CONTROL_VOLUME: 'my-ctl',
    });
    // LOG_LEVEL is the env file's: the file wins over what the container had.
    expect(up?.env.LOG_LEVEL).toBeUndefined();
    for (const call of w.calls) {
      expect(call.args.join(' ')).not.toContain(CLAUDE_TOKEN);
    }
    expect(await readFile(w.envFile, 'utf8')).not.toContain(CLAUDE_TOKEN);
    expect(JSON.stringify(await readState(w.stateDir))).not.toContain(CLAUDE_TOKEN);
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
    expect(ups[1]?.args).toContain(path.join(w.stateDir, PREVIOUS_TEMPLATE_FILE));
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

  it('accepts a worker build that reports no launcher check (a rollback to one before it)', async () => {
    const worker = readyz([{ status: 200, checks: { core_handshake: 'ok' } }]);
    const result = await waitForHandshake(worker.deps, 'http://remote-worker:8080', 10);
    expect(result).toEqual({ ok: true, last: '200 core_handshake=ok launcher=absent' });
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
});
