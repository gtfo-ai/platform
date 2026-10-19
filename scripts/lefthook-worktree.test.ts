import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { afterAll, describe, expect, it } from 'vitest';
import { initScratchRepository } from './git-scratch-env.mjs';

/**
 * **A commit from a linked worktree under a spaced path runs the repository's real `commit-msg`
 * hook** (WP-215, PROGRESS backlog 612).
 *
 * Git hands `commit-msg` the message file's path. In a linked worktree that path is absolute
 * (`<main>/.git/worktrees/<name>/COMMIT_EDITMSG`), and `lefthook.yml` once pasted it into the shell
 * line as a bare `{1}`: a space in the main checkout's path split it, and commitlint refused
 * `Unknown argument: dir/main/.git/worktrees/wt-one/COMMIT_EDITMSG`. This suite builds that
 * setting — a scratch repository under a directory whose name holds a space, the hooks installed by
 * the pinned lefthook from **this checkout's `lefthook.yml` as it is on disk** (read at run time, so
 * a regression in the file fails here), and a linked worktree — and commits from the worktree.
 *
 * Both sides (standing rule 43): a conventional message commits with exit 0, and a message
 * commitlint must refuse is refused with commitlint's own finding, so a hook that never ran — or
 * that lints some other file — cannot pass. A non-conventional **merge** message is refused too:
 * `git merge` hands the hook `MERGE_MSG`, so a bare `--edit` (which reads `COMMIT_EDITMSG`) would
 * lint the previous commit's message and let the merge through (measured, WP-215 review round 1). Only `commit-msg` is installed: the pre-commit jobs
 * (gitleaks, biome) need this checkout's scripts and are not what this suite measures.
 *
 * Skipped **by name** where `lefthook` or `commitlint` is not installed. It is a `process` suite
 * (`vitest.config.ts`'s `COMMIT_HOOK_SUITE`) because it starts real hook processes whose duration
 * is the host's; every child is bounded.
 */
const repositoryRoot = realpathSync(join(import.meta.dirname, '..'));
const binaries = {
  lefthook: join(repositoryRoot, 'node_modules', '.bin', 'lefthook'),
  commitlint: join(repositoryRoot, 'node_modules', '.bin', 'commitlint'),
};
const missing = Object.entries(binaries)
  .filter(([, path]) => !existsSync(path))
  .map(([name]) => name);

const CHILD_TIMEOUT_MS = 60_000;

/**
 * The parent environment without any `LEFTHOOK*` name: a developer's `LEFTHOOK=0`,
 * `LEFTHOOK_EXCLUDE`, `LEFTHOOK_CONFIG` (another config file) or `LEFTHOOK_BIN` would otherwise
 * skip or redirect the hook this suite measures. A prefix rule, as `withoutInheritedGit` is.
 */
const withoutInheritedLefthook = (): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('LEFTHOOK')));

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

/** The scratch main checkout and its linked worktree, both under `…/spaced dir/`. */
const buildRepository = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lefthook-worktree-')));
  roots.push(root);
  const main = join(root, 'spaced dir', 'main');
  const worktree = join(root, 'spaced dir', 'wt one');
  mkdirSync(main, { recursive: true });
  // `scratchGitEnv` turns hooks off (`core.hooksPath=/dev/null`); this suite is the one that needs
  // them, so it points the path back at the repository's own hooks directory.
  const env = initScratchRepository(main, {
    parent: withoutInheritedLefthook(),
    initArgs: ['-b', 'main'],
    config: { 'core.hooksPath': join(main, '.git', 'hooks') },
    env: { LEFTHOOK_BIN: binaries.lefthook, NO_COLOR: '1', FORCE_COLOR: '0' },
  });
  const run = (command: string, args: string[], cwd: string) =>
    execFileSync(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });

  writeFileSync(join(main, 'lefthook.yml'), readFileSync(join(repositoryRoot, 'lefthook.yml')));
  writeFileSync(
    join(main, 'commitlint.config.js'),
    readFileSync(join(repositoryRoot, 'commitlint.config.js')),
  );
  writeFileSync(join(main, 'package.json'), '{ "type": "module", "private": true }\n');
  writeFileSync(join(main, '.gitignore'), '/node_modules\n');
  symlinkSync(join(repositoryRoot, 'node_modules'), join(main, 'node_modules'));
  run('git', ['add', '-A'], main);
  run('git', ['commit', '-q', '-m', 'chore: the scratch repository'], main);
  run(binaries.lefthook, ['install', 'commit-msg'], main);
  run('git', ['worktree', 'add', '-q', '-b', 'wt', worktree], main);
  symlinkSync(join(repositoryRoot, 'node_modules'), join(worktree, 'node_modules'));

  const attempt = (args: string[], cwd: string) => {
    const result = spawnSync('git', args, {
      cwd,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: CHILD_TIMEOUT_MS,
      killSignal: 'SIGKILL',
    });
    return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
  };
  let file = 0;
  const commit = (message: string, cwd = worktree) => {
    file += 1;
    writeFileSync(join(cwd, `change-${file}.txt`), `${file}\n`);
    run('git', ['add', `change-${file}.txt`], cwd);
    return attempt(['commit', '-q', '-m', message], cwd);
  };
  const merge = (message: string) =>
    attempt(['merge', '--no-ff', '-q', '-m', message, 'main'], worktree);
  const abortMerge = () => run('git', ['merge', '--abort'], worktree);
  const subject = () => run('git', ['log', '-1', '--format=%s'], worktree).toString().trim();
  return { main, worktree, commit, merge, abortMerge, subject };
};

describe('the commit-msg hook in a linked worktree under a spaced path (WP-215)', () => {
  it.skipIf(missing.length > 0)(
    missing.length > 0
      ? `skipped: ${missing.join(' and ')} not installed under node_modules/.bin`
      : 'commits a conventional message with exit 0, and refuses one that is not',
    () => {
      const { main, worktree, commit, merge, abortMerge, subject } = buildRepository();
      expect(worktree).toContain(' ');

      const accepted = commit('feat: a commit from a linked worktree');
      expect(accepted.output).not.toContain('Unknown argument');
      expect(accepted.status, accepted.output).toBe(0);
      expect(subject()).toBe('feat: a commit from a linked worktree');

      // Before the refused commit, on purpose: `COMMIT_EDITMSG` now holds the good message above,
      // so only a hook that reads git's argument (`MERGE_MSG`) refuses this merge. After the
      // refused commit it would hold a bad message, and a bare `--edit` would refuse it as well.
      const onMain = commit('feat: a commit on main', main);
      expect(onMain.status, onMain.output).toBe(0);
      const mergeRefused = merge('not a conventional merge');
      expect(mergeRefused.status, mergeRefused.output).not.toBe(0);
      expect(mergeRefused.output).toContain('subject may not be empty');
      abortMerge();
      expect(subject()).toBe('feat: a commit from a linked worktree');

      const refused = commit('not a conventional message');
      expect(refused.status, refused.output).not.toBe(0);
      expect(refused.output).toContain('subject may not be empty');
      expect(subject()).toBe('feat: a commit from a linked worktree');
    },
  );
});
