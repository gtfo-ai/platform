#!/usr/bin/env node
/**
 * gitleaks front-end (BD-002: no secret ever enters the repository).
 *
 * Resolution order, so the scan works on a machine with no global install:
 *   1. the binary shipped by the `@b12k/gitleaks` devDependency, in this checkout;
 *   2. the same binary in the **main** worktree, when this checkout is a linked worktree that has
 *      had no `pnpm install` of its own (the arrangement technical/14 tells a session to use);
 *   3. a `gitleaks` already on PATH;
 *   4. the official image, if a Docker daemon is reachable.
 *
 * If none of those is available the scan did not happen, and a scan that did not
 * happen must never be reported as a pass. The script therefore **fails closed**:
 * it exits non-zero whenever `--require` is passed or `CI` is set. Only an
 * interactive developer who explicitly sets `GITLEAKS_SKIP=1` gets a warning and
 * exit 0, and that opt-out is ignored in CI.
 *
 * ## A scan that read nothing is not a scan (backlog 8, WP-68)
 *
 * The container fallback used to mount the checkout alone. In a linked worktree `.git` is a
 * *file* naming `<main>/.git/worktrees/<name>`, which the container could not reach, so git failed
 * inside it and gitleaks printed `0 commits scanned`, `scanned ~0 bytes (0)`, **`no leaks found`**
 * and exited 0 — over a staged credential, measured again at WP-68. The failing path and the
 * passing path were spelled identically, which is the whole finding. Two things answer it:
 *
 *  - **the container is told where the repository really is.** The common git directory is
 *    mounted beside the work tree and `GIT_DIR`/`GIT_COMMON_DIR`/`GIT_WORK_TREE` name both, so a
 *    linked worktree's staged diff is readable in the container. The mounts are at fixed
 *    container paths (`/repo`, `/gitcommon`) rather than at the host paths: Docker Desktop was
 *    measured serving an **empty** directory for a bind whose target repeated a host path under
 *    `/Users`, which is the same failure one layer down.
 *  - **the result is audited, whichever scanner ran.** gitleaks' own log line `scanned ~N bytes`
 *    is read back; on exit 0 a missing line, a `[git] fatal:` line, or `N = 0` when the host says
 *    there was something to read is a **failure**, with its own banner. "Something to read" is
 *    asked of the host only for `--staged` (a staged diff that adds no line — a deletion, a
 *    message-only amend — legitimately scans zero bytes); every other mode is expected to read
 *    something, because a repository's history and a directory are never empty. A second cause
 *    of an empty mount — a checkout outside Docker's shared paths — is caught by the same check.
 *
 * `scripts/gitleaks.test.ts` asserts the refusal on its own, against a scanner that reports
 * exactly the measured output, and asserts the real binary in a real linked worktree both ways.
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
import { containerArgs, gitLayout, scanVerdict, stagedAddedLines } from './gitleaks-audit.mjs';

// ghcr.io/gitleaks/gitleaks:v8.30.1, pinned by multi-arch index digest.
const DOCKER_IMAGE =
  'ghcr.io/gitleaks/gitleaks@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f';

const COMMON = ['--redact', '--no-banner', '--config', '.gitleaks.toml'];

function isTruthy(value) {
  return value !== undefined && value !== '' && value !== '0' && value !== 'false';
}

const NOTHING_READ_BANNER = [
  '',
  '  ##############################################################',
  '  #  THE SECRET SCAN READ NOTHING, SO IT PASSED NOTHING.       #',
  '  #  gitleaks exited 0 without proving it scanned your change. #',
  '  #  Fix: `pnpm install` in this checkout (the host binary     #',
  '  #  works in a linked worktree), or check that Docker can     #',
  '  #  see this path. See BD-002 and PROGRESS backlog 8.         #',
  '  ##############################################################',
  '',
];

const NOT_RUN_BANNER = [
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

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const required = argv.includes('--require') || isTruthy(process.env.CI);
const args = argv.filter((arg) => arg !== '--require');

// `@b12k/gitleaks` is a JS wrapper that pulls in update-notifier, which reads
// ~/.npmrc auth tokens and calls the registry. Never in a hook, never in CI.
const childEnv = { ...process.env, NO_UPDATE_NOTIFIER: '1' };

const layout = gitLayout(repoRoot);

const binaryIn = (root) => {
  const candidate = join(root, 'node_modules', '.bin', 'gitleaks');
  return existsSync(candidate) ? candidate : null;
};
const onPath = () => {
  const probe = spawnSync('gitleaks', ['version'], { stdio: 'ignore', env: childEnv });
  return probe.status === 0 ? 'gitleaks' : null;
};
const dockerAvailable = () =>
  spawnSync('docker', ['info'], { stdio: 'ignore', env: childEnv }).status === 0;

/** Run the scanner, echo what it said, and hold its exit 0 to the evidence. */
const audited = (command, commandArgs) => {
  const result = spawnSync(command, commandArgs, {
    cwd: repoRoot,
    env: childEnv,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.error !== undefined) {
    process.stderr.write(`could not run ${command}: ${result.error.message}\n`);
    return 1;
  }
  const staged = args[0] === 'git' && args.includes('--staged');
  const mayBeEmpty = staged && stagedAddedLines(repoRoot) === 0;
  const verdict = scanVerdict({
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}\n${result.stderr ?? ''}`,
    mayBeEmpty,
  });
  if (verdict.ok) {
    return verdict.status;
  }
  process.stderr.write([...NOTHING_READ_BANNER, `  ${verdict.reason}.`, ''].join('\n'));
  return 1;
};

const mainWorktree = layout?.linked === true ? dirname(layout.commonDir) : null;
const binary =
  binaryIn(repoRoot) ?? (mainWorktree === null ? null : binaryIn(mainWorktree)) ?? onPath();

if (binary) {
  process.exit(audited(binary, [...args, ...COMMON]));
}

if (dockerAvailable()) {
  if (layout === null) {
    process.stderr.write(
      'gitleaks binary not found, and git could not describe this checkout for the container fallback; refusing rather than scanning an unknown layout.\n',
    );
    process.exit(1);
  }
  process.stderr.write(`gitleaks binary not found; falling back to ${DOCKER_IMAGE}\n`);
  // --network=none isolates the scanner's own namespace; the daemon still pulls the
  // image over the host network, so a missing image is not a problem.
  process.exit(audited('docker', containerArgs(layout, DOCKER_IMAGE, [...args, ...COMMON])));
}

if (required && !isTruthy(process.env.CI) && isTruthy(process.env.GITLEAKS_SKIP)) {
  // Explicit, deliberate, local opt-out. Loud, never silent.
  process.stderr.write(
    [...NOT_RUN_BANNER, '  GITLEAKS_SKIP=1 is set — continuing WITHOUT a secret scan.', ''].join(
      '\n',
    ),
  );
  process.exit(0);
}

if (required) {
  process.stderr.write(
    [
      ...NOT_RUN_BANNER,
      isTruthy(process.env.CI)
        ? '  Running in CI: failing closed. GITLEAKS_SKIP is ignored here.'
        : '  Failing closed. To commit anyway: GITLEAKS_SKIP=1 git commit ...',
      '',
    ].join('\n'),
  );
  process.exit(1);
}

process.stderr.write(NOT_RUN_BANNER.join('\n'));
process.exit(0);
