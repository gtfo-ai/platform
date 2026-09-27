import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { ParsedCommit } from './changelog.mjs';
import {
  compareVersions,
  FIRST_VERSION,
  latestReleaseTag,
  parseVersion,
  releaseTags,
  tagVersion,
} from './semver.mjs';
import { bumpVersion, nextVersion, nextVersionOf, releaseBump } from './version.mjs';

/**
 * The version a push to `main` cuts (WP-71, TD-019's amendment, Q96), computed **locally and
 * purely**: over parsed commit lists, and over throwaway repositories whose tags exist only in a
 * temporary directory. Nothing here creates a tag in this repository or talks to GitHub.
 *
 * Every rule is asserted from both sides (standing rule 42): a computation that always bumped minor
 * would pass the `feat` case, and one that never released would pass the `docs` case.
 */
const commit = (overrides: Partial<ParsedCommit> = {}): ParsedCommit => ({
  sha: '0'.repeat(40),
  type: 'feat',
  scope: null,
  subject: 'a thing',
  breaking: false,
  ...overrides,
});

describe('semver.mjs', () => {
  it('parses exactly MAJOR.MINOR.PATCH and nothing looser', () => {
    expect(parseVersion('1.2.3')).toEqual({ major: 1, minor: 2, patch: 3 });
    for (const text of ['1.2', 'v1.2.3', '1.2.3-rc.1', '01.2.3', '1.2.3+build', ''])
      expect(parseVersion(text)).toBeNull();
    expect(tagVersion('v0.1.0')).toBe('0.1.0');
    expect(tagVersion('0.1.0')).toBeNull();
    expect(tagVersion('v0.1.0-rc.1')).toBeNull();
  });

  it('compares numerically, not as strings', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
    expect(compareVersions('0.1.1', '0.2.0')).toBeLessThan(0);
    expect(() => compareVersions('1.0', '1.0.0')).toThrow(/not a MAJOR\.MINOR\.PATCH/);
  });

  /**
   * *Highest*, not newest and not nearest: a patch cut on an older line after a newer release must
   * not become the base of the next version — Q89's "can move backwards" hazard, one level down.
   */
  it('takes the highest strict release tag, ignoring anything that is not one', () => {
    expect(latestReleaseTag([])).toBeNull();
    expect(latestReleaseTag(['v0.2.0', 'v0.1.1', 'v0.10.0', 'v0.9.0'])).toBe('v0.10.0');
    expect(latestReleaseTag(['v0.1.0', 'v1.0.0-rc.1', 'v2', 'version-3'])).toBe('v0.1.0');
    expect(latestReleaseTag(['v1', 'nightly'])).toBeNull();
  });

  it('starts at 0.1.0, the value release-please’s `initial-version` carried', () => {
    expect(FIRST_VERSION).toBe('0.1.0');
  });
});

describe('releaseBump', () => {
  it('is major for a breaking change of any type, hidden ones included', () => {
    expect(
      releaseBump([commit({ type: 'fix' }), commit({ type: 'refactor', breaking: true })]),
    ).toBe('major');
  });

  it('is minor for a feature and patch for the other visible types', () => {
    expect(releaseBump([commit({ type: 'fix' }), commit({ type: 'feat' })])).toBe('minor');
    for (const type of ['fix', 'perf', 'revert'])
      expect(releaseBump([commit({ type })])).toBe('patch');
  });

  it('cuts nothing for the hidden types — Q96’s “docs/chore cut nothing”', () => {
    const hidden = ['docs', 'chore', 'test', 'ci', 'refactor', 'build', 'style'];
    expect(releaseBump(hidden.map((type) => commit({ type })))).toBeNull();
    expect(releaseBump([])).toBeNull();
  });
});

describe('bumpVersion', () => {
  it('moves the named component and zeroes the ones below it', () => {
    expect(bumpVersion('1.2.3', 'major')).toBe('2.0.0');
    expect(bumpVersion('1.2.3', 'minor')).toBe('1.3.0');
    expect(bumpVersion('1.2.3', 'patch')).toBe('1.2.4');
  });

  /**
   * The retired release-please configuration's `bump-minor-pre-major: true`, kept: before 1.0.0 a
   * breaking change is minor, so no `!` declares 1.0 by accident. Both sides: at 0.x it is minor,
   * at 1.x it is major.
   */
  it('counts a breaking change as minor before 1.0.0 and as major from it', () => {
    expect(bumpVersion('0.4.2', 'major')).toBe('0.5.0');
    expect(bumpVersion('0.4.2', 'minor')).toBe('0.5.0');
    expect(bumpVersion('0.4.2', 'patch')).toBe('0.4.3');
    expect(bumpVersion('1.4.2', 'major')).toBe('2.0.0');
  });

  it('refuses what it cannot move', () => {
    expect(() => bumpVersion('1.2', 'patch')).toThrow(/not a MAJOR/);
    // @ts-expect-error — a bump that is not one of the three, as a caller in JavaScript could pass
    expect(() => bumpVersion('1.2.3', 'huge')).toThrow(/not a bump/);
  });
});

describe('nextVersion', () => {
  it('cuts the first version at FIRST_VERSION whatever the size of the change', () => {
    for (const type of ['fix', 'feat']) {
      expect(nextVersion({ previousTag: null, commits: [commit({ type })] }).version).toBe('0.1.0');
    }
    expect(nextVersion({ previousTag: null, commits: [commit({ breaking: true })] }).version).toBe(
      '0.1.0',
    );
  });

  it('cuts nothing — first or not — when no commit is releasable', () => {
    const docsOnly = [commit({ type: 'docs' }), commit({ type: 'chore' })];
    expect(nextVersion({ previousTag: null, commits: docsOnly }).version).toBeNull();
    const after = nextVersion({ previousTag: 'v0.3.0', commits: docsOnly });
    expect(after.version).toBeNull();
    expect(after.reason).toContain('v0.3.0');
    expect(nextVersion({ previousTag: 'v0.3.0', commits: [] }).version).toBeNull();
  });

  it('moves from the previous tag by the largest bump in the range', () => {
    expect(nextVersion({ previousTag: 'v0.3.0', commits: [commit({ type: 'fix' })] }).version).toBe(
      '0.3.1',
    );
    expect(
      nextVersion({
        previousTag: 'v0.3.1',
        commits: [commit({ type: 'fix' }), commit({ type: 'feat' })],
      }).version,
    ).toBe('0.4.0');
    expect(
      nextVersion({ previousTag: 'v1.3.1', commits: [commit({ type: 'fix', breaking: true })] })
        .version,
    ).toBe('2.0.0');
  });

  it('refuses a previous tag that is not a release tag rather than guessing', () => {
    expect(() => nextVersion({ previousTag: 'v1.0', commits: [commit()] })).toThrow(
      /not a release tag/,
    );
  });
});

/** A throwaway repository: `steps` are commit messages, or `tag:<name>` to tag the last commit. */
const scratches: string[] = [];
afterAll(() => {
  for (const dir of scratches) rmSync(dir, { recursive: true, force: true });
});

const git = (cwd: string, ...args: string[]): string =>
  execFileSync(
    'git',
    [
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.test',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'tag.gpgsign=false',
      // A scratch repository must not run this machine's hooks, whatever `core.hooksPath` says.
      '-c',
      'core.hooksPath=/dev/null',
      ...args,
    ],
    { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  );

const repositoryWith = (steps: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), 'version-'));
  scratches.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  for (const step of steps) {
    if (step.startsWith('tag:')) git(dir, 'tag', step.slice(4));
    else git(dir, 'commit', '--allow-empty', '--no-verify', '-q', '-m', step);
  }
  return dir;
};

describe('nextVersionOf (a repository’s tags and history)', () => {
  it('cuts 0.1.0 on a history with no release tag', () => {
    const root = repositoryWith(['feat: one', 'docs: two']);
    expect(nextVersionOf(root)).toMatchObject({ previousTag: null, version: '0.1.0' });
  });

  it('reads only the commits since the highest release tag HEAD contains', () => {
    // A `feat` before the tag must not count again: only `fix` is after it, so this is a patch.
    const root = repositoryWith(['feat: one', 'tag:v0.1.0', 'fix: two', 'tag:v0.1.0-rc.9']);
    expect(nextVersionOf(root)).toMatchObject({ previousTag: 'v0.1.0', version: '0.1.1' });
  });

  it('cuts nothing on a push that carries only hidden types after a release', () => {
    const root = repositoryWith(['feat: one', 'tag:v0.1.0', 'docs: a page', 'chore: tidy']);
    expect(nextVersionOf(root)).toMatchObject({ previousTag: 'v0.1.0', version: null });
  });

  it('cuts nothing on a push that is itself the release commit', () => {
    const root = repositoryWith(['feat: one', 'tag:v0.1.0']);
    expect(nextVersionOf(root).version).toBeNull();
  });

  it('ignores a release tag on a branch HEAD does not contain', () => {
    const root = repositoryWith(['feat: one']);
    git(root, 'checkout', '-q', '-b', 'side');
    git(root, 'commit', '--allow-empty', '--no-verify', '-q', '-m', 'feat: elsewhere');
    git(root, 'tag', 'v0.5.0');
    git(root, 'checkout', '-q', 'main');
    expect(releaseTags(root)).toEqual([]);
    expect(nextVersionOf(root)).toMatchObject({ previousTag: null, version: '0.1.0' });
  });

  /**
   * The refusal that stops a shallow checkout from cutting 0.1.0 again after the first release: a
   * depth-1 clone has neither the tag nor the history, and would otherwise answer as if it were
   * the first release (standing rule 20).
   */
  it('refuses a shallow clone instead of answering as if it were the first release', () => {
    const origin = repositoryWith(['feat: one', 'tag:v0.1.0', 'fix: two']);
    const clone = mkdtempSync(join(tmpdir(), 'version-shallow-'));
    scratches.push(clone);
    git(tmpdir(), 'clone', '-q', '--depth', '1', `file://${origin}`, clone);
    expect(() => nextVersionOf(clone)).toThrow(/refusing to compute a version in a shallow clone/);
    // …and the full history answers.
    expect(nextVersionOf(origin).version).toBe('0.1.1');
  });
});
