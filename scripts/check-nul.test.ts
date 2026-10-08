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
import { initScratchRepository, scratchGitEnv } from './git-scratch-env.mjs';

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
 * *contains* a NUL byte, in an **ignored** file, so "no offender" is a statement about the guard's
 * scope rather than about an empty tree; and the premise of the whole guard — that git classifies
 * such a blob as binary and stops diffing it — is asserted against git itself rather than trusted
 * from the docblock (standing rule 3).
 *
 * **The scope case used to pin the hole** (backlog 10). It planted an untracked file full of NUL
 * bytes and expected a PASS, because the guard read `git ls-files` alone. Since WP-68 the scope is
 * `census-files.mjs`'s — tracked plus untracked-but-not-ignored — and that case expects the
 * untracked file **named**, with an ignored one beside it as the control.
 */
const SCRIPTS = dirname(fileURLToPath(import.meta.url));

/** The host's git configuration is not part of these fixtures (see `check-ignored.test.ts`). */
const FIXTURE_AUTHOR = { name: 'NUL Guard Fixture', email: 'fixture@example.invalid' };
/** `scratchGitEnv` (WP-162): no inherited `GIT_*`, no host configuration, no hooks, a ceiling. */
const gitEnv = (root: string): Record<string, string> =>
  scratchGitEnv(root, { author: FIXTURE_AUTHOR });

const git = (cwd: string, ...args: readonly string[]): string => {
  const result = spawnSync('git', [...args], { cwd, env: gitEnv(cwd), encoding: 'utf8' });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(
      `fixture setup failed: git ${args.join(' ')} exited ${result.status}: ${result.stderr}`,
    );
  }
  return result.stdout;
};

const roots: string[] = [];

/**
 * A repository containing `files`, all staged and committed, with the guard and its census helper
 * copied into `scripts/` — the script derives the repository root from its own location — and
 * `scripts/` excluded through `.git/info/exclude`, so the fixture's file counts are the fixture's
 * own and not the guard's.
 */
const installGuard = (root: string): void => {
  mkdirSync(join(root, 'scripts'), { recursive: true });
  for (const file of ['check-nul.mjs', 'census-files.mjs']) {
    copyFileSync(join(SCRIPTS, file), join(root, 'scripts', file));
  }
};

/** Ignores the guard's own copy, through the file `--exclude-standard` reads besides `.gitignore`. */
const excludeGuard = (root: string): void => {
  writeFileSync(join(root, '.git', 'info', 'exclude'), '/scripts/\n');
};

const repository = (files: Record<string, string | Uint8Array>): string => {
  // `realpathSync` because macOS's `/var` is a symlink to `/private/var`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'nul-check-')));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  installGuard(root);
  initScratchRepository(root, { author: FIXTURE_AUTHOR, initArgs: ['-b', 'main', '.'] });
  excludeGuard(root);
  git(root, 'add', '-A', '--', ...Object.keys(files));
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
};

const runGuard = (root: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-nul.mjs')], {
    cwd: root,
    env: gitEnv(root),
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
        '.gitignore': '/ignored.ts\n',
        'README.md': '# fixture\n',
        'src/a.ts': 'export const a = 1;\n',
        'src/b.ts': 'export const b = 2;\n',
      });
      // Ignored, and full of NUL bytes: an ignored file is not a source file, so a clean verdict
      // here is about the scope and not about an empty disk.
      writeFileSync(join(root, 'ignored.ts'), Buffer.from('const x = "\0";\n'));

      const result = runGuard(root);

      expect(result.stdout.trim()).toBe(
        'PASS: nul:check (4 text files tracked or untracked, 0 declared binary, none with a NUL byte)',
      );
      expect(result.status).toBe(0);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'names a NUL in a file nobody has staged yet, and not one in an ignored file',
    () => {
      // Backlog 10's own case: WP-16 wrote two NULs into brand-new files and the guard said PASS,
      // because its scope was `git ls-files`. The untracked file must be named; the ignored one
      // beside it is the control that tells "reads untracked files" from "reads the whole disk".
      const root = repository({
        '.gitignore': '/ignored.ts\n',
        'src/a.ts': 'export const a = 1;\n',
      });
      writeFileSync(join(root, 'src', 'new.ts'), Buffer.from('const x = "\0";\n'));
      writeFileSync(join(root, 'ignored.ts'), Buffer.from('const y = "\0";\n'));

      const result = runGuard(root);

      expect(offenders(result.stderr)).toEqual(['src/new.ts:1 (byte 11)']);
      expect(result.stdout.trim()).toBe('FAIL: nul:check');
      expect(result.status).toBe(1);
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
      expect(result.stderr).toContain('2 source file(s) contain a literal NUL byte');
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
        'PASS: nul:check (2 text files tracked or untracked, 2 declared binary, none with a NUL byte)',
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
      ).toContain('examined none of the 2 path(s)');
      expect(result.stdout.trim()).toBe('FAIL: nul:check');
      expect(result.status).toBe(2);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails rather than passes when no path can be read, and names each one it could not read',
    () => {
      // The other route to an empty corpus: everything listed is a path with no bytes of this
      // repository's to read. A dangling symlink is the cheapest one to build; a submodule
      // gitlink behaves the same way. It used to be skipped in silence; it is named now.
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'nul-check-')));
      roots.push(root);
      symlinkSync('nowhere', join(root, 'link'));
      installGuard(root);
      initScratchRepository(root, { author: FIXTURE_AUTHOR, initArgs: ['-b', 'main', '.'] });
      excludeGuard(root);
      git(root, 'add', '-A', '--', 'link');
      git(root, 'commit', '-q', '-m', 'fixture');

      const result = runGuard(root);

      expect(result.stderr).toContain('not checked: link (a symbolic link that cannot be followed');
      expect(result.stderr).toContain('examined none of the 1 path(s)');
      expect(result.stdout.trim()).toBe('FAIL: nul:check');
      expect(result.status).toBe(2);

      // Beside a readable file the verdict is a pass, and the unreadable path is still in it.
      writeFileSync(join(root, 'a.ts'), 'export const a = 1;\n');
      const beside = runGuard(root);
      expect(beside.stdout.trim()).toBe(
        'PASS: nul:check (1 text files tracked or untracked, 0 declared binary, 1 not readable (named above), none with a NUL byte)',
      );
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails rather than passes in a repository that holds no source file',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'nul-check-')));
      roots.push(root);
      installGuard(root);
      initScratchRepository(root, { author: FIXTURE_AUTHOR, initArgs: ['-b', 'main', '.'] });
      excludeGuard(root);

      const result = runGuard(root);

      expect(result.stderr).toContain('found no files to check');
      expect(result.stdout.trim()).toBe('FAIL: nul:check');
      expect(result.status).toBe(2);
    },
    FIXTURE_TIMEOUT_MS,
  );
});
