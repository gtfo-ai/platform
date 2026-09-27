#!/usr/bin/env node
/**
 * The version a push to `main` releases, computed from the conventional commits since the last
 * release tag (WP-71; TD-019's amendment of 2026-09-16, the product owner's answer to Q96).
 *
 *   node scripts/version.mjs                  print the next version, or nothing when there is none
 *   node scripts/version.mjs --github-output  append `version=` and `previous_tag=` to $GITHUB_OUTPUT
 *
 * Why this is here: every push to `main` is the release (continuous deployment), so a version is not
 * a thing a human proposes in a pull request any more — it is a function of the history, and the
 * history is already held to the conventional-commit format by commitlint on every pushed range.
 * `image.yml`'s `version` job runs this; the `release` job retags the manifests the same run built
 * and cuts the tag and the GitHub Release. **Nothing here creates a tag**: this prints a string.
 *
 * ## The rules, and where each comes from
 *
 * - **Which commits cut a version**: the types the changelog shows (`feat`, `fix`, `perf`,
 *   `revert` — `CHANGELOG_SECTIONS` in `changelog.mjs`, release-please 17.6.0's default table) and
 *   any breaking change whatever its type. `docs`, `chore`, `test`, `ci`, `refactor`, `build` and
 *   `style` cut nothing, which is Q96's "`docs`/`chore` cut nothing" applied to the whole hidden set:
 *   a version whose notes would list no entry is a version that says nothing.
 * - **How far**: a breaking change is major, `feat` is minor, anything else releasable is patch
 *   (Q96: "`feat` → minor, `fix` → patch, `!` → major").
 * - **Before 1.0.0 a breaking change is minor**, not major. This is the retired release-please
 *   configuration's `bump-minor-pre-major: true`, kept deliberately: otherwise the first `!` commit
 *   after `0.1.0` would declare `1.0.0`, and 1.0 is a statement about the product that nobody should
 *   make by writing an exclamation mark. `feat` stays minor before 1.0 (the same configuration's
 *   `bump-patch-for-minor-pre-major: false`).
 * - **The first version is `FIRST_VERSION`** (`0.1.0`) whatever the commits say, provided at least
 *   one of them is releasable.
 *
 * ## What it refuses
 *
 * A **shallow clone** is refused rather than answered: with no tags and one commit, it would compute
 * `0.1.0` on every push after the first release (standing rule 20 — refusing beats a wrong number
 * that looks right). The workflow checks out with `fetch-depth: 0`.
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { CHANGELOG_SECTIONS, readCommits } from './changelog.mjs';
import {
  compareVersions,
  FIRST_VERSION,
  latestReleaseTag,
  parseVersion,
  releaseTags,
  tagVersion,
} from './semver.mjs';

const repositoryRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

const RELEASING_TYPES = new Set(
  CHANGELOG_SECTIONS.filter((section) => !section.hidden).map((section) => section.type),
);

/** `'major' | 'minor' | 'patch'`, or `null` when no commit in the list cuts a version. */
export const releaseBump = (commits) => {
  let bump = null;
  for (const commit of commits) {
    if (commit.breaking) return 'major';
    if (commit.type === 'feat') bump = 'minor';
    else if (bump === null && RELEASING_TYPES.has(commit.type)) bump = 'patch';
  }
  return bump;
};

/** `version` moved by `bump`, with a breaking change before 1.0.0 counted as minor. */
export const bumpVersion = (version, bump) => {
  const parsed = parseVersion(version);
  if (parsed === null) throw new Error(`not a MAJOR.MINOR.PATCH version: ${version}`);
  const { major, minor, patch } = parsed;
  const effective = bump === 'major' && major === 0 ? 'minor' : bump;
  if (effective === 'major') return `${major + 1}.0.0`;
  if (effective === 'minor') return `${major}.${minor + 1}.0`;
  if (effective === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`not a bump: ${String(bump)}`);
};

/**
 * The next version, and why — a pure function of the previous release tag and the parsed commits
 * since it.
 *
 * `version` is `null` when nothing in the range cuts one; `reason` says which of the rules above
 * decided, and is what the workflow prints.
 */
export const nextVersion = ({ previousTag, commits, firstVersion = FIRST_VERSION }) => {
  const bump = releaseBump(commits);
  if (bump === null) {
    return {
      version: null,
      bump,
      reason:
        previousTag === null
          ? 'no commit in the history cuts a version (only hidden types)'
          : `no commit since ${previousTag} cuts a version (only hidden types, or none at all)`,
    };
  }
  if (previousTag === null) {
    return { version: firstVersion, bump, reason: 'the first release: no vX.Y.Z tag exists yet' };
  }
  const previous = tagVersion(previousTag);
  if (previous === null) throw new Error(`not a release tag: ${previousTag}`);
  const version = bumpVersion(previous, bump);
  // Belt and braces: the arithmetic above cannot go backwards, and this states that it did not.
  if (compareVersions(version, previous) <= 0) {
    throw new Error(`computed ${version}, which is not ahead of ${previousTag}`);
  }
  return { version, bump, reason: `${bump} since ${previousTag}` };
};

const isShallow = (root) =>
  execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd: root,
    encoding: 'utf8',
  }).trim() === 'true';

/** The next version of the repository at `root`, read from its tags and its history. */
export const nextVersionOf = (root = repositoryRoot) => {
  if (isShallow(root)) {
    throw new Error(
      'refusing to compute a version in a shallow clone: its tags and history are incomplete, so ' +
        `every push would look like the first release (${FIRST_VERSION}). Check out with fetch-depth: 0.`,
    );
  }
  const previousTag = latestReleaseTag(releaseTags(root));
  const { commits } = readCommits(previousTag === null ? null : `${previousTag}..HEAD`, root);
  return { previousTag, ...nextVersion({ previousTag, commits }) };
};

const isProgram =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolvePath(process.argv[1]);

if (isProgram) {
  try {
    const { previousTag, version, reason } = nextVersionOf();
    process.stderr.write(
      `${version === null ? 'no version' : `next version: ${version}`} — ${reason}\n`,
    );
    if (process.argv.includes('--github-output')) {
      const output = process.env.GITHUB_OUTPUT;
      if (!output) throw new Error('--github-output needs GITHUB_OUTPUT, which Actions sets');
      appendFileSync(output, `version=${version ?? ''}\nprevious_tag=${previousTag ?? ''}\n`);
    } else if (version !== null) {
      process.stdout.write(`${version}\n`);
    }
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
