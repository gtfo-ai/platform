#!/usr/bin/env node
/**
 * `pnpm worker:dev` — the worker's **dev mode** (S-22.16): `compose.worker.yml` run from this
 * checkout, with `compose.worker.dev.yml` on top, against the local `pnpm dev` core (or Autix).
 *
 *   pnpm worker:dev [up] [--no-build]   build the images from the working tree, then `up -d`
 *   pnpm worker:dev ui                  the local page from Vite (hot reload), `/api/local` proxied
 *   pnpm worker:dev logs|ps|down [...]  the same compose command; extra arguments are passed on
 *
 * Every compose call is `docker compose -p agentic-worker-dev --env-file .env.worker -f
 * compose.worker.yml -f compose.worker.dev.yml …`, so a dev worker is a compose project of its own
 * and never touches a prod worker's (`agentic-worker`) containers, volumes or network.
 * `APP_WORKER_DEV_ENV_FILE` names another settings file (a scratch one for a trial).
 *
 * **Idempotent.** `up` builds through `scripts/build-images.mjs` — all five images, `:dev` tags —
 * and Docker's layer cache is what skips what did not change. The script's own skip (a dependency
 * that already exists is not rebuilt when only its dependants are named) is deliberately **not**
 * used: it would keep a `platform-base:dev` older than `docker/base.Dockerfile`. `up -d` then
 * recreates only the containers whose image or configuration changed.
 *
 * **The page is a second command, not part of `up`**: Vite is a foreground process with its own
 * terminal (and Ctrl-C), while `up -d` returns. `ui` reads the worker's published port with
 * `docker compose port` and its page token, if it logged one, from the worker's own start line —
 * the line `pnpm worker:dev logs remote-worker | grep token=` prints anyway — and prints the Vite
 * address, with the token in the fragment when there is one. This script never reads `.env.worker`'s values: compose does.
 *
 * Plain Node, no TypeScript resolver: it runs before `pnpm install` is a question.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isProgram } from './is-program.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The dev worker's compose project — never the prod worker's `agentic-worker`. */
export const DEV_PROJECT = 'agentic-worker-dev';
export const BASE_COMPOSE_FILE = 'compose.worker.yml';
export const DEV_COMPOSE_FILE = 'compose.worker.dev.yml';
export const DEFAULT_ENV_FILE = '.env.worker';
/** Vite's port for the page; `pnpm dev`'s SPA is on 5173. */
export const DEFAULT_VITE_PORT = '5174';
/** The worker's page inside the container (`compose.worker.yml`). */
const CONTAINER_UI_PORT = '7357';

const USAGE =
  'usage: pnpm worker:dev [up [--no-build] | ui | down | logs | ps] [compose arguments…]\n';

/** The compose prefix every subcommand shares. */
export const composePrefix = (envFile) => [
  'compose',
  '-p',
  DEV_PROJECT,
  '--env-file',
  envFile,
  '-f',
  BASE_COMPOSE_FILE,
  '-f',
  DEV_COMPOSE_FILE,
];

/**
 * What the arguments ask for — pure, so the test reads it without Docker.
 *
 * @param {readonly string[]} argv  the arguments after the script
 * @returns {{kind: 'up', build: boolean} | {kind: 'ui'} | {kind: 'compose', args: string[]} |
 *   {kind: 'usage', error: string | null}}
 */
export const planCommand = (argv) => {
  const [command = 'up', ...rest] = argv;
  switch (command) {
    case 'up': {
      const unknown = rest.filter((value) => value !== '--no-build');
      // Refused rather than ignored: `--no-biuld` quietly rebuilding is the shape of a flag that
      // never applies (standing rule 18).
      return unknown.length > 0
        ? { kind: 'usage', error: `unknown argument(s) to up: ${unknown.join(' ')}` }
        : { kind: 'up', build: !rest.includes('--no-build') };
    }
    case 'ui':
      return rest.length > 0
        ? { kind: 'usage', error: `ui takes no arguments: ${rest.join(' ')}` }
        : { kind: 'ui' };
    case 'down':
    case 'logs':
    case 'ps':
      return { kind: 'compose', args: [command, ...rest] };
    case '-h':
    case '--help':
    case 'help':
      return { kind: 'usage', error: null };
    default:
      return { kind: 'usage', error: `unknown command: ${command}` };
  }
};

/** The page token from the worker's start lines — the last one, since a restart logs it again. */
export const pageTokenFrom = (logs) => {
  const matches = [...logs.matchAll(/#token=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/g)];
  return matches.at(-1)?.[1] ?? null;
};

/**
 * The page's address on Vite. A worker that logged a page token gets it in the fragment; one that
 * logged none — the page is tokenless by default (S-22.17) — is opened as it is. `localhost`, not
 * `127.0.0.1`: Vite listens on `localhost`, which on macOS is `::1` alone (measured).
 */
export const pageAddress = (vitePort, token) =>
  `http://localhost:${vitePort}/worker.html${token === null ? '' : `#token=${token}`}`;

/** `127.0.0.1:7358` (or `0.0.0.0:7358`, `[::1]:7358`) → `http://127.0.0.1:7358`, else `null`. */
export const workerOriginFrom = (portOutput) => {
  const line = portOutput.trim().split('\n')[0] ?? '';
  const match = /:(\d{1,5})$/.exec(line);
  return match === null ? null : `http://127.0.0.1:${match[1]}`;
};

const run = (command, args, options = {}) =>
  spawnSync(command, args, { cwd: REPO, stdio: 'inherit', ...options });

const main = () => {
  const plan = planCommand(process.argv.slice(2));
  if (plan.kind === 'usage') {
    process.stderr.write(plan.error === null ? USAGE : `${plan.error}\n${USAGE}`);
    return plan.error === null ? 0 : 2;
  }
  const envFile = process.env.APP_WORKER_DEV_ENV_FILE || DEFAULT_ENV_FILE;
  if (!existsSync(path.resolve(REPO, envFile))) {
    process.stderr.write(
      `${envFile} does not exist: cp .env.worker.example .env.worker, then set your Claude token\n`,
    );
    return 2;
  }
  const prefix = composePrefix(envFile);

  if (plan.kind === 'compose') {
    return run('docker', [...prefix, ...plan.args]).status ?? 1;
  }

  if (plan.kind === 'up') {
    if (plan.build) {
      const built = run(process.execPath, [path.join('scripts', 'build-images.mjs')]);
      if (built.status !== 0) {
        process.stderr.write('the images did not build; nothing was started\n');
        return built.status ?? 1;
      }
    }
    const up = run('docker', [...prefix, 'up', '-d']);
    if (up.status === 0) {
      process.stdout.write(
        '\nThe dev worker is up. Approve it:  pnpm worker:dev logs remote-worker | grep user_code\n' +
          'The page, hot-reloading:          pnpm worker:dev ui\n',
      );
    }
    return up.status ?? 1;
  }

  // ui
  const port = spawnSync('docker', [...prefix, 'port', 'remote-worker', CONTAINER_UI_PORT], {
    cwd: REPO,
    encoding: 'utf8',
  });
  const workerOrigin = port.status === 0 ? workerOriginFrom(port.stdout) : null;
  if (workerOrigin === null) {
    process.stderr.write(
      'the dev worker publishes no page: start it with `pnpm worker:dev` (and APP_WORKER_UI enabled)\n',
    );
    return 2;
  }
  const logs = spawnSync('docker', [...prefix, 'logs', '--no-log-prefix', 'remote-worker'], {
    cwd: REPO,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const token = pageTokenFrom(`${logs.stdout ?? ''}`);
  const vitePort = process.env.APP_WORKER_DEV_VITE_PORT || DEFAULT_VITE_PORT;
  process.stdout.write(`the page, hot-reloading: ${pageAddress(vitePort, token)}\n`);
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  const vite = spawn(
    pnpm,
    ['--filter', '@platform/web', 'run', 'dev', '--port', vitePort, '--strictPort'],
    {
      cwd: REPO,
      stdio: 'inherit',
      // Read by `apps/web/vite.config.ts` (`workerLocalProxy`): `/api/local` goes to the worker.
      env: { ...process.env, APP_DEV_WORKER_URL: workerOrigin },
    },
  );
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => vite.kill(signal));
  }
  vite.on('exit', (code, signal) => {
    process.exit(signal === null ? (code ?? 0) : 1);
  });
  return null;
};

if (isProgram(import.meta.url)) {
  const code = main();
  if (code !== null) {
    process.exit(code);
  }
}
