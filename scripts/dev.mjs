#!/usr/bin/env node
/**
 * `pnpm dev` — the server, from source, against a local database (CLAUDE.md).
 *
 * `apps/web` (WP-20) and the fake Claude runner (WP-12) join this script when they exist; today it
 * starts `apps/server` only. Sources are TypeScript with `.js` specifiers, so the run goes through
 * `scripts/ts-source-resolver.mjs` like `db:migrate` does.
 *
 * The environment is the operator's own (a `.env` copied from `.env.example`, or exported
 * variables). Nothing is defaulted here: `apps/server/src/config.ts` validates the whole
 * configuration at boot and names every variable it is unhappy about, and a second set of defaults
 * in a dev script is how "it works locally" stops meaning anything.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

const child = spawn(
  process.execPath,
  ['--import', './scripts/ts-source-resolver.mjs', 'apps/server/src/main.ts'],
  {
    cwd: repositoryRoot,
    stdio: 'inherit',
    env: { LOG_FORMAT: 'pretty', ...process.env },
  },
);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    // Forwarded rather than handled: the server's own close-with-grace hook drains the SSE streams
    // and the workers, and killing the child here would skip exactly the thing this repository
    // spent a work package building.
    child.kill(signal);
  });
}

child.on('exit', (code, signal) => {
  process.exitCode = signal === null ? (code ?? 0) : 1;
});
