/**
 * Which files a census reads, and what it does with a path it cannot read — one answer for every
 * guard in this repository that asks git for a file list and then reads the files (WP-68).
 *
 * ## The two holes it closes, once
 *
 * **Scope** (backlog 10, standing rule 85). A census that reads only `git ls-files` is blind to the
 * file somebody is writing right now — which is exactly the file a new mistake is in — until it is
 * staged. So the list is the tracked set **plus** `git ls-files --others --exclude-standard`.
 * **Ignored files are not read, by decision: an ignored file is not a source file, and an untracked
 * one is.** `--exclude-standard` is the whole of that decision (`.gitignore`, `.git/info/exclude`,
 * the user's global excludes file).
 *
 * **A path that vanished between the listing and the read** (backlog 10's second column). A
 * concurrent editor, a rebase in another worktree, or a fixture another test in the same run plants
 * and deletes can remove a listed path before it is read. Such a path is **dropped** — it is no
 * longer part of the tree — and returned as `vanished` so a caller can say so. A path that still
 * exists but cannot be read (a dangling symlink, a directory where git lists a gitlink, a permission
 * error) is **not** dropped: it is returned as `unreadable` with the reason, and `censusFiles`
 * throws naming every one, so a census reports what it did not check instead of skipping it in
 * silence or crashing on the first `ENOENT` with nothing said about the rest.
 *
 * `lstat` is what tells the two apart: a path with no directory entry vanished; a path with an
 * entry whose contents cannot be had is unreadable. A symlink is followed, as `readFileSync` does.
 *
 * ## Who uses it
 *
 * Every census that reads a git file list: the two `verify` scripts (`check-nul.mjs`,
 * `check-conflict.mjs`) and the unit-tier censuses under `packages/`, `apps/` and `scripts/`. A
 * census under `packages/` or `apps/` imports it by relative path, which the dependency rule in
 * `biome.json` denies for everything else under `scripts/` — this one file is re-allowed there by
 * name, because it is test infrastructure and belongs to no ring. `census-files.test.ts` builds a
 * repository with a tracked, an untracked, an ignored, a vanished and an unreadable path and holds
 * all five answers.
 *
 * Plain JavaScript for the reason `os-artefacts.mjs` gives: the `verify` scripts run it with no
 * TypeScript resolver loaded. `census-files.d.mts` carries the types.
 */
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const gitList = (root, args, pathspecs) =>
  execFileSync('git', [...args, '-z', '--', ...pathspecs], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter((path) => path.length > 0);

/**
 * Every path git knows about under `root` and does not ignore — tracked, staged or untracked —
 * sorted and without duplicates. `pathspecs` narrows both halves the same way; `include` filters
 * the result.
 */
export function censusPaths(root, { pathspecs = [], include = () => true } = {}) {
  const paths = new Set([
    ...gitList(root, ['ls-files'], pathspecs),
    ...gitList(root, ['ls-files', '--others', '--exclude-standard'], pathspecs),
  ]);
  return [...paths].filter((path) => include(path)).sort();
}

const describeUnreadable = (full, error) => {
  try {
    const entry = lstatSync(full);
    if (entry.isDirectory()) {
      return 'a directory, not a file (a gitlink or a submodule)';
    }
    if (entry.isSymbolicLink()) {
      return `a symbolic link that cannot be followed (${error.code ?? error.message})`;
    }
  } catch {
    // Fall through to the read error itself.
  }
  return error.code ?? error.message;
};

/**
 * Reads `paths` under `root`: `files` in listing order, `vanished` for a path that no longer
 * exists, `unreadable` for a path that exists and could not be read. `encoding: null` answers
 * bytes.
 */
export function readCensus(root, paths, { encoding = 'utf8' } = {}) {
  const files = [];
  const vanished = [];
  const unreadable = [];
  for (const path of paths) {
    const full = join(root, path);
    try {
      files.push({ path, contents: readFileSync(full, encoding === null ? undefined : encoding) });
    } catch (error) {
      let exists = true;
      try {
        lstatSync(full);
      } catch {
        exists = false;
      }
      if (exists) {
        unreadable.push({ path, reason: describeUnreadable(full, error) });
      } else {
        vanished.push(path);
      }
    }
  }
  return { files, vanished, unreadable };
}

/** Thrown by `censusFiles` when a listed path exists and could not be read. */
export class CensusUnreadableError extends Error {
  constructor(unreadable) {
    super(
      `the census could not read ${unreadable.length} path(s) it is responsible for, so it has not checked them:\n${unreadable
        .map(({ path, reason }) => `  ${path}: ${reason}`)
        .join('\n')}`,
    );
    this.name = 'CensusUnreadableError';
    this.unreadable = unreadable;
  }
}

/**
 * The census list and its contents in one call — what a census under `packages/` or `apps/` wants.
 * Vanished paths are dropped; an unreadable one throws `CensusUnreadableError` naming all of them.
 */
export function censusFiles(root, options = {}) {
  const { files, unreadable } = readCensus(root, censusPaths(root, options), options);
  if (unreadable.length > 0) {
    throw new CensusUnreadableError(unreadable);
  }
  return files;
}

/**
 * One listed path's text, for a census that lists first and reads as it goes. A path that vanished
 * since it was listed reads as the empty string — it is no longer part of the tree, and a census
 * that counts matches in it counts none — and one that exists and cannot be read throws, naming it.
 */
export function censusText(root, path) {
  const { files, unreadable } = readCensus(root, [path]);
  if (unreadable.length > 0) {
    throw new CensusUnreadableError(unreadable);
  }
  return files[0]?.contents ?? '';
}
