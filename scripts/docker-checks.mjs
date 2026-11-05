#!/usr/bin/env node
/**
 * The Docker checks CI runs, and when — `.github/workflows/docker-checks.yml`'s one table.
 *
 * Twelve `scripts/*-check.mjs` need a Docker daemon, so none is a `verify` target (a `verify` step is
 * a step of CI's lint or unit job, which have no daemon — `scripts/verify-targets.ts`). Five already
 * ran in CI: `runlet-container-check` in `ci.yml`'s first e2e part, and the four compose checks in
 * `image.yml`'s `build` job on both architectures (`scripts/release.test.ts` holds those). The other
 * seven ran only when somebody ran them by hand, on a developer's daemon — and the owner's daemon is
 * also the one their live worker runs on. This table gives each of the seven a place in CI:
 *
 *  - **`always`** — on every pull request and every push to `main`. The check is short (seconds to
 *    half a minute when measured by hand) and guards the run image or the run plane, whose inputs are
 *    too broad for a path list to name honestly (a base image, a lockfile, a Dockerfile, the shim);
 *  - **`paths`** — on a pull request or push that changes one of the listed paths, and on every
 *    scheduled run. The check takes minutes, or brings up whole compose projects, and guards a part of
 *    the tree that can be named. A path list is an **under**-approximation of what a check depends
 *    on; the nightly run of every check is what catches a change no list named.
 *
 * A change to this file or to the workflow runs every check, and so does any run whose changed files
 * cannot be listed (a scheduled run, a dispatch, the first push of a branch) — `--all`.
 *
 * Not required checks (CONTRIBUTING.md § Branch protection stays `ci.yml`'s jobs): a required check
 * that a path list skipped would block every merge it skipped, and a scheduled run has no pull request
 * to block. A failure is a red `docker check (<name>)` on the pull request or push; a scheduled run's
 * failure is a red run on the Actions page and GitHub's e-mail to whoever last edited the schedule.
 *
 *     node scripts/docker-checks.mjs plan --changed <file> [--github-output]   the checks to run
 *     node scripts/docker-checks.mjs plan --all [--github-output]              every check
 *     node scripts/docker-checks.mjs run <name>                                run one check
 *
 * Its test tier is `scripts/docker-checks.test.ts`, which also holds the census: every
 * `scripts/*-check.mjs` git knows about is in this table or in {@link RUN_ELSEWHERE}, and each
 * `RUN_ELSEWHERE` entry is really run by the workflow it names.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { isProgram } from './is-program.mjs';

/** Changing either of these runs every check: they are the harness every check runs in. */
export const HARNESS_PATHS = ['.github/workflows/docker-checks.yml', 'scripts/docker-checks.mjs'];

/**
 * What the launcher, the run shim and the run images are made of. A path ending in `/` is a
 * directory prefix; any other is one file.
 */
const RUN_PLANE = [
  'docker/',
  'scripts/build-images.mjs',
  'pnpm-lock.yaml',
  'apps/launcher/',
  'apps/runlet/',
  'packages/contracts/src/runlet.ts',
  'packages/contracts/src/run-spec.ts',
  'packages/infrastructure/src/launcher/',
  'packages/infrastructure/src/runlet/',
  'packages/infrastructure/src/runner/',
  'packages/infrastructure/src/workspace/',
  'test/e2e/support/docker-workspace.ts',
  'test/fixtures/runlet/',
];

/** The worker bundle, its protocol with the core, and the compose files both are started from. */
const WORKER = [
  'compose.yml',
  'compose.worker.yml',
  'scripts/compose-check-support.mjs',
  'apps/server/src/remote-worker/',
  'apps/server/src/routes/worker/',
  'apps/server/src/routes/worker-device.ts',
  'apps/server/src/routes/workers.ts',
  'apps/server/src/workers/',
  'apps/server/src/worker-protocol.ts',
  'apps/server/src/worker-run-calls.ts',
  'apps/server/src/runtime.ts',
  'packages/infrastructure/src/db/migrations/',
];

/**
 * @typedef {{
 *   name: string,
 *   when: 'always' | 'paths',
 *   paths: readonly string[],
 *   why: string,
 * }} DockerCheck
 */

/** @type {readonly DockerCheck[]} */
export const DOCKER_CHECKS = [
  {
    name: 'git-long-options-check',
    when: 'always',
    paths: [],
    why: 'one container with no network; the committed long-option table against the run image’s own git',
  },
  {
    name: 'credential-path-check',
    when: 'always',
    paths: [],
    why: 'one container (2 s by hand); the run credential reaches only the project’s repository',
  },
  {
    name: 'runlet-launcher-check',
    when: 'always',
    paths: [],
    why: 'launcher, run container, shim and runner meeting once (13 s by hand)',
  },
  {
    name: 'deploy-key-check',
    when: 'always',
    paths: [],
    why: 'the deploy key reaches the SSH stand-in and no file, environment or log (26 s by hand)',
  },
  {
    name: 'launcher-control-plane-check',
    when: 'paths',
    paths: [
      ...RUN_PLANE,
      'scripts/launcher-control-plane-check.mjs',
      'scripts/launcher-control-plane-launcher.mjs',
      'scripts/launcher-control-plane-runner.mjs',
      'scripts/real-model-preflight.mjs',
      'apps/server/src/agent.ts',
      'apps/server/src/workspaces.ts',
      'packages/application/src/recovery/orphan-workspaces.ts',
    ],
    why: 'three containers and minutes of deliberate waiting (a two-minute shim observation among them)',
  },
  {
    name: 'worker-compose-check',
    when: 'paths',
    paths: [
      ...RUN_PLANE,
      ...WORKER,
      'scripts/worker-compose-check.mjs',
      'scripts/worker-check/',
      'packages/application/src/pipeline/claimant.ts',
      'packages/application/src/pipeline/claim-admission.ts',
      'packages/application/src/pipeline/lease.ts',
      'packages/application/src/pipeline/offers.ts',
      'packages/application/src/pipeline/run-package.ts',
      'packages/application/src/pipeline/settle.ts',
    ],
    why: 'a core and a worker bundle, a registry and two git stand-ins; two tasks run to Ready',
  },
  {
    name: 'worker-update-check',
    when: 'paths',
    paths: [
      'docker/',
      'scripts/build-images.mjs',
      'pnpm-lock.yaml',
      ...WORKER,
      'scripts/worker-update-check.mjs',
      'apps/server/src/updater/',
    ],
    why: 'four attested builds of every image and three updates of a live worker',
  },
];

/**
 * The daemon checks a workflow already ran before this table existed, and where. The census in the
 * test reads each named workflow and finds the check's command in it.
 */
export const RUN_ELSEWHERE = {
  'runlet-container-check': '.github/workflows/ci.yml',
  'web-compose-check': '.github/workflows/image.yml',
  'compose-stock-check': '.github/workflows/image.yml',
  'compose-isolation-check': '.github/workflows/image.yml',
  'restore-check': '.github/workflows/image.yml',
};

/** Whether `file` is one of `paths` (a `/`-terminated entry is a directory prefix). */
export const matchesPath = (file, paths) =>
  paths.some((path) => (path.endsWith('/') ? file.startsWith(path) : file === path));

/**
 * The checks to run, in table order. `changed` is the list of changed files, or `null` when it is
 * not known — then every check runs, because a skip nobody can justify is not a pass.
 *
 * @param {readonly string[] | null} changed
 * @param {readonly DockerCheck[]} [checks]
 * @returns {string[]}
 */
export const planChecks = (changed, checks = DOCKER_CHECKS) => {
  if (changed === null || changed.some((file) => HARNESS_PATHS.includes(file))) {
    return checks.map((check) => check.name);
  }
  return checks
    .filter(
      (check) =>
        check.when === 'always' ||
        changed.some(
          (file) => matchesPath(file, check.paths) || file === `scripts/${check.name}.mjs`,
        ),
    )
    .map((check) => check.name);
};

/** `git diff --name-only` output → the files, blank lines dropped. */
export const parseChanged = (text) =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');

const usage = () => {
  process.stderr.write(
    'usage: docker-checks.mjs plan (--changed <file> | --all) [--github-output] | run <name>\n',
  );
  return 2;
};

const plan = (args) => {
  const all = args.includes('--all');
  const at = args.indexOf('--changed');
  if (all === (at !== -1)) return usage();
  const file = at === -1 ? undefined : args[at + 1];
  if (at !== -1 && (file === undefined || file.startsWith('--'))) return usage();
  const changed = file === undefined ? null : parseChanged(readFileSync(file, 'utf8'));
  const checks = planChecks(changed);
  process.stderr.write(
    changed === null
      ? `every check runs (no list of changed files): ${checks.join(', ')}\n`
      : `${changed.length} changed file(s); checks: ${checks.join(', ') || 'none'}\n`,
  );
  const line = `checks=${JSON.stringify(checks)}\n`;
  if (args.includes('--github-output')) {
    const output = process.env.GITHUB_OUTPUT;
    if (output === undefined || output === '') {
      process.stderr.write('--github-output: GITHUB_OUTPUT is not set\n');
      return 1;
    }
    appendFileSync(output, line);
  } else {
    process.stdout.write(line);
  }
  return 0;
};

const run = (args) => {
  const check = DOCKER_CHECKS.find((candidate) => candidate.name === args[0]);
  if (check === undefined) {
    process.stderr.write(
      `unknown check '${args[0] ?? ''}'; known: ${DOCKER_CHECKS.map((c) => c.name).join(', ')}\n`,
    );
    return 2;
  }
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(new URL(`${check.name}.mjs`, import.meta.url))],
    {
      stdio: 'inherit',
    },
  );
  if (result.error !== undefined) {
    process.stderr.write(`FAIL: ${check.name} did not start: ${result.error.message}\n`);
    return 1;
  }
  return result.status ?? 1;
};

if (isProgram(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  process.exitCode = command === 'plan' ? plan(rest) : command === 'run' ? run(rest) : usage();
}
