/**
 * The launcher's listing of which protected paths exist at the merge base with the default branch (WP-99): the script's shape,
 * the parser's fail-closed readings, the decoder against git's quoting, and — against a real `git`
 * on this machine — that the script's output is what the parser reads.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { MAX_EXISTING_PROTECTED_PATHS, MAX_TRACKED_ENTRIES } from '@platform/application';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { initScratchRepository } from '../../../../scripts/git-scratch-env.mjs';
import { guardWritePath } from '../runner/path-guard.js';
import {
  decodeGitPath,
  listingRefusal,
  parseTrackedListing,
  quoteGitPath,
  TRACKED_LISTING_TRAILER,
  trackedListingLine,
  trackedListingOutput,
  trackedListingScript,
} from './tracked.js';

const run = promisify(execFile);

const PATTERNS = ['**/*.test.*', '.gitlab-ci.yml'];

describe('parseTrackedListing', () => {
  it('keeps the regular files a pattern matches, and every symlink and submodule', () => {
    const listing = parseTrackedListing(
      trackedListingOutput([
        { path: 'README.md', mode: '100644' },
        { path: 'src/totals.test.ts', mode: '100644' },
        { path: 'scripts/run.test.sh', mode: '100755' },
        { path: '.gitlab-ci.yml', mode: '100644' },
        { path: 'lib', mode: '120000' },
        { path: 'vendor/sub', mode: '160000' },
      ]),
      PATTERNS,
    );
    expect(listing).toEqual({
      state: 'listed',
      paths: ['src/totals.test.ts', 'scripts/run.test.sh', '.gitlab-ci.yml'],
      opaque: ['lib', 'vendor/sub'],
    });
  });

  it('matches through the guard’s fold, so a pattern in another case still finds the file', () => {
    const listing = parseTrackedListing(
      trackedListingOutput([{ path: 'SRC/Totals.TEST.ts', mode: '100644' }]),
      PATTERNS,
    );
    expect(listing).toMatchObject({ state: 'listed', paths: ['SRC/Totals.TEST.ts'] });
  });

  it.each([
    ['no trailer at all', 'README.md\n', 'without its trailer'],
    ['a trailer that is not the platform’s', '@@other end 0\n', 'without its trailer'],
    [
      'a count the entries do not reach — a log cut short',
      `${trackedListingLine({ path: 'a.test.ts', mode: '100644' })}\n${TRACKED_LISTING_TRAILER} head\n${TRACKED_LISTING_TRAILER} end 2 0\n`,
      'has 1 entries where git counted 2',
    ],
    [
      'a repository past the bound',
      `${TRACKED_LISTING_TRAILER} too-many ${String(MAX_TRACKED_ENTRIES + 1)}\n`,
      'past the listing',
    ],
    [
      'an unreadable trailer',
      `${TRACKED_LISTING_TRAILER} head\n${TRACKED_LISTING_TRAILER} end two 0\n`,
      'unreadable trailer',
    ],
    [
      'a stderr line mixed into the entries',
      `warning: something\n${TRACKED_LISTING_TRAILER} head\n${TRACKED_LISTING_TRAILER} end 1 0\n`,
      'cannot read',
    ],
    [
      'a path that is not UTF-8',
      `100644 blob ${'0'.repeat(40)}\t"\\377.test.ts"\n${TRACKED_LISTING_TRAILER} head\n${TRACKED_LISTING_TRAILER} end 1 0\n`,
      'not UTF-8',
    ],
    [
      'a tree entry, which `ls-tree -r` never prints',
      `040000 tree ${'0'.repeat(40)}\tsrc\n${TRACKED_LISTING_TRAILER} head\n${TRACKED_LISTING_TRAILER} end 1 0\n`,
      'not a file, a symlink or a submodule',
    ],
    [
      'no section for the checkout’s links',
      `${TRACKED_LISTING_TRAILER} end 0 0\n`,
      'no section for the checkout',
    ],
    [
      'a regular file in the checkout-links section',
      `${TRACKED_LISTING_TRAILER} head\n100644 blob ${'0'.repeat(40)}\ta.ts\n${TRACKED_LISTING_TRAILER} end 0 1\n`,
      'checkout link line',
    ],
    [
      'more checkout links than the bound',
      `${TRACKED_LISTING_TRAILER} too-many-links 1001\n`,
      'symlinks and submodules, past the bound',
    ],
    [
      'no merge base (no such ref, unrelated or cut history)',
      `${TRACKED_LISTING_TRAILER} no-base\n`,
      'merge base of the checkout and the default branch could not be computed',
    ],
  ])('answers unlisted for %s', (_name, output, reason) => {
    const listing = parseTrackedListing(output, PATTERNS);
    expect(listing.state).toBe('unlisted');
    expect(listing.state === 'unlisted' ? listing.reason : '').toContain(reason);
  });

  it('answers unlisted past the bound on protected files, never a shorter list', () => {
    const entries = Array.from({ length: MAX_EXISTING_PROTECTED_PATHS + 1 }, (_, index) => ({
      path: `t/${String(index)}.test.ts`,
      mode: '100644',
    }));
    const listing = parseTrackedListing(trackedListingOutput(entries), PATTERNS);
    expect(listing).toMatchObject({ state: 'unlisted', reason: /past the bound/ });
  });
});

describe('decodeGitPath and quoteGitPath', () => {
  it.each([
    ['plain', 'src/a.test.ts', 'src/a.test.ts'],
    ['a UTF-8 name git octal-escapes', '"stra\\303\\237e.test.ts"', 'straße.test.ts'],
    ['a tab and a quote', '"a\\tb\\".test.ts"', 'a\tb".test.ts'],
  ])('decodes %s', (_name, raw, decoded) => {
    expect(decodeGitPath(raw)).toBe(decoded);
  });

  it.each([
    ['an unterminated quote', '"abc'],
    ['an unknown escape', '"a\\qb"'],
    ['a short octal', '"a\\30"'],
    ['an escaped NUL', '"a\\000b"'],
    ['a bare quote inside', '"a"b"'],
  ])('refuses %s', (_name, raw) => {
    expect(decodeGitPath(raw)).toBeNull();
  });

  it('round-trips every path git could list', () => {
    fc.assert(
      fc.property(
        fc
          .string({ unit: 'grapheme', minLength: 1, maxLength: 24 })
          .filter((value) => !value.includes('\0')),
        (value) => decodeGitPath(quoteGitPath(value)) === value,
      ),
    );
  });
});

describe('listingRefusal', () => {
  it.each([
    ['no checkout', null, { patterns: ['a'], defaultBranch: 'main' }, /no checkout/],
    ['no patterns', 'k', { patterns: [], defaultBranch: 'main' }, /no protected paths/],
    ['no default branch', 'k', { patterns: ['a'], defaultBranch: null }, /no default branch/],
    ['a branch that starts with a dash', 'k', { patterns: ['a'], defaultBranch: '-x' }, /not one/],
    ['a branch with ..', 'k', { patterns: ['a'], defaultBranch: 'a..b' }, /not one/],
    ['a branch with a space', 'k', { patterns: ['a'], defaultBranch: 'a b' }, /not one/],
  ])('refuses %s', (_name, cacheKey, request, reason) => {
    expect(listingRefusal(cacheKey, request)).toMatchObject({ state: 'unlisted', reason });
  });

  it('lets an ordinary default branch through', () => {
    expect(listingRefusal('k', { patterns: ['a'], defaultBranch: 'release/2026.09' })).toBeNull();
  });
});

describe('trackedListingScript', () => {
  it('refuses a directory that is not a plain absolute path, since it reaches a shell', () => {
    expect(() => trackedListingScript("/work/repo'; rm -rf /")).toThrow(/plain absolute path/);
    expect(() => trackedListingScript('work/repo')).toThrow(/plain absolute path/);
  });

  /**
   * Against the `git` on this machine, and the review's round-1 case: the checkout is a **task
   * branch** one commit ahead of `main`, which added `src/added.test.ts`. The listing is the tree at
   * the merge base, so the file the task added is new (as the merge request's diff says), a file on
   * `main` is existing, a symlink at the base is opaque, and an untracked file is not there at all.
   */
  it('lists the tree at the merge base with the default branch, plus the task branch’s own links', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'agentic-wp99-tracked-'));
    try {
      const env = initScratchRepository(directory, { initArgs: ['-b', 'main'] });
      const git = (...args: string[]) =>
        run(
          'git',
          [
            '-C',
            directory,
            '-c',
            'user.name=Fixture',
            '-c',
            'user.email=fixture@example.test',
            ...args,
          ],
          { env },
        );
      await mkdir(join(directory, 'src'));
      await writeFile(join(directory, 'src', 'totals.test.ts'), 'x\n');
      await writeFile(join(directory, 'src', 'straße.test.ts'), 'x\n');
      await writeFile(join(directory, 'README.md'), 'x\n');
      await symlink('src', join(directory, 'lib'));
      await git('add', '-A');
      await git('commit', '-q', '-m', 'base');
      await git('checkout', '-q', '-b', 'agentic/task');
      await writeFile(join(directory, 'src', 'added.test.ts'), 'x\n');
      // Review round 2: the task also committed a symlink into the protected tree. It is not at the
      // base, so only the checkout's own links make a write through it count as existing.
      await symlink('src', join(directory, 'linked'));
      await git('add', '-A');
      await git('commit', '-q', '-m', 'the task added a test');
      await writeFile(join(directory, 'src', 'untracked.test.ts'), 'x\n');
      const list = async (baseRef: string) =>
        parseTrackedListing(
          (
            await run('/bin/sh', ['-c', trackedListingScript(directory)], {
              env: { ...env, BASE_REF: baseRef },
            })
          ).stdout,
          PATTERNS,
        );
      const listing = await list('main');
      expect(listing).toEqual({
        state: 'listed',
        paths: ['src/straße.test.ts', 'src/totals.test.ts'],
        opaque: ['lib', 'linked'],
      });
      // Through the guard: `linked/totals.test.ts` is `src/totals.test.ts` on disk, so it is denied,
      // while the file the task added directly is new and allowed.
      const guard = {
        workspacePath: directory,
        protectedPaths: PATTERNS,
        plannedProtectedPaths: [],
        existingProtectedPaths: listing,
      };
      expect(guardWritePath('linked/totals.test.ts', guard).decision).toBe('deny');
      expect(guardWritePath('src/added.test.ts', guard).decision).toBe('allow');
      // A base ref the clone does not have: no merge base, so nothing is known to be new.
      expect(await list('refs/remotes/origin/nope')).toMatchObject({
        state: 'unlisted',
        reason: /merge base/,
      });
      // Unrelated history: an orphan branch shares no commit with the task branch.
      await git('checkout', '-q', '--orphan', 'unrelated');
      await git('commit', '-q', '--allow-empty', '-m', 'orphan');
      await git('checkout', '-q', 'agentic/task');
      expect(await list('unrelated')).toMatchObject({ state: 'unlisted', reason: /merge base/ });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
