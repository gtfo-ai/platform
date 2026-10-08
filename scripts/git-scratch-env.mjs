/**
 * The environment of every `git` child a test runs, and the check that a scratch repository is the
 * repository it acts on (WP-162, PROGRESS backlog 499).
 *
 * ## The defect it closes
 *
 * git honours `GIT_DIR` (and `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_COMMON_DIR`, …) before it
 * searches from its working directory, so a `cwd` does not choose a repository while one of them is
 * set. A linked worktree's `pre-push` hook runs with `GIT_DIR=<common>/.git/worktrees/<name>` in its
 * environment (measured under plain git hooks and under lefthook 2.1.12, git 2.54.0; the main
 * checkout's hook has no `GIT_DIR`), and the unit tier that hook runs builds scratch repositories
 * with `git init` / `add` / `commit` / `tag`. Inheriting the hook's environment, those children
 * acted on the repository the worktree shares: `core.bare=true` in the shared configuration, the
 * worktree's `HEAD` moved onto fixture commits, its index replaced, release-shaped tags created.
 *
 * ## The answer
 *
 * **A prefix rule, not a list.** {@link withoutInheritedGit} drops every inherited name that starts
 * with `GIT_`, because git reads many and adds more (`GIT_OBJECT_DIRECTORY`, `GIT_NAMESPACE`,
 * `GIT_CONFIG_*`, …); a list of the four known names is exactly the guard that misses the fifth, and
 * `git-scratch-env.test.ts` plants an invented one to hold that. {@link scratchGitEnv} then adds back
 * the fixture's own values: no global or system configuration, a fixed author and committer,
 * `core.hooksPath=/dev/null` (a scratch repository never runs this machine's hooks), and
 * `GIT_CEILING_DIRECTORIES` set to the scratch root's parent, so discovery from a directory that is
 * not yet a repository cannot climb out of it into one that is.
 *
 * **A second guard beside the scrub.** {@link assertScratchRepository} asks `git rev-parse
 * --absolute-git-dir` from the scratch root and throws unless the answer is inside it, so a test
 * that would act on another repository fails before its first write. {@link initScratchRepository}
 * runs `git init` and then the check.
 *
 * **A test's own process, too.** A test that calls a production module in-process
 * (`censusPaths(root)`, `readCommits(range, root)`) cannot hand it an environment: the module's
 * `git` inherits the test worker's. So `test/support/git-environment.ts`, a setup file of every
 * vitest project, applies the same prefix rule to the worker's `process.env` with
 * {@link scrubInheritedGit}. **The production scripts are not changed**: run by a hook, they are
 * meant to act on the repository git names.
 *
 * {@link checkoutGitEnv} is the other shape a test needs — a read of *this* checkout
 * (`git ls-files` over the repository root): the same prefix rule and nothing added, so git finds
 * the checkout by discovery from the `cwd` it is given, which in a linked worktree is the worktree.
 *
 * `scripts/git-scratch-env-census.test.ts` refuses a test that spawns `git`, or a script that runs
 * it, without one of these two environments.
 *
 * Plain JavaScript for the reason `census-files.mjs` gives: a spawned `.mjs` script and a test under
 * any ring import it without a TypeScript resolver. `git-scratch-env.d.mts` carries the types.
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';

/** The prefix every name git reads from the environment starts with. */
export const GIT_ENVIRONMENT_PREFIX = 'GIT_';

/** The author and committer a scratch repository's commits carry. Obviously not a person. */
export const SCRATCH_AUTHOR = Object.freeze({
  name: 'Fixture',
  email: 'fixture@example.invalid',
});

/** A copy of `parent` without any name that starts with `GIT_`. */
export function withoutInheritedGit(parent = process.env) {
  const env = {};
  for (const [name, value] of Object.entries(parent)) {
    if (!name.startsWith(GIT_ENVIRONMENT_PREFIX) && value !== undefined) {
      env[name] = value;
    }
  }
  return env;
}

/**
 * Removes every `GIT_` name from `env` in place, and returns the names it removed — for a test
 * worker's own `process.env`, whose in-process `git` children cannot be handed an environment.
 */
export function scrubInheritedGit(env = process.env) {
  const removed = Object.keys(env).filter((name) => name.startsWith(GIT_ENVIRONMENT_PREFIX));
  for (const name of removed) {
    delete env[name];
  }
  return removed.sort();
}

/**
 * The environment of a `git` child, or of a script that runs one, acting on the scratch
 * repository at (or being created at) `scratchRoot`.
 *
 * `config` adds `git -c`-shaped entries through `GIT_CONFIG_COUNT`, after `core.hooksPath`; `env`
 * adds names last, so a test that needs one of its own (`GIT_COMMITTER_DATE`) can set it.
 */
export function scratchGitEnv(
  scratchRoot,
  { parent = process.env, author = SCRATCH_AUTHOR, config = {}, env = {} } = {},
) {
  const entries = [['core.hooksPath', '/dev/null'], ...Object.entries(config)];
  const configEnv = { GIT_CONFIG_COUNT: String(entries.length) };
  entries.forEach(([key, value], index) => {
    configEnv[`GIT_CONFIG_KEY_${index}`] = key;
    configEnv[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return {
    ...withoutInheritedGit(parent),
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: author.name,
    GIT_AUTHOR_EMAIL: author.email,
    GIT_COMMITTER_NAME: author.name,
    GIT_COMMITTER_EMAIL: author.email,
    GIT_CEILING_DIRECTORIES: dirname(realpathSync(scratchRoot)),
    ...configEnv,
    ...env,
  };
}

/**
 * The environment of a `git` child that **reads this checkout** — the prefix rule and nothing
 * else, so the repository is the one discovery finds from the child's `cwd`.
 */
export function checkoutGitEnv(parent = process.env) {
  return withoutInheritedGit(parent);
}

/** Thrown when a scratch root's git directory is somewhere else. */
export class ScratchRepositoryEscapeError extends Error {
  constructor(scratchRoot, gitDir) {
    super(
      `the scratch repository at ${scratchRoot} resolves its git directory to ${gitDir}, which is outside it; a test would act on another repository`,
    );
    this.name = 'ScratchRepositoryEscapeError';
    this.scratchRoot = scratchRoot;
    this.gitDir = gitDir;
  }
}

const isInside = (root, path) => {
  const from = relative(root, path);
  return from === '' || (!from.startsWith(`..${sep}`) && from !== '..' && !from.startsWith(sep));
};

/**
 * Throws {@link ScratchRepositoryEscapeError} unless `git rev-parse --absolute-git-dir`, asked from
 * `scratchRoot` with `env`, names a directory inside `scratchRoot`. A root that is no repository at
 * all throws git's own error.
 */
export function assertScratchRepository(scratchRoot, env = scratchGitEnv(scratchRoot)) {
  const root = realpathSync(scratchRoot);
  const answer = execFileSync('git', ['rev-parse', '--absolute-git-dir'], {
    cwd: root,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
  let gitDir = answer;
  try {
    gitDir = realpathSync(answer);
  } catch {
    // An answer that does not exist is still outside the root; report it as git gave it.
  }
  if (!isInside(root, gitDir)) {
    throw new ScratchRepositoryEscapeError(root, gitDir);
  }
}

/**
 * `git init -q` (plus `initArgs`) at `scratchRoot` with {@link scratchGitEnv}, then
 * {@link assertScratchRepository}. Returns the environment, for the test's later `git` children.
 */
export function initScratchRepository(scratchRoot, { initArgs = [], ...options } = {}) {
  const env = scratchGitEnv(scratchRoot, options);
  execFileSync('git', ['init', '-q', ...initArgs], {
    cwd: scratchRoot,
    env,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  assertScratchRepository(scratchRoot, env);
  return env;
}
