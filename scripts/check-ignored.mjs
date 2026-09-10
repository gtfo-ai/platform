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
 * The check asks git itself — `git check-ignore --stdin` — about the union of two sets, and asks
 * git for the scope of both, because a guard with a hand-maintained scope drifts:
 *
 *  - **every tracked file** (`git ls-files`), which is the part that cannot drift.
 *  - **every file under the top-level directories git tracks anything in, and every root-level
 *    file of a type it tracks anything of**, tracked or not — the part that catches a file that has
 *    not been added yet, which is precisely the case that bit, because an ignored file can never
 *    become tracked and so would never appear in the first set.
 *
 * Both halves of that second scope used to be hand-written lists, and both had already drifted
 * once each; see `sourceRoots` and `rootFileExtensions` for what replaced them and for the one
 * case each still cannot see.
 *
 * **What no derivation can see**, stated so these are known limits rather than surprises. There
 * are two, and both are places where "this file belongs to this checkout" cannot be derived:
 *
 *  - The first file of an entirely new top-level directory that is *itself* ignored. Nothing
 *    distinguishes it from a developer's local scratch directory — this repository deliberately
 *    ignores `/data/` and `/logs/` — and a guard that fails on those gets switched off rather than
 *    fixed. The moment any file in that directory is tracked, the whole directory joins the walk.
 *  - Anything inside a **nested checkout**: a linked worktree, a nested clone or a submodule. The
 *    walk stops at any directory holding a `.git` entry (see `isSeparateCheckout`), because those
 *    files are another repository's to commit and reporting them is how this guard first turned
 *    red on a tree that was entirely correct — `.claude/worktrees/agent-<id>/` is an agent's
 *    checkout of this very repository, ignored on purpose, and every source file in it was named.
 *    A file of *this* checkout hidden under such a directory is therefore not examined; git will
 *    not track it there either, so it is not a file this repository could commit.
 *
 * Until then the defence in both cases is the anchoring convention in `CLAUDE.md` and reading
 * `.gitignore` diffs.
 *
 * Anything git names is a bug in `.gitignore`, not in the file.
 *
 * Prints exactly one `PASS: ignored:check` / `FAIL: ignored:check` line on stdout, like every
 * other verification step (docs/technical/14-orchestration-protocol.md).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { extname, join, relative, sep } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { OS_ARTEFACT_NAMES } from './os-artefacts.mjs';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Skipped while walking. These are names of build and dependency output, never of source: a
 * directory that is *called* `dist` and holds source is the only thing this can hide, and it is not
 * a thing that happens by accident the way an unanchored `.gitignore` pattern is.
 */
const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', 'build', 'coverage', '.git']);

/**
 * A directory that contains a `.git` entry belongs to **another checkout**, so the walk stops
 * there. This is git's own rule for where a repository ends, not a name this script maintains,
 * which is what makes it the complementary case to `SKIP_DIRECTORIES` rather than a second list.
 *
 * It exists because it happened, and it failed in the direction that gets a guard switched off:
 * `.claude/` is tracked, so it is a source root and is walked, and `.claude/worktrees/agent-<id>/`
 * is a linked git worktree — a whole second checkout of this repository, correctly ignored by
 * `.gitignore` and correctly not part of this one. Every one of its source files was reported as
 * swallowed. The scope was right (git said those paths are ignored); the paths were not this
 * checkout's to report.
 *
 * Both shapes are handled, because both occur: a **linked worktree** has `.git` as a *file*
 * holding a `gitdir:` pointer (verified: `.claude/worktrees/agent-<id>/.git` is 84 bytes of ASCII),
 * a nested clone or a submodule has it as a *directory*. `existsSync` does not care which, which is
 * the point — the property is "there is a `.git` here", not what kind of thing it is.
 *
 * What it gives up is exact and small: a source file in the *outer* checkout that happens to live
 * inside a nested checkout's directory is not examined. Such a file is not in the outer checkout's
 * index either — git will not track it — so it is not a file the outer repository could commit.
 */
const isSeparateCheckout = (directory) => existsSync(join(directory, '.git'));

/**
 * Every path git tracks. This is the part of the guard's scope that cannot drift, and it is also
 * what the rest of the scope is derived *from*.
 *
 * The first version of this script walked a hand-written list of source directories, so adding
 * `*.config.ts` or `.claude/` to `.gitignore` still passed while `vitest.config.ts` and the agent
 * definitions were quietly ignored. WP-06a added the repository root to the walk — and a second
 * hand-written list to keep the root walk from failing on `.env`. That one is worse than the
 * first, because an allow-list *suppresses* failures: its drift is silent and in the dangerous
 * direction. A guard with a hand-maintained scope drifts, so this one asks git what it tracks.
 */
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

const trackedPaths = tracked.stdout.split('\0').filter((path) => path !== '');

/**
 * Directories walked for files git does not know about yet: every top-level directory the
 * repository keeps something in.
 *
 * The repository root itself is **not** walked recursively — that would sweep in every directory a
 * developer happens to have (`.idea/`, `.vscode/`) and report them all as ignored source — but its
 * own files are, by `walkRootFiles`, because a new *untracked* file there (`vitest.workspace.ts`
 * next to a `/*.ts`-shaped rule) is caught by neither arm otherwise: `git ls-files` cannot see it,
 * since an ignored file can never become tracked, and no source root contains it.
 */
const sourceRoots = [
  ...new Set(trackedPaths.filter((path) => path.includes('/')).map((path) => path.split('/')[0])),
];

/**
 * Which untracked root-level files are treated as source: those whose extension the repository
 * already keeps under version control at its root — today `.ts`, `.json`, `.yml`, `.yaml`, `.js`,
 * `.md`, `.toml`, `.example`.
 *
 * That is the same answer the hand-written allow-list gave (`.env`, `.envrc`, `.DS_Store`,
 * `LICENSE` and friends have no extension at all; `.pem`, `.key`, `.log`, `.lcov`, `.swp` are
 * extensions nothing at the root is tracked under) without anybody having to maintain it, and it
 * grows on its own: the first `vitest.workspace.ts` is covered because `vitest.config.ts` is
 * tracked. `.env.example` stays covered, which matters — it is un-ignored by a `!` rule, and that
 * rule breaking is a real failure.
 *
 * **The hole, named rather than left to be discovered.** The *first* root-level file of a type
 * this repository has never tracked at its root, which is also ignored, is invisible here. It is
 * the narrowest form of the original bug and it fails safe in the only way that matters: adding a
 * second file of a type already tracked is covered, and every tracked path is covered regardless.
 */
const rootFileExtensions = new Set(
  trackedPaths
    .filter((path) => !path.includes('/'))
    .map((path) => extname(path))
    .filter((extension) => extension !== ''),
);

const walkRootFiles = () => {
  let entries;
  try {
    entries = readdirSync(repositoryRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && rootFileExtensions.has(extname(entry.name)))
    .map((entry) => entry.name);
};

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
      if (!SKIP_DIRECTORIES.has(entry.name) && !isSeparateCheckout(full)) {
        found.push(...walk(full));
      }
    } else if (entry.isFile() && !OS_ARTEFACT_NAMES.has(entry.name)) {
      // An OS artefact is not source, and reporting one as hidden source is a false positive that
      // turns `main` red for a file nobody wrote. `OS_ARTEFACT_NAMES` is shared with the
      // fixture-provenance walk so the two guards cannot answer this question differently again.
      // Every other name still fails loudly; a tracked path is checked regardless of its name.
      found.push(relative(repositoryRoot, full).split(sep).join('/'));
    }
  }
  return found;
};

const files = [
  ...new Set([
    ...trackedPaths,
    ...walkRootFiles(),
    ...sourceRoots.flatMap((root) => walk(join(repositoryRoot, root))),
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
