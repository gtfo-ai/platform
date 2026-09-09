#!/usr/bin/env node
/**
 * Verification script contract — docs/technical/14-orchestration-protocol.md.
 *
 *   pnpm run -s verify              lint + typecheck + unit + contract
 *   pnpm run -s verify:integration  Testcontainers / PGlite suites
 *   pnpm run -s verify:e2e          fake-Claude application e2e
 *   pnpm run -s verify:ui           web app suites
 *
 * Every target prints exactly one final line, `PASS: <target>` or `FAIL: <target>`,
 * and exits non-zero on failure.
 */
import { spawnSync } from 'node:child_process';
import process from 'node:process';

/** @type {Record<string, string[]>} target -> package.json scripts, in order */
const TARGETS = {
  verify: ['lint', 'typecheck', 'test'],
  'verify:integration': ['test:integration'],
  'verify:e2e': ['test:e2e'],
  'verify:ui': ['test:ui'],
};

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
  const result = spawnSync(pnpm, ['-s', 'run', step], {
    stdio: 'inherit',
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
