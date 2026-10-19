import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
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

/**
 * **A hook that cannot find lefthook refuses the commit** (WP-219, PROGRESS backlog 615 (d)).
 *
 * lefthook's hook tries `$LEFTHOOK_BIN`, `lefthook` on `PATH`, the absolute path of the
 * binary that installed it (2.1.12 wrote it unquoted, so a space in it split it; quoted since
 * 2.1.15, WP-222), the checkout's own
 * `node_modules`, and a list of package managers — and when all of them fail it printed
 * `Can't find lefthook in PATH` and exited **0**: the commit was made and the gitleaks job never
 * ran (measured, WP-219 (a)(ii)). `assert_lefthook_installed: true` in `lefthook.yml` turns that
 * last branch into `exit 1`. This case reaches that branch deterministically on any host: the
 * installing binary is a copy that is deleted after the install, the worktree has no
 * `node_modules`, and `PATH` holds only `git` and the system directories, so no package manager is
 * found. It asserts the branch it reached by its message (rule 10) and that no commit was made.
 */
describe('a pre-commit hook that cannot find lefthook (WP-219)', () => {
  it.skipIf(!existsSync(binaries.lefthook))(
    existsSync(binaries.lefthook)
      ? 'refuses the commit instead of skipping the secret scan'
      : 'skipped: lefthook not installed under node_modules/.bin',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'lefthook-absent-')));
      roots.push(root);
      const main = join(root, 'spaced dir', 'main');
      const worktree = join(root, 'spaced dir', 'bare wt');
      const installer = join(root, 'spaced dir', 'installer');
      mkdirSync(main, { recursive: true });
      mkdirSync(installer);
      const lefthookPackage = realpathSync(
        join(repositoryRoot, 'node_modules', 'lefthook', 'package.json'),
      );
      const { getExePath } = createRequire(lefthookPackage)('./get-exe.js') as {
        getExePath: () => string;
      };
      const installingBinary = join(installer, 'lefthook');
      copyFileSync(getExePath(), installingBinary);
      chmodSync(installingBinary, 0o755);

      const gitOnPath = (process.env.PATH ?? '')
        .split(delimiter)
        .map((directory) => join(directory, 'git'))
        .find((candidate) => candidate.startsWith('/') && existsSync(candidate));
      if (gitOnPath === undefined) throw new Error('no git on PATH');
      const binDirectory = join(root, 'bin');
      mkdirSync(binDirectory);
      symlinkSync(gitOnPath, join(binDirectory, 'git'));

      const env = initScratchRepository(main, {
        parent: withoutInheritedLefthook(),
        initArgs: ['-b', 'main'],
        config: { 'core.hooksPath': join(main, '.git', 'hooks') },
        env: { NO_COLOR: '1', FORCE_COLOR: '0' },
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
      writeFileSync(join(main, 'package.json'), '{ "type": "module", "private": true }\n');
      writeFileSync(join(main, '.gitignore'), '/node_modules\n');
      run('git', ['add', '-A'], main);
      run('git', ['commit', '-q', '-m', 'chore: the scratch repository'], main);
      run(installingBinary, ['install', 'pre-commit'], main);
      expect(readFileSync(join(main, '.git', 'hooks', 'pre-commit'), 'utf8')).toContain(
        installingBinary,
      );
      rmSync(installer, { recursive: true, force: true });
      run('git', ['worktree', 'add', '-q', '--detach', worktree], main);
      expect(existsSync(join(worktree, 'node_modules'))).toBe(false);

      writeFileSync(join(worktree, 'change.txt'), 'change\n');
      run('git', ['add', 'change.txt'], worktree);
      const result = spawnSync('git', ['commit', '-q', '-m', 'feat: a commit nothing scanned'], {
        cwd: worktree,
        env: { ...env, PATH: [binDirectory, '/usr/bin', '/bin'].join(delimiter) },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CHILD_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(output).toContain("Can't find lefthook in PATH");
      expect(output).toContain('Operation is aborted');
      expect(result.status, output).not.toBe(0);
      expect(run('git', ['log', '-1', '--format=%s'], worktree).toString().trim()).toBe(
        'chore: the scratch repository',
      );
    },
  );
});

/**
 * **A worktree commit never rewrites the shared hooks** (WP-222, PROGRESS backlog 623).
 *
 * Linked worktrees share `.git/hooks`. lefthook re-installs the hooks at run time when the running
 * checkout's `lefthook.yml` differs from the checksum it recorded (its auto-install), and it writes
 * them from **that** checkout's config with **that** run's binary path: a worktree commit rewrote
 * every checkout's hooks (measured, WP-219 (i) and WP-222 (a)(ii)). `no_auto_install: true` in
 * `lefthook.yml` turns the sync off. This case installs this checkout's `lefthook.yml` from a copied
 * binary, then commits from a linked worktree whose `lefthook.yml` declares a hook more (a
 * `post-commit`) and whose hook resolves to another binary (`LEFTHOOK_BIN`, standing in for any
 * branch that finds a binary other than the installer), and asserts the hooks directory is
 * byte-identical. Without the option the comparison names the rewritten hooks and the new one.
 * The pre-commit jobs are excluded by name (they need this checkout's scripts); the commit-msg job
 * runs and accepts the message, so the hook demonstrably ran lefthook (rule 10).
 */
describe('a commit from a worktree with a differing lefthook.yml (WP-222)', () => {
  it.skipIf(missing.length > 0)(
    missing.length > 0
      ? `skipped: ${missing.join(' and ')} not installed under node_modules/.bin`
      : 'leaves the shared hooks byte-identical',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'lefthook-sync-')));
      roots.push(root);
      const main = join(root, 'spaced dir', 'main');
      const worktree = join(root, 'spaced dir', 'sync wt');
      const installer = join(root, 'spaced dir', 'installer');
      mkdirSync(main, { recursive: true });
      mkdirSync(installer);
      const lefthookPackage = realpathSync(
        join(repositoryRoot, 'node_modules', 'lefthook', 'package.json'),
      );
      const { getExePath } = createRequire(lefthookPackage)('./get-exe.js') as {
        getExePath: () => string;
      };
      const installingBinary = join(installer, 'lefthook');
      copyFileSync(getExePath(), installingBinary);
      chmodSync(installingBinary, 0o755);

      const env = initScratchRepository(main, {
        parent: withoutInheritedLefthook(),
        initArgs: ['-b', 'main'],
        config: { 'core.hooksPath': join(main, '.git', 'hooks') },
        env: { NO_COLOR: '1', FORCE_COLOR: '0' },
      });
      const run = (command: string, args: string[], cwd: string) =>
        execFileSync(command, args, {
          cwd,
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: CHILD_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        });
      const config = readFileSync(join(repositoryRoot, 'lefthook.yml'), 'utf8');
      writeFileSync(join(main, 'lefthook.yml'), config);
      writeFileSync(
        join(main, 'commitlint.config.js'),
        readFileSync(join(repositoryRoot, 'commitlint.config.js')),
      );
      writeFileSync(join(main, 'package.json'), '{ "type": "module", "private": true }\n');
      writeFileSync(join(main, '.gitignore'), '/node_modules\n');
      run('git', ['add', '-A'], main);
      run('git', ['commit', '-q', '-m', 'chore: the scratch repository'], main);
      run(installingBinary, ['install'], main);
      run('git', ['worktree', 'add', '-q', '--detach', worktree], main);
      symlinkSync(join(repositoryRoot, 'node_modules'), join(worktree, 'node_modules'));

      const hooksDirectory = join(main, '.git', 'hooks');
      const hooks = () =>
        Object.fromEntries(
          readdirSync(hooksDirectory)
            .filter((name) => !name.endsWith('.sample'))
            .sort()
            .map((name) => [name, readFileSync(join(hooksDirectory, name), 'utf8')]),
        );
      const before = hooks();
      expect(Object.keys(before)).toContain('pre-commit');
      expect(before['pre-commit']).toContain(installingBinary);

      // Load-bearing: lefthook trusts an unchanged modification second over the checksum, so the
      // differing file is dated apart from the installed one. Without this line the canary (the
      // option removed) is not dead but flaky — it fails only when the two writes straddle a
      // second (measured, WP-222 review round 1: 1 failure in 3).
      const worktreeConfig = join(worktree, 'lefthook.yml');
      writeFileSync(
        worktreeConfig,
        `${config}\npost-commit:\n  jobs:\n    - name: noop\n      run: "true"\n`,
      );
      const past = Date.now() / 1000 - 3600;
      utimesSync(worktreeConfig, past, past);

      writeFileSync(join(worktree, 'change.txt'), 'change\n');
      run('git', ['add', 'change.txt'], worktree);
      const result = spawnSync('git', ['commit', '-q', '-m', 'feat: a commit from a worktree'], {
        cwd: worktree,
        env: { ...env, LEFTHOOK_BIN: binaries.lefthook, LEFTHOOK_EXCLUDE: 'gitleaks,biome' },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CHILD_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
      expect(result.status, output).toBe(0);
      expect(output).toContain('commitlint');
      expect(hooks()).toEqual(before);
    },
  );
});

/**
 * **The generated hook quotes the installing binary's path** (WP-222, PROGRESS backlog 622).
 *
 * lefthook 2.1.12 wrote `elif <path> -h` unquoted, so a space in the checkout's path split it and
 * the hook fell through to `pnpm lefthook` (WP-219 (a)(ii)); 2.1.15 quotes it (lefthook PR 1509).
 * This case installs with the pinned binary, copied to a spaced directory, and asserts the line
 * names that path inside single quotes, so a downgrade fails here (measured with 2.1.12, WP-222
 * review round 1).
 */
describe('the hook the pinned lefthook writes (WP-222)', () => {
  it.skipIf(!existsSync(binaries.lefthook))(
    existsSync(binaries.lefthook)
      ? 'quotes the installing binary path that holds a space'
      : 'skipped: lefthook not installed under node_modules/.bin',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'lefthook-quote-')));
      roots.push(root);
      const main = join(root, 'spaced dir', 'main');
      const installer = join(root, 'spaced dir', 'installer');
      mkdirSync(main, { recursive: true });
      mkdirSync(installer);
      const lefthookPackage = realpathSync(
        join(repositoryRoot, 'node_modules', 'lefthook', 'package.json'),
      );
      const { getExePath } = createRequire(lefthookPackage)('./get-exe.js') as {
        getExePath: () => string;
      };
      const installingBinary = join(installer, 'lefthook');
      copyFileSync(getExePath(), installingBinary);
      chmodSync(installingBinary, 0o755);
      const env = initScratchRepository(main, {
        parent: withoutInheritedLefthook(),
        initArgs: ['-b', 'main'],
        config: { 'core.hooksPath': join(main, '.git', 'hooks') },
        env: { NO_COLOR: '1', FORCE_COLOR: '0' },
      });
      writeFileSync(join(main, 'lefthook.yml'), readFileSync(join(repositoryRoot, 'lefthook.yml')));
      execFileSync(installingBinary, ['install', 'pre-commit'], {
        cwd: main,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: CHILD_TIMEOUT_MS,
        killSignal: 'SIGKILL',
      });
      const hook = readFileSync(join(main, '.git', 'hooks', 'pre-commit'), 'utf8');
      expect(installingBinary).toContain(' ');
      expect(hook).toContain(`elif '${installingBinary}' -h >/dev/null 2>&1`);
      expect(hook).toContain(`'${installingBinary}' "$@"`);
    },
  );
});
