#!/usr/bin/env node
/**
 * `pnpm protocol:check` — the entry point of `scripts/check-protocol.ts` (WP-273, TD-032 decision 7),
 * whose docblock has the rules, the base resolution and what it cannot see. A plain Node script runs
 * the TypeScript sources through `ts-source-resolver.mjs`, as `check-migrations.mjs` does.
 *
 * Usage: `node scripts/check-protocol.mjs [--from <rev>] [--to <rev>]`. Prints exactly one
 * `PASS: protocol:check` / `FAIL: protocol:check` line on stdout (docs/technical/14).
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isProgram } from './is-program.mjs';
import './ts-source-resolver.mjs';

if (isProgram(import.meta.url)) {
  const { runProtocolCheck } = await import('./check-protocol.ts');
  process.exitCode = runProtocolCheck(process.argv.slice(2), {
    root: fileURLToPath(new URL('..', import.meta.url)),
  });
}
