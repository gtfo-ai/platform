#!/usr/bin/env node
/**
 * Fails when `.gitignore` swallows a source file.
 *
 * This exists because it happened. WP-06 added `apps/server/src/data/identity-queries.ts` while
 * `.gitignore` carried an unanchored `data/`, and git's rule is that a pattern without a leading
 * slash matches a directory of that name at **any** depth. The file was therefore invisible to
 * `git status` and `git add`, while every local check stayed green — it was on disk, so it
 * typechecked, imported and tested. The failure would only have appeared as a pushed tree that
 * cannot compile.
 *
 * Nothing else catches this. Lint reads the working tree, so does the compiler, and so does the
 * test runner; only git disagrees, and only about files that do not exist yet in its index.
 *
 * The check asks git itself — `git check-ignore --stdin` — about the union of two sets:
 *
 *  - **every tracked file** (`git ls-files`), which is the part that cannot drift. A hand-listed
 *    set of source directories is the next thing to go stale: the first version of this script
 *    walked `apps/ packages/ test/ …` and so covered no repository-root file and not `.claude/`,
 *    which meant adding `*.config.ts` or `.claude/` to `.gitignore` still passed while
 *    `vitest.config.ts` and the agent definitions were quietly ignored.
 *  - **every file under the source roots**, tracked or not, which is the part that catches a file
 *    that has not been added yet — precisely the case that bit, because an ignored file can never
 *    become tracked and so would never appear in the first set.
 *
 * Anything git names is a bug in `.gitignore`, not in the file.
 *
 * Prints exactly one `PASS: ignored:check` / `FAIL: ignored:check` line on stdout, like every
 * other verification step (docs/technical/14-orchestration-protocol.md).
 */
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Directories walked for files git does not know about yet. This list may be incomplete without
 * weakening the guard — everything already tracked is covered by `git ls-files` regardless.
 */
const SOURCE_ROOTS = [
  'apps',
  'packages',
  'test',
  'scripts',
  'schemas',
  'docs',
  '.github',
  '.claude',
];

/** Skipped while walking: genuinely generated or vendored, and legitimately ignored. */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

const walk = (directory) => {
  const found = [];
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRECTORIES.has(entry.name)) {
        found.push(...walk(full));
      }
    } else if (entry.isFile()) {
      found.push(relative(repositoryRoot, full).split(sep).join('/'));
    }
  }
  return found;
};

const tracked = spawnSync('git', ['ls-files', '-z'], {
  cwd: repositoryRoot,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
});

if (tracked.error || tracked.status !== 0) {
  process.stderr.write(
    `could not list tracked files: ${tracked.error?.message ?? tracked.stderr}\n`,
  );
  process.stdout.write('FAIL: ignored:check\n');
  process.exit(2);
}

const files = [
  ...new Set([
    ...tracked.stdout.split('\0').filter((path) => path !== ''),
    ...SOURCE_ROOTS.flatMap((root) => walk(join(repositoryRoot, root))),
  ]),
];

if (files.length === 0) {
  process.stderr.write('found no source files to check; is this the repository root?\n');
  process.stdout.write('FAIL: ignored:check\n');
  process.exit(2);
}

// `--stdin` with `--no-index` reports every path any pattern matches, tracked or not. Without
// `--no-index`, git skips files it already tracks, which would hide exactly the case that bites:
// a *new* file under a directory an old pattern matches.
const result = spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
  cwd: repositoryRoot,
  input: `${files.join('\n')}\n`,
  encoding: 'utf8',
});

if (result.error) {
  process.stderr.write(`could not run git check-ignore: ${result.error.message}\n`);
  process.stdout.write('FAIL: ignored:check\n');
  process.exit(2);
}

// Exit status 0 means "at least one path is ignored", 1 means "none are". Anything else is an error.
if (result.status !== 0 && result.status !== 1) {
  process.stderr.write(`git check-ignore exited with ${result.status}: ${result.stderr}\n`);
  process.stdout.write('FAIL: ignored:check\n');
  process.exit(2);
}

const ignored = result.stdout
  .split('\n')
  .map((line) => line.trim())
  .filter((line) => line !== '');

if (ignored.length > 0) {
  process.stderr.write(
    `.gitignore hides ${ignored.length} source file(s). git would not commit them, and every local check would still pass:\n`,
  );
  for (const path of ignored) {
    const why = spawnSync('git', ['check-ignore', '--no-index', '-v', path], {
      cwd: repositoryRoot,
      encoding: 'utf8',
    });
    process.stderr.write(`  ${why.stdout.trim() || path}\n`);
  }
  process.stderr.write(
    'Anchor the offending pattern to the repository root (a leading "/") or narrow it.\n',
  );
  process.stdout.write('FAIL: ignored:check\n');
  process.exit(1);
}

process.stdout.write(`PASS: ignored:check (${files.length} files, none ignored)\n`);
