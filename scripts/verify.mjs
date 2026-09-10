#!/usr/bin/env node
/**
 * Verification script contract — docs/technical/14-orchestration-protocol.md.
 *
 *   pnpm run -s verify              lint + typecheck + unit + contract
 *   pnpm run -s verify:integration  Testcontainers / PGlite suites
 *   pnpm run -s verify:e2e          fake-Claude application e2e
 *   pnpm run -s verify:ui           web app suites
 *
 * `verify` is the concatenation of the three groups CI runs as its own jobs — `verify:static`,
 * `verify:types`, `verify:tests` — which are targets here too and can be run on their own. That is
 * so the workflow does not carry a second copy of the list; see `verify-targets.ts`.
 *
 * Every target prints exactly one line on **stdout**, `PASS: <target>` or `FAIL: <target>`,
 * and exits non-zero on failure. The steps a target runs may print their own PASS/FAIL lines
 * (`schemas:check` does), so each child's stdout is redirected to this process's stderr: the
 * orchestrator reads one verdict per target from stdout, and everything else stays on stderr
 * where it is still visible in a terminal and in CI logs.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';
// The on-disk `.ts` specifier, not this repository's usual `.js` one: Node runs this file directly
// and strips the types itself (verified on node:24-alpine, the version in .nvmrc), and its type
// stripping resolves the path it is given rather than rewriting the extension (CLAUDE.md).
import { TARGETS } from './verify-targets.ts';

const target = process.argv[2];
const steps = TARGETS[target];

if (!steps) {
  process.stderr.write(
    `unknown verify target ${JSON.stringify(target)}; expected one of ${Object.keys(TARGETS).join(', ')}\n`,
  );
  process.stdout.write('FAIL: verify\n');
  process.exit(2);
}

const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
let failed = null;

for (const step of steps) {
  process.stderr.write(`\n── ${target} › ${step} ──\n`);
  // stdin inherited, child stdout redirected onto our fd 2, stderr inherited. Passing the fd
  // (rather than piping) keeps the output streaming and keeps the child's TTY detection working.
  const result = spawnSync(pnpm, ['-s', 'run', step], {
    stdio: ['inherit', 2, 'inherit'],
    env: process.env,
  });
  if (result.error) {
    process.stderr.write(`${step}: ${result.error.message}\n`);
    failed = step;
    break;
  }
  if (result.status !== 0) {
    process.stderr.write(`${step}: exited with ${result.status ?? `signal ${result.signal}`}\n`);
    failed = step;
    break;
  }
}

if (failed) {
  process.stdout.write(`FAIL: ${target}\n`);
  process.exit(1);
}

process.stdout.write(`PASS: ${target}\n`);
