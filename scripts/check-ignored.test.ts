import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `check-ignored.mjs` against a **real** repository that contains other checkouts.
 *
 * A test that asserted the walk skips a directory *called* `worktrees` would test the name and not
 * the rule, and the rule is the whole fix: a directory holding a `.git` entry belongs to another
 * repository. So the fixture is built with git — `git worktree add` for the linked case, where
 * `.git` is a file holding a `gitdir:` pointer, and `git init` for the nested-clone case, where it
 * is a directory — and the script under test is the same file `pnpm run -s verify` runs, copied
 * into the fixture's `scripts/` because it derives the repository root from its own location.
 *
 * **Why it cannot pass for the wrong reason.** A "nothing was reported" assertion passes just as
 * happily on a guard that has been switched off, on a walk that found no files at all, and on a
 * fixture where nothing was ignored in the first place. All three are excluded, in the same run
 * and against the same fixture: the fixture asserts that git *does* ignore a file inside the
 * nested checkout (so those paths would be reported by an unfixed guard); the pass run asserts the
 * file count the guard reports, so an empty walk cannot masquerade as a clean one; and the second
 * half plants two genuinely swallowed source files — one under the classic unanchored `data/`,
 * one inside the ignored directory but *outside* any checkout — and requires the guard to name
 * exactly those two. That last one is what pins the skip to the `.git` boundary rather than to the
 * ignored subtree.
 */
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-ignored.mjs');
/** The guard imports this, so a fixture without it fails on an unresolved specifier. */
const OS_ARTEFACTS_MODULE = join(dirname(fileURLToPath(import.meta.url)), 'os-artefacts.mjs');

/**
 * The host's git configuration is not part of this fixture. A global `core.hooksPath`, a commit
 * template or a signing key would otherwise leak into it and make the test fail for reasons that
 * have nothing to do with the guard.
 */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Ignore Guard Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Ignore Guard Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const git = (cwd: string, ...args: readonly string[]): void => {
  const result = spawnSync('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `fixture setup failed: git ${args.join(' ')} exited ${result.status}: ${result.stderr}`,
    );
  }
};

const write = (path: string, contents: string): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
};

/** Runs the guard against `root` and returns what a caller of `verify` would see. */
const runGuard = (root: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-ignored.mjs')], {
    cwd: root,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  if (result.error !== undefined) {
    throw new Error(`could not run the guard: ${result.error.message}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/**
 * The paths the guard named, from its `  <gitignore>:<line>:<pattern>\t<path>` report lines.
 * Sorted, because the walk's order is `readdir`'s and that is the filesystem's business.
 */
const reportedPaths = (stderr: string): string[] =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim().split('\t').at(-1) ?? '')
    .filter((path) => path !== '')
    .sort();

/**
 * Generous on purpose: the fixture spawns git six times and node twice. A wall-clock budget is a
 * statement about the host and never about correctness, so it is sized well clear of the default
 * rather than nudged to whatever this machine happens to measure.
 */
const FIXTURE_TIMEOUT_MS = 60_000;

const roots: string[] = [];

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('check-ignored.mjs', () => {
  it(
    'walks past a nested checkout without reporting its files, and still catches a swallowed one',
    () => {
      // `realpathSync` because macOS's `/var` is a symlink to `/private/var`, and the guard
      // reports paths relative to the root it derives from its own location.
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'ignored-check-')));
      roots.push(root);

      // A repository shaped like this one where it matters: a tracked directory (`agent/`, this
      // fixture's `.claude/`) that also holds an ignored directory of checkouts, and a `data/`
      // rule left unanchored — the WP-06 bug, still latent because nothing is under it yet.
      write(join(root, '.gitignore'), '/agent/worktrees/\ndata/\n');
      write(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
      write(join(root, 'agent', 'keep.md'), '# agent instructions\n');
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(GUARD, join(root, 'scripts', 'check-ignored.mjs'));
      copyFileSync(OS_ARTEFACTS_MODULE, join(root, 'scripts', 'os-artefacts.mjs'));
      git(root, 'init', '-q', '-b', 'main', '.');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'fixture');

      // The two shapes of "somebody else's checkout", inside the ignored directory exactly as the
      // agent worktrees are: a linked worktree (`.git` is a file) and a nested repository
      // (`.git` is a directory).
      const linked = join(root, 'agent', 'worktrees', 'linked');
      git(root, 'worktree', 'add', '-q', '--detach', linked);
      const cloned = join(root, 'agent', 'worktrees', 'cloned');
      mkdirSync(cloned, { recursive: true });
      git(cloned, 'init', '-q', '-b', 'main', '.');
      write(join(cloned, 'src', 'other.ts'), 'export const other = 2;\n');

      // The fixture is what it claims to be. Without these three, "nothing was reported" is
      // satisfied by a fixture that never contained the hazard.
      expect(
        statSync(join(linked, '.git')).isFile(),
        'a linked worktree keeps .git as a file',
      ).toBe(true);
      expect(
        statSync(join(cloned, '.git')).isDirectory(),
        'a nested repository keeps .git as a directory',
      ).toBe(true);
      expect(existsSync(join(linked, 'src', 'app.ts'))).toBe(true);
      const ignoredInside = spawnSync(
        'git',
        ['check-ignore', '--no-index', '-q', 'agent/worktrees/linked/src/app.ts'],
        { cwd: root, env: GIT_ENV, encoding: 'utf8' },
      );
      expect(
        ignoredInside.status,
        'the nested checkout is not ignored by the fixture, so a green guard would prove nothing',
      ).toBe(0);

      const clean = runGuard(root);

      expect(
        reportedPaths(clean.stderr),
        'the guard descended into another checkout and reported files that are not this repository’s',
      ).toEqual([]);
      // 5, not 4: the fixture copies both `check-ignored.mjs` and the `os-artefacts.mjs` it
      // imports. The count is asserted exactly on purpose — it is what catches the guard
      // silently walking one directory too many.
      expect(clean.stdout.trim()).toBe('PASS: ignored:check (5 files, none ignored)');
      expect(clean.status).toBe(0);

      // Same fixture, same run: the guard is still live. One file under the unanchored `data/`
      // rule, and one inside the ignored directory but outside any checkout — the second is what
      // proves the skip stops at the `.git` boundary and not at the ignored subtree.
      write(join(root, 'src', 'data', 'queries.ts'), 'export const queries = 3;\n');
      write(join(root, 'agent', 'worktrees', 'stray.ts'), 'export const stray = 4;\n');

      const swallowed = runGuard(root);

      expect(
        reportedPaths(swallowed.stderr),
        'the guard stopped naming source files .gitignore hides',
      ).toEqual(['agent/worktrees/stray.ts', 'src/data/queries.ts']);
      expect(swallowed.stdout.trim()).toBe('FAIL: ignored:check');
      expect(swallowed.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'does not report an operating-system artefact as hidden source, and still reports its neighbour',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'ignored-check-os-')));
      roots.push(root);

      // An unanchored rule, the shape this guard exists for, with a real source file under it.
      write(join(root, '.gitignore'), 'buried/\n');
      write(join(root, 'src', 'app.ts'), 'export const app = 1;\n');
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(GUARD, join(root, 'scripts', 'check-ignored.mjs'));
      copyFileSync(OS_ARTEFACTS_MODULE, join(root, 'scripts', 'os-artefacts.mjs'));
      git(root, 'init', '-q', '-b', 'main', '.');
      git(root, 'add', '-A');
      git(root, 'commit', '-q', '-m', 'fixture');

      // Both files land in the same ignored directory, so the only thing that can separate them
      // is the name — which is the whole claim. Without the neighbour this test would pass on a
      // guard that had simply stopped walking (standing rule 4).
      write(join(root, 'src', 'buried', '.DS_Store'), 'not source\n');
      write(join(root, 'src', 'buried', 'real.ts'), 'export const real = 2;\n');

      // The fixture is what it claims to be: both paths really are ignored. A guard that reported
      // neither would otherwise look correct.
      for (const path of ['src/buried/.DS_Store', 'src/buried/real.ts']) {
        expect(
          spawnSync('git', ['check-ignore', '--no-index', '-q', path], {
            cwd: root,
            env: GIT_ENV,
            encoding: 'utf8',
          }).status,
          `${path} is not ignored by the fixture, so this test would prove nothing`,
        ).toBe(0);
      }

      const result = runGuard(root);

      // The artefact is silent; its neighbour is not. `.DS_Store` in `.claude/`, `apps/` and
      // `docs/` once turned `main` red for three files nobody wrote.
      expect(reportedPaths(result.stderr)).toEqual(['src/buried/real.ts']);
      expect(result.stdout.trim()).toBe('FAIL: ignored:check');
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );
});
