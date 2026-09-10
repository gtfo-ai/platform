import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
 * `check-conflict.mjs` against **real** repositories built with git.
 *
 * A guard shipped as a `scripts/*.mjs` verify step has no test tier of its own, so mutating it
 * passes the whole suite (standing rule 33) — `check-nul.test.ts` is the precedent this follows,
 * and every case here was written to kill a specific mutation of the guard, each of which was run.
 *
 * Two things this suite does that a "does it find the marker" test would not:
 *
 *  - **The corpus is git's, not ours.** One case makes a genuine merge conflict — two branches,
 *    `git merge`, `git add`, commit — which is the exact mechanism of `d1e7b69`, and asserts the
 *    guard fires on what *git* wrote rather than on a string this file typed. If a future git
 *    changes its marker, that case goes red here instead of silently going blind in production.
 *  - **The false positives are asserted as passes.** A Markdown setext heading, an empty GFM table
 *    row and a separator inside a fenced code block all sit in the clean fixture, so "it passed"
 *    is a statement about ambiguous content the guard deliberately admits, and the exact file count
 *    in the PASS line stops a walk that found nothing from masquerading as a clean one
 *    (standing rule 4).
 *
 * No literal marker appears in this file: they are built with `repeat`, the way a NUL byte is
 * written `\0` (CLAUDE.md). This file is tracked, so a literal one would make the guard fail on
 * its own test.
 */
const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'check-conflict.mjs');

/** The host's git configuration is not part of these fixtures (see `check-ignored.test.ts`). */
const GIT_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Conflict Guard Fixture',
  GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
  GIT_COMMITTER_NAME: 'Conflict Guard Fixture',
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

/** For the one command that is *expected* to fail: the merge that produces the conflict. */
const gitMayFail = (cwd: string, ...args: readonly string[]): number | null =>
  spawnSync('git', [...args], { cwd, env: GIT_ENV, encoding: 'utf8' }).status;

const roots: string[] = [];

/** One conflict-marker line: the character seven times, and an optional label after a space. */
const marker = (character: string, label?: string): string =>
  `${character.repeat(7)}${label === undefined ? '' : ` ${label}`}`;

const OPEN = marker('<', 'HEAD');
const SEPARATOR = marker('=');
const CLOSE = marker('>', 'main');

/** A whole conflict, the way git writes one. */
const conflict = (ours: string, theirs: string): string =>
  [OPEN, ours, SEPARATOR, theirs, CLOSE].join('\n');

/**
 * A repository containing `files`, all staged and committed, with the guard copied into
 * `scripts/` — the script derives the repository root from its own location — but deliberately
 * *not* tracked, so the fixture's file counts are the fixture's own.
 */
const repository = (files: Record<string, string | Uint8Array>): string => {
  // `realpathSync` because macOS's `/var` is a symlink to `/private/var`.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'conflict-check-')));
  roots.push(root);
  for (const [path, contents] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  mkdirSync(join(root, 'scripts'), { recursive: true });
  copyFileSync(GUARD, join(root, 'scripts', 'check-conflict.mjs'));
  git(root, 'init', '-q', '-b', 'main', '.');
  git(root, 'add', '-A', '--', ...Object.keys(files));
  git(root, 'commit', '-q', '-m', 'fixture');
  return root;
};

const runGuard = (root: string): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [join(root, 'scripts', 'check-conflict.mjs')], {
    cwd: root,
    env: GIT_ENV,
    encoding: 'utf8',
  });
  if (result.error !== undefined) {
    throw new Error(`could not run the guard: ${result.error.message}`);
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

/** The indented report lines, trimmed and sorted. */
const reported = (stderr: string): string[] =>
  stderr
    .split('\n')
    .filter((line) => line.startsWith('  '))
    .map((line) => line.trim())
    .sort();

const FIXTURE_TIMEOUT_MS = 60_000;

afterAll(() => {
  for (const root of roots) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('check-conflict.mjs', () => {
  it(
    'passes on content that only looks like a marker, and says how many files it examined',
    () => {
      const root = repository({
        // A setext H1 underline of exactly seven `=`: the ambiguity that decides the whole design.
        'README.md': `Fixture\n${SEPARATOR}\n\nrows:\n\n${marker('|')}\n`,
        // A separator inside a fenced code block, with no opening marker anywhere near it.
        'docs/style.md': ['```', 'title', SEPARATOR, '```', ''].join('\n'),
        // ASCII art: longer runs, and a run with something after it.
        'docs/banner.txt': `${'='.repeat(40)}\n${'='.repeat(9)} NOTE\n`,
        'src/a.ts': 'export const a = 1;\n',
      });
      // Untracked, and a whole conflict: the guard's scope is `git ls-files`, so a clean verdict
      // here is about tracked files and not about an empty disk.
      writeFileSync(join(root, 'scratch.ts'), `${conflict('const a = 1;', 'const a = 2;')}\n`);

      const result = runGuard(root);

      expect(result.stdout.trim()).toBe(
        'PASS: conflict:check (4 tracked text files, 0 declared binary, 0 exempt, no conflict markers and no .orig/.rej debris)',
      );
      expect(result.status).toBe(0);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'catches a conflict git itself wrote and committed — the d1e7b69 mechanism',
    () => {
      const root = repository({ 'CLAUDE.md': 'line one\nshared\n' });
      git(root, 'checkout', '-q', '-b', 'other');
      writeFileSync(join(root, 'CLAUDE.md'), 'line one\ntheirs\n');
      git(root, 'commit', '-q', '-am', 'theirs');
      git(root, 'checkout', '-q', 'main');
      writeFileSync(join(root, 'CLAUDE.md'), 'line one\nours\n');
      git(root, 'commit', '-q', '-am', 'ours');

      expect(
        gitMayFail(root, 'merge', 'other'),
        'the fixture merge succeeded, so there is no conflict to detect',
      ).not.toBe(0);
      // `git add` marks the conflicted file resolved without touching its content, and the commit
      // then succeeds: markers and all. That is exactly how they reached `main`.
      git(root, 'add', '-A', '--', 'CLAUDE.md');
      git(root, 'commit', '-q', '-m', 'merge');

      const result = runGuard(root);

      expect(
        reported(result.stderr).map((line) => line.replace(/ .*$/, '')),
        'the guard did not name the file git wrote markers into',
      ).toEqual(['CLAUDE.md:2:', 'CLAUDE.md:4:', 'CLAUDE.md:6:']);
      expect(result.stdout.trim()).toBe('FAIL: conflict:check');
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'catches the diff3 base section git writes with merge.conflictStyle=diff3',
    () => {
      const root = repository({ 'notes.txt': 'base\n' });
      git(root, 'checkout', '-q', '-b', 'other');
      writeFileSync(join(root, 'notes.txt'), 'theirs\n');
      git(root, 'commit', '-q', '-am', 'theirs');
      git(root, 'checkout', '-q', 'main');
      writeFileSync(join(root, 'notes.txt'), 'ours\n');
      git(root, 'commit', '-q', '-am', 'ours');

      expect(
        gitMayFail(root, '-c', 'merge.conflictStyle=diff3', 'merge', 'other'),
        'the fixture merge succeeded, so there is no conflict to detect',
      ).not.toBe(0);
      git(root, 'add', '-A', '--', 'notes.txt');
      git(root, 'commit', '-q', '-m', 'merge');

      const result = runGuard(root);
      const lines = reported(result.stderr);

      expect(
        lines.filter((line) => line.includes(marker('|'))),
        'the diff3 base section was not reported, so a diff3 conflict is half-invisible',
      ).not.toEqual([]);
      expect(lines).toHaveLength(4);
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'catches the longer markers a path declaring conflict-marker-size gets written into it',
    () => {
      // The docblock claims `{7,}` rather than `{7}` because a larger `conflict-marker-size`
      // produces longer runs. That is a claim about git, so git writes the fixture (rule 3).
      const root = repository({
        '.gitattributes': '/wide.txt conflict-marker-size=10\n',
        'wide.txt': 'base\n',
      });
      git(root, 'checkout', '-q', '-b', 'other');
      writeFileSync(join(root, 'wide.txt'), 'theirs\n');
      git(root, 'commit', '-q', '-am', 'theirs');
      git(root, 'checkout', '-q', 'main');
      writeFileSync(join(root, 'wide.txt'), 'ours\n');
      git(root, 'commit', '-q', '-am', 'ours');
      expect(gitMayFail(root, 'merge', 'other')).not.toBe(0);
      git(root, 'add', '-A', '--', 'wide.txt');
      git(root, 'commit', '-q', '-m', 'merge');

      expect(
        readFileSync(join(root, 'wide.txt'), 'utf8'),
        'git did not honour conflict-marker-size, so this fixture proves nothing',
      ).toContain('<'.repeat(10));

      const result = runGuard(root);

      expect(
        reported(result.stderr),
        'a wider marker than the default seven was not reported',
      ).toEqual([
        `wide.txt:1: ${'<'.repeat(10)} HEAD`,
        `wide.txt:3: ${'='.repeat(10)}`,
        `wide.txt:5: ${'>'.repeat(10)} other`,
      ]);
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'catches a marker on the first line, in a file with no extension, deeply nested, staged only',
    () => {
      const root = repository({
        // Line 1, byte 0: the mutation `check-nul` was found blind to (`indexOf(0, 1)`), and the
        // same shape here would be a loop starting at index 1.
        'first.ts': `${conflict('const a = 1;', 'const a = 2;')}\n`,
        // No extension at all: nothing about this guard's scope may depend on one.
        Makefile: `all:\n${conflict('\tours', '\ttheirs')}\n`,
        'a/b/c/d/e/f/g/deep.json': `{\n${conflict('  "a": 1', '  "a": 2')}\n}\n`,
        'clean.ts': 'export const clean = 1;\n',
      });
      // Staged and never committed: `git ls-files` lists it, and a guard reading `HEAD` would not.
      writeFileSync(join(root, 'staged.ts'), `x\n${conflict('const a = 1;', 'const a = 2;')}\n`);
      git(root, 'add', '-A', '--', 'staged.ts');

      const result = runGuard(root);
      const lines = reported(result.stderr);

      expect(lines, 'a marker at line 1 was missed').toContain(`first.ts:1: ${OPEN}`);
      expect(lines, 'a file with no extension was skipped').toContain(`Makefile:2: ${OPEN}`);
      expect(lines, 'a deeply nested path was skipped').toContain(
        `a/b/c/d/e/f/g/deep.json:2: ${OPEN}`,
      );
      expect(lines, 'a staged-but-uncommitted file was skipped').toContain(`staged.ts:2: ${OPEN}`);
      expect(lines.filter((line) => line.startsWith('clean.ts'))).toEqual([]);
      expect(result.stderr).toContain('(5 tracked text files examined)');
      expect(result.stdout.trim()).toBe('FAIL: conflict:check');
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'catches a conflict written with CRLF line endings',
    () => {
      const root = repository({
        'windows.ts': `${conflict('const a = 1;', 'const a = 2;')}\n`.replace(/\n/g, '\r\n'),
      });

      const result = runGuard(root);

      expect(
        reported(result.stderr),
        'the separator carried a trailing \\r and a `$`-anchored pattern missed it',
      ).toEqual([`windows.ts:1: ${OPEN}`, `windows.ts:3: ${SEPARATOR}`, `windows.ts:5: ${CLOSE}`]);
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'catches a conflict inside a fenced code block, which is where a doc example lives too',
    () => {
      const root = repository({
        'docs/merging.md': ['```diff', conflict('- old', '+ new'), '```', ''].join('\n'),
      });

      const result = runGuard(root);

      expect(
        reported(result.stderr),
        'a fence hid a conflict, and git writes markers inside fences too',
      ).toEqual([
        `docs/merging.md:2: ${OPEN}`,
        `docs/merging.md:4: ${SEPARATOR}`,
        `docs/merging.md:6: ${CLOSE}`,
      ]);
      expect(result.status).toBe(1);

      // And the exemption is what a genuine worked example uses: declared in the tree, per path.
      writeFileSync(join(root, '.gitattributes'), '/docs/merging.md conflict-markers\n');
      git(root, 'add', '-A', '--', '.gitattributes');

      const exempted = runGuard(root);

      expect(exempted.stdout.trim()).toBe(
        'PASS: conflict:check (1 tracked text files, 0 declared binary, 1 exempt, no conflict markers and no .orig/.rej debris)',
      );
      expect(exempted.status).toBe(0);

      // The exemption is per path and by exact spelling: a value is not the bare attribute, and
      // the path goes back to being checked rather than silently staying exempt.
      writeFileSync(join(root, '.gitattributes'), '/docs/merging.md conflict-markers=yes\n');
      git(root, 'add', '-A', '--', '.gitattributes');

      const misspelled = runGuard(root);

      expect(
        misspelled.status,
        'an attribute with a value exempted the path, so the exemption drifts open',
      ).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'catches a stray closing marker with nothing opened, and reports at most three lines a file',
    () => {
      const root = repository({
        // Half-resolved: somebody deleted the opening marker and their own side.
        'stray.ts': `const a = 1;\n${CLOSE}\n`,
        // Two conflicts in one file: six marker lines, three reported and three counted.
        'many.ts': `${conflict('a', 'b')}\n${conflict('c', 'd')}\n`,
      });

      const result = runGuard(root);

      expect(reported(result.stderr), 'a stray closing marker was not reported').toContain(
        `stray.ts:2: ${CLOSE}`,
      );
      expect(reported(result.stderr)).toContain('many.ts: and 3 more marker line(s)');
      expect(
        reported(result.stderr).filter((line) => /^many\.ts:\d/.test(line)),
        'the per-file report cap did not hold',
      ).toHaveLength(3);
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'catches a tracked .orig or .rej, which hold no markers to find',
    () => {
      const root = repository({
        // What `git apply --reject` leaves: diff hunks, no conflict marker anywhere in it.
        'src/a.ts.rej': '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-const a = 1;\n',
        'src/a.ts.ORIG': 'export const a = 1;\n',
        'src/a.ts': 'export const a = 1;\n',
      });

      const result = runGuard(root);

      expect(
        reported(result.stderr),
        'a leftover merge/patch artefact was tracked and nothing said so',
      ).toEqual([
        'src/a.ts.ORIG: a leftover merge/patch artefact is tracked',
        'src/a.ts.rej: a leftover merge/patch artefact is tracked',
      ]);
      expect(result.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'skips a path .gitattributes declares binary, and still checks the rest',
    () => {
      const root = repository({
        '.gitattributes': '/assets/logo.png binary\n/assets/blob.dat -text\n',
        'assets/logo.png': Buffer.from(`\x89PNG\r\n\x1a\n${OPEN}\n`),
        'assets/blob.dat': Buffer.from(`${SEPARATOR}\n`),
        'src/a.ts': 'export const a = 1;\n',
      });

      const clean = runGuard(root);

      expect(clean.stdout.trim()).toBe(
        'PASS: conflict:check (2 tracked text files, 2 declared binary, 0 exempt, no conflict markers and no .orig/.rej debris)',
      );
      expect(clean.status).toBe(0);

      writeFileSync(join(root, 'src', 'a.ts'), `${conflict('const a = 1;', 'const a = 2;')}\n`);
      git(root, 'add', '-A', '--', 'src/a.ts');

      const dirty = runGuard(root);

      expect(reported(dirty.stderr)).toEqual([
        `src/a.ts:1: ${OPEN}`,
        `src/a.ts:3: ${SEPARATOR}`,
        `src/a.ts:5: ${CLOSE}`,
      ]);
      expect(dirty.status).toBe(1);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails rather than passes when every tracked path is exempt',
    () => {
      const root = repository({
        '.gitattributes': '* conflict-markers\n',
        'src/a.ts': `${conflict('const a = 1;', 'const a = 2;')}\n`,
      });

      const result = runGuard(root);

      expect(
        result.stderr,
        'a `* conflict-markers` line switched the guard off and it reported success (rule 4)',
      ).toContain('examined none of the 2 tracked path(s)');
      expect(result.stdout.trim()).toBe('FAIL: conflict:check');
      expect(result.status).toBe(2);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails rather than passes when no tracked path can be read',
    () => {
      // The other route to an empty corpus: everything tracked is a path with no bytes of this
      // repository's to read. A dangling symlink is the cheapest one to build.
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'conflict-check-')));
      roots.push(root);
      symlinkSync('nowhere', join(root, 'link'));
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(GUARD, join(root, 'scripts', 'check-conflict.mjs'));
      git(root, 'init', '-q', '-b', 'main', '.');
      git(root, 'add', '-A', '--', 'link');
      git(root, 'commit', '-q', '-m', 'fixture');

      const result = runGuard(root);

      expect(result.stderr).toContain('examined none of the 1 tracked path(s)');
      expect(result.stdout.trim()).toBe('FAIL: conflict:check');
      expect(result.status).toBe(2);
    },
    FIXTURE_TIMEOUT_MS,
  );

  it(
    'fails rather than passes where git tracks nothing',
    () => {
      const root = realpathSync(mkdtempSync(join(tmpdir(), 'conflict-check-')));
      roots.push(root);
      mkdirSync(join(root, 'scripts'), { recursive: true });
      copyFileSync(GUARD, join(root, 'scripts', 'check-conflict.mjs'));
      git(root, 'init', '-q', '-b', 'main', '.');

      const result = runGuard(root);

      expect(result.stderr).toContain('found no tracked files to check');
      expect(result.stdout.trim()).toBe('FAIL: conflict:check');
      expect(result.status).toBe(2);
    },
    FIXTURE_TIMEOUT_MS,
  );
});
