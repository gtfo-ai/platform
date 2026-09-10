#!/usr/bin/env node
/**
 * `pnpm dev` — the server and the web app, from source, against a local database (CLAUDE.md).
 *
 * Two children: `apps/server` through `scripts/ts-source-resolver.mjs` (sources are TypeScript with
 * `.js` specifiers), and Vite for `apps/web`. Vite proxies `/api` and `/events` to the server, so
 * the browser sees **one origin** — which is what technical/08 specifies and what makes the
 * `__Host-` session cookie, the `Origin` check and `EventSource`'s same-origin credentials behave
 * in development the way they will in the packaged image.
 *
 * The environment is the operator's own (a `.env` copied from `.env.example`, or exported
 * variables). Nothing is defaulted here: `apps/server/src/config.ts` validates the whole
 * configuration at boot and names every variable it is unhappy about, and a second set of defaults
 * in a dev script is how "it works locally" stops meaning anything. The two `APP_DEV_*` variables
 * are the exception and they are read by `apps/web/vite.config.ts`, not by the server.
 *
 * `--server-only` runs what this script ran before WP-20, for anyone working on the API alone.
 *
 * Either child exiting takes the other down: a dev command that leaves half of itself running in
 * the background is how a stale server ends up serving the next hour's debugging.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const serverOnly = process.argv.includes('--server-only');

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];
let shuttingDown = false;

const stopAll = (signal) => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  for (const child of children) {
    // Forwarded rather than handled: the server's own close-with-grace hook drains the SSE streams
    // and the workers, and killing it outright would skip exactly the thing WP-06 built.
    child.kill(signal);
  }
};

const start = (name, command, args, env) => {
  const child = spawn(command, args, {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { ...env, ...process.env },
  });
  children.push(child);
  child.on('exit', (code, signal) => {
    if (!shuttingDown) {
      process.stderr.write(`\n${name} exited (${signal ?? code}); stopping the rest.\n`);
      process.exitCode = signal === null ? (code ?? 0) : 1;
      stopAll('SIGTERM');
    }
  });
  child.on('error', (error) => {
    process.stderr.write(`${name} could not be started: ${error.message}\n`);
    process.exitCode = 1;
    stopAll('SIGTERM');
  });
  return child;
};

start(
  'apps/server',
  process.execPath,
  ['--import', './scripts/ts-source-resolver.mjs', 'apps/server/src/main.ts'],
  { LOG_FORMAT: 'pretty' },
);

if (!serverOnly) {
  const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
  start('apps/web', pnpm, [
    '--filter',
    '@platform/web',
    'run',
    'dev',
    '--port',
    process.env.APP_DEV_WEB_PORT ?? '5173',
    '--strictPort',
  ]);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    stopAll(signal);
  });
}
