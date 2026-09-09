#!/usr/bin/env node
/**
 * gitleaks front-end (BD-002: no secret ever enters the repository).
 *
 * Resolution order, so the scan works on a machine with no global install:
 *   1. the binary shipped by the `@b12k/gitleaks` devDependency (normal case)
 *   2. a `gitleaks` already on PATH
 *   3. the official image, if a Docker daemon is reachable
 *
 * If none of those is available the scan did not happen, and a scan that did not
 * happen must never be reported as a pass. The script therefore **fails closed**:
 * it exits non-zero whenever `--require` is passed or `CI` is set. Only an
 * interactive developer who explicitly sets `GITLEAKS_SKIP=1` gets a warning and
 * exit 0, and that opt-out is ignored in CI.
 *
 * Usage: node scripts/gitleaks.mjs <gitleaks args...> [--require]
 *   node scripts/gitleaks.mjs git --staged --require   # pre-commit
 *   node scripts/gitleaks.mjs dir .                    # working tree
 *   node scripts/gitleaks.mjs git --log-opts=--all --require   # full history
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ghcr.io/gitleaks/gitleaks:v8.30.1, pinned by multi-arch index digest.
const DOCKER_IMAGE =
  'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';

const COMMON = ['--redact', '--no-banner', '--config', '.gitleaks.toml'];

const argv = process.argv.slice(2);
const required = argv.includes('--require') || isTruthy(process.env.CI);
const args = argv.filter((arg) => arg !== '--require');

// `@b12k/gitleaks` is a JS wrapper that pulls in update-notifier, which reads
// ~/.npmrc auth tokens and calls the registry. Never in a hook, never in CI.
const childEnv = { ...process.env, NO_UPDATE_NOTIFIER: '1' };

function isTruthy(value) {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

function run(command, commandArgs) {
  return spawnSync(command, commandArgs, { cwd: repoRoot, stdio: 'inherit', env: childEnv });
}

function localBinary() {
  const candidate = join(repoRoot, 'node_modules', '.bin', 'gitleaks');
  return existsSync(candidate) ? candidate : null;
}

function onPath() {
  const probe = spawnSync('gitleaks', ['version'], { stdio: 'ignore', env: childEnv });
  return probe.status === 0 ? 'gitleaks' : null;
}

function dockerAvailable() {
  const probe = spawnSync('docker', ['info'], { stdio: 'ignore', env: childEnv });
  return probe.status === 0;
}

const binary = localBinary() ?? onPath();

if (binary) {
  const result = run(binary, [...args, ...COMMON]);
  process.exit(result.status ?? 1);
}

if (dockerAvailable()) {
  process.stderr.write(`gitleaks binary not found; falling back to ${DOCKER_IMAGE}\n`);
  // --network=none isolates the scanner's own namespace; the daemon still pulls the
  // image over the host network, so a missing image is not a problem. The repo is
  // mounted read-only: gitleaks only reads.
  const result = run('docker', [
    'run',
    '--rm',
    '--network=none',
    '-v',
    `${repoRoot}:/repo:ro`,
    '-w',
    '/repo',
    DOCKER_IMAGE,
    ...args,
    ...COMMON,
  ]);
  process.exit(result.status ?? 1);
}

// Nothing to scan with.
const banner = [
  '',
  '  ##############################################################',
  '  #  THE SECRET SCAN DID NOT RUN.                              #',
  '  #  gitleaks is not installed and Docker is not reachable.    #',
  '  #  Fix: `pnpm install` (installs @b12k/gitleaks), or start   #',
  '  #  Docker, or install gitleaks on PATH.                      #',
  '  #  See BD-002 — no secrets in this repository, ever.         #',
  '  ##############################################################',
  '',
];

if (required && !isTruthy(process.env.CI) && isTruthy(process.env.GITLEAKS_SKIP)) {
  // Explicit, deliberate, local opt-out. Loud, never silent.
  process.stderr.write(
    [...banner, '  GITLEAKS_SKIP=1 is set — continuing WITHOUT a secret scan.', ''].join('\n'),
  );
  process.exit(0);
}

if (required) {
  process.stderr.write(
    [
      ...banner,
      isTruthy(process.env.CI)
        ? '  Running in CI: failing closed. GITLEAKS_SKIP is ignored here.'
        : '  Failing closed. To commit anyway: GITLEAKS_SKIP=1 git commit ...',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stderr.write(banner.join('\n'));
process.exit(0);
