/**
 * The release versions this repository has, and how one version compares with another (WP-71,
 * TD-019's amendment, Q96).
 *
 * Two readers: `changelog.mjs` (which release the notes are *since*, and whether the version it is
 * asked to render is ahead of it) and `version.mjs` (which version the next push to `main` cuts).
 * They share this module so that "the newest release" is one answer rather than two — the first
 * version of `changelog.mjs` asked `git describe --match 'v*'`, which returns the *nearest* tag by
 * topology and accepts any tag that starts with a `v`, while a version computation needs the
 * *highest* strict `vX.Y.Z` that `HEAD` contains.
 *
 * Plain JavaScript with no dependency, for the reason every script here is: the workflow runs it
 * with `node` on a runner that installed nothing.
 */
import { execFileSync } from 'node:child_process';

/**
 * The version the **first** release is cut at, when no `vX.Y.Z` tag exists yet.
 *
 * It was `initial-version` in `release-please-config.json` until WP-71 retired release-please with
 * its configuration; the value is unchanged. It is the "configured version" of plan criterion 7: the
 * version `pnpm changelog` renders when it is not given one, and which it refuses to render once a
 * release at or beyond it exists.
 */
export const FIRST_VERSION = '0.1.0';

/** `vMAJOR.MINOR.PATCH` and nothing else: no pre-release, no build metadata, no leading zero. */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** `"1.2.3"` → `{ major: 1, minor: 2, patch: 3 }`; `null` for anything that is not exactly that. */
export const parseVersion = (text) => {
  const match = VERSION.exec(text);
  if (match === null) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
};

/** A release tag's version, or `null` when the tag is not a strict `vX.Y.Z`. */
export const tagVersion = (tag) => (RELEASE_TAG.test(tag) ? tag.slice(1) : null);

/** Negative, zero or positive, as `a` is below, equal to or above `b`. Both must parse. */
export const compareVersions = (a, b) => {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (left === null || right === null) {
    throw new Error(`not a MAJOR.MINOR.PATCH version: ${left === null ? a : b}`);
  }
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
};

/**
 * The highest strict `vX.Y.Z` among `tags`, or `null` when there is none.
 *
 * *Highest*, not newest: a patch cut on an older line after a newer release (a `v0.1.1` tagged
 * after `v0.2.0`) must not become "the previous release" of the next version, or the next version
 * would be computed backwards. Tags that are not strict release tags (`v1`, `v0.1.0-rc.1`,
 * `version-2`) are ignored rather than parsed loosely.
 */
export const latestReleaseTag = (tags) => {
  let best = null;
  for (const tag of tags) {
    const version = tagVersion(tag);
    if (version === null) continue;
    if (best === null || compareVersions(version, best.slice(1)) > 0) best = tag;
  }
  return best;
};

/**
 * The `v*` tags `HEAD` contains — `git tag --merged HEAD`, so a tag on a branch that was never
 * merged is not a previous release of this history. Needs the tags in the clone: a workflow that
 * reads this checks out with `fetch-depth: 0`, which fetches them.
 */
export const releaseTags = (root) =>
  execFileSync('git', ['tag', '--merged', 'HEAD', '--list', 'v*'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
