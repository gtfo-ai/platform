#!/usr/bin/env node
/**
 * `pnpm migrations:check` — the entry point of `scripts/check-migrations.ts` (WP-271, TD-032
 * decision 1), whose docblock has the rules, the base resolution and what it cannot see. A plain
 * Node script runs the TypeScript sources through `ts-source-resolver.mjs`, as the other checks that
 * read a package's sources do.
 *
 * Usage: `node scripts/check-migrations.mjs [--from <rev>] [--to <rev>]`. Prints exactly one
 * `PASS: migrations:check` / `FAIL: migrations:check` line on stdout (docs/technical/14).
 */
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isProgram } from './is-program.mjs';
import './ts-source-resolver.mjs';

if (isProgram(import.meta.url)) {
  const { runMigrationsCheck } = await import('./check-migrations.ts');
  process.exitCode = runMigrationsCheck(process.argv.slice(2), {
    root: fileURLToPath(new URL('..', import.meta.url)),
  });
}
