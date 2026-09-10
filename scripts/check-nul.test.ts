import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * `check-nul.mjs` against **real** repositories built with git.
 *
 * The guard existed with no test at all: its evidence was a set of canaries run by hand in one
 * session, and a session ends. The reviewer measured what that costs — mutating `contents.indexOf(0)`
 * to `contents.indexOf(0, 1)`, so a NUL as the *first* byte of a file is missed, left **2353 of
 * 2353 tests green**. Every case below exists to kill a mutation of that kind, and each was run.
 *
 * **Why it cannot pass for the wrong reason.** The clean case asserts the exact file count in the
 * PASS line, so a walk that found nothing cannot masquerade as a clean one; the fixture it runs on
 * *contains* a NUL byte, in an untracked file, so "no offender" is a statement about the guard's
 * scope rather than about an empty tree; and the premise of the whole guard — that git classifies
 * such a blob as binary and stops diffing it — is asserted against git itself rather than trusted
 * from the docblock (standing rule 3).
 */
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-nul.mjs');

/** The host's git configuration is not part of these fixtures (see `check-ignored.test.ts`). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'NUL Guard Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'NUL Guard Fixture',
  GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
};

const git = (cwd: string, ...args: readonly string[]): string => {
  const result = spawnSync('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `fixture setup failed: git ${args.join(' ')} exited ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout;
};

const roots: string[] = [];

/**
 * A repository containing `files`, all staged and committed, with the guard copied into
 * `scripts/` — the script derives the repository root from its own location — but deliberately
 * *not* tracked, so the fixture's file counts are the fixture's own.
 */
const repository = (files: Record<string, string | Uint8Array>): string => {
  // `realpathSync` because macOS's `/var` is a symlink to `/private/var`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nul-check-')));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(GUARD, join(root, 'scripts', 'check-nul.mjs'));
  git(root, 'init', '-q', '-b', 'main', '.');
  git(root, 'add', '-A', '--', ...Object.keys(files));
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
};

const runGuard = (root: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-nul.mjs')], {
    cwd: root,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  if (result.error !== undefined) {
    throw new Error(`could not run the guard: ${result.error.message}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** The `  <path>:<line> (byte <n>)` lines of the report, sorted. */
const offenders = (stderr: string): string[] =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith('  ') && line.includes('(byte '))
    .map((line) => line.trim())
    .sort();

const FIXTURE_TIMEOUT_MS = 60_000;

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('check-nul.mjs', () => {
  it(
    'passes on a tree of text files, and says how many it examined',
    () => {
      const root = repository({
        'README.md': '# fixture\n',
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 2;\n',
      });
      // Untracked, and full of NUL bytes: the guard's scope is `git ls-files`, so a clean verdict
      // here is about tracked files and not about an empty disk.
      writeFileSync(join(root, 'scratch.ts'), Buffer.from('const x = "\0";\n'));

      const result = runGuard(root);

      expect(result.stdout.trim()).toBe(
        'PASS: nul:check (3 tracked text files, 0 declared binary, none with a NUL byte)',
      );
      expect(result.status).toBe(0);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'names a file whose very first byte is NUL, and one whose name contains a newline',
    () => {
      // Byte 0 is the mutation the reviewer found alive: `contents.indexOf(0, 1)` misses this file
      // and nothing else in the repository would notice.
      const leading = Buffer.from('\0export const leading = 1;\n');
      // A newline in a filename is what `git ls-files -z` is for: without `-z` git quotes the name
      // and the record separator becomes ambiguous.
      const newlineName = 'src/two\nlines.ts';
      const root = repository({
        'src/leading.ts': leading,
        [newlineName]: Buffer.from('const first = 1;\nconst second = "\0";\n'),
        'src/clean.ts': 'export const clean = 3;\n',
      });

      // The premise of the guard, asserted against git rather than quoted from its docblock: a blob
      // with a NUL is binary, and `--numstat` prints `-` for both counts instead of a diff.
      expect(
        git(root, 'show', '--numstat', '--format=', 'HEAD'),
        'git no longer treats a NUL-bearing blob as binary, which is the whole reason for this guard',
      ).toContain('-\t-\tsrc/leading.ts');

      const result = runGuard(root);

      // Asserted against the raw report rather than through `offenders()`: a path containing a
      // newline is itself two "lines" of the report, which is precisely why the guard asks git for
      // the file list with `-z` and hands it back over `--stdin` NUL-delimited.
      expect(result.stderr).toContain('  src/leading.ts:1 (byte 0)\n');
      expect(result.stderr).toContain('  src/two\nlines.ts:2 (byte 33)\n');
      expect(result.stderr).toContain('2 tracked source file(s) contain a literal NUL byte');
      expect(result.stdout.trim()).toBe('FAIL: nul:check');
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'skips a path .gitattributes declares binary, in either spelling, and still checks the rest',
    () => {
      const root = repository({
        '.gitattributes': '/assets/logo.png binary\n/assets/blob.dat -text\n',
        'assets/logo.png': Buffer.from('\x89PNG\r\n\x1a\n\0\0\0'),
        'assets/blob.dat': Buffer.from('\0\0\0'),
        'src/a.ts': 'export const a = 1;\n',
      });

      const clean = runGuard(root);

      expect(clean.stdout.trim()).toBe(
        'PASS: nul:check (2 tracked text files, 2 declared binary, none with a NUL byte)',
      );
      expect(clean.status).toBe(0);

      // The exemption is per path, not a mode: a NUL in a file nobody declared is still a failure
      // in the same repository.
      writeFileSync(join(root, 'src', 'a.ts'), Buffer.from('export const a = "\0";\n'));
      git(root, 'add', '-A', '--', 'src/a.ts');

      const dirty = runGuard(root);

      expect(offenders(dirty.stderr)).toEqual(['src/a.ts:1 (byte 18)']);
      expect(dirty.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails rather than passes when every tracked path is declared binary',
    () => {
      const root = repository({
        '.gitattributes': '* binary\n',
        'src/a.ts': 'export const a = 1;\n',
      });

      const result = runGuard(root);

      expect(
        result.stderr,
        'a `* binary` line switched the guard off and it reported success (standing rule 4)',
      ).toContain('examined none of the 2 tracked path(s)');
      expect(result.stdout.trim()).toBe('FAIL: nul:check');
      expect(result.status).toBe(2);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails rather than passes when no tracked path can be read',
    () => {
      // The other route to an empty corpus: everything tracked is a path with no bytes of this
      // repository's to read. A dangling symlink is the cheapest one to build; a submodule
      // gitlink behaves the same way.
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'nul-check-')));
      roots.push(root);
      symlinkSync('nowhere', join(root, 'link'));
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(GUARD, join(root, 'scripts', 'check-nul.mjs'));
      git(root, 'init', '-q', '-b', 'main', '.');
      git(root, 'add', '-A', '--', 'link');
      git(root, 'commit', '-q', '-m', 'fixture');

      const result = runGuard(root);

      expect(result.stderr).toContain('examined none of the 1 tracked path(s)');
      expect(result.stdout.trim()).toBe('FAIL: nul:check');
      expect(result.status).toBe(2);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails rather than passes outside a repository, where git tracks nothing',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'nul-check-')));
      roots.push(root);
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(GUARD, join(root, 'scripts', 'check-nul.mjs'));
      git(root, 'init', '-q', '-b', 'main', '.');

      const result = runGuard(root);

      expect(result.stderr).toContain('found no tracked files to check');
      expect(result.stdout.trim()).toBe('FAIL: nul:check');
      expect(result.status).toBe(2);
    },
    FIXTURE_TIMEOUT_MS,
  );
});
