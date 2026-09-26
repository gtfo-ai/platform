import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { matchesRepoGlob, matchingRepoPaths, normaliseRepoPath, pathWitnesses } from './globs.js';

describe('matchesRepoGlob', () => {
  it.each([
    ['src/api/**', 'src/api/session.ts', true],
    ['src/api/**', 'src/api/deep/nested/file.ts', true],
    ['src/api/**', 'src/api', true],
    ['src/api/', 'src/api/session.ts', true],
    ['src/api', 'src/api/session.ts', true],
    ['src/api/**', 'src/apiary/session.ts', false],
    ['src/*.ts', 'src/index.ts', true],
    ['src/*.ts', 'src/api/index.ts', false],
    ['**/*.test.ts', 'packages/domain/src/x.test.ts', true],
    ['**/*.test.ts', 'x.test.ts', true],
    ['src/?.ts', 'src/a.ts', true],
    ['src/?.ts', 'src/ab.ts', false],
    ['CLAUDE.md', 'CLAUDE.md', true],
    // Backlog 176: a bare `**` and the spellings that normalise to it cover every path.
    ['**', 'src/a.ts', true],
    ['**', 'CLAUDE.md', true],
    ['/**', 'packages/domain/src/x.ts', true],
    ['**/', 'docs/a/b.md', true],
    ['CLAUDE.md', 'docs/CLAUDE.md', false],
  ])('%s matches %s → %s', (pattern, candidate, expected) => {
    expect(matchesRepoGlob(pattern, candidate)).toBe(expected);
  });

  it('treats a regex metacharacter in a pattern as a literal', () => {
    expect(matchesRepoGlob('src/a.ts', 'src/aXts')).toBe(false);
    expect(matchesRepoGlob('src/a.ts', 'src/a.ts')).toBe(true);
    expect(matchesRepoGlob('src/a+b.ts', 'src/a+b.ts')).toBe(true);
  });

  it('does not let `**` inside a pattern swallow a path separator it should not', () => {
    // The `**` placeholder is staged through a NUL sentinel; if that staging leaked, `src/**/x.ts`
    // would compile to a regex that also matched `src/x.ts` *and* `srcAx.ts`. The second is the
    // one that would be wrong.
    expect(matchesRepoGlob('src/**/x.ts', 'src/a/b/x.ts')).toBe(true);
    expect(matchesRepoGlob('src/**/x.ts', 'src/x.ts')).toBe(true);
    expect(matchesRepoGlob('src/**/x.ts', 'srcAx.ts')).toBe(false);
    // The case that discriminates: `**` stands for whole path *segments*, so it may not match a
    // partial one. A staging that expanded to a bare `.*` would pass everything above and admit
    // these — which is how a `paths:` glob would start matching files it never named (rule 43).
    expect(matchesRepoGlob('**/x.ts', 'prefix-x.ts')).toBe(false);
    expect(matchesRepoGlob('**/x.ts', 'a/b/x.ts')).toBe(true);
    expect(matchesRepoGlob('src/**/session.ts', 'src/api/old-session.ts')).toBe(false);
  });
});

describe('normaliseRepoPath', () => {
  it.each([
    ['./src/a.ts', 'src/a.ts'],
    ['/src/a.ts', 'src/a.ts'],
    ['src\\a.ts', 'src/a.ts'],
    ['src/a.ts', 'src/a.ts'],
  ])('%s → %s', (input, expected) => {
    expect(normaliseRepoPath(input)).toBe(expected);
  });
});

describe('matchingRepoPaths', () => {
  it('returns which candidates matched, not merely that one did', () => {
    expect(
      matchingRepoPaths(
        ['src/api/**', 'CLAUDE.md'],
        ['src/api/session.ts', 'src/billing/tax.ts', 'CLAUDE.md'],
      ),
    ).toEqual(['src/api/session.ts', 'CLAUDE.md']);
  });

  it('is empty for an empty pattern list and for an empty candidate list', () => {
    expect(matchingRepoPaths([], ['src/a.ts'])).toEqual([]);
    expect(matchingRepoPaths(['src/**'], [])).toEqual([]);
  });
});

describe('pathWitnesses (WP-58, backlog 175)', () => {
  it('finds a witness for a bare `**`, so a page scoped to everything is never flagged unresolved (backlog 176)', () => {
    expect(pathWitnesses(['**'], ['src/a.ts', 'docs/b.md'])).toHaveLength(1);
    expect(pathWitnesses(['**'], [])).toEqual([]);
  });

  const listing = ['src/api/session.ts', 'src/api/router.ts', 'src/billing/tax.ts', 'package.json'];

  it('keeps one tracked path per glob that matches, and none for a glob that does not', () => {
    expect(pathWitnesses(['src/api/**', 'src/legacy/**', 'package.json'], listing)).toEqual([
      'package.json',
      'src/api/session.ts',
    ]);
    expect(pathWitnesses([], listing)).toEqual([]);
  });

  it('answers validate-on-read exactly as the whole listing does, for any page of the vault', () => {
    const segment = fc.constantFrom('src', 'api', 'billing', 'ui', 'legacy', 'a.ts', 'b.ts');
    const path = fc.array(segment, { minLength: 1, maxLength: 4 }).map((parts) => parts.join('/'));
    const glob = fc
      .tuple(path, fc.constantFrom('', '/**', '/*.ts', '/*'))
      .map(([base, tail]) => `${base}${tail}`);
    fc.assert(
      fc.property(
        fc.array(path, { maxLength: 20 }),
        fc.array(glob, { minLength: 1, maxLength: 8 }),
        fc.array(fc.nat(), { minLength: 1, maxLength: 4 }),
        (repoPaths, vaultGlobs, picks) => {
          const page = picks.map((pick) => vaultGlobs[pick % vaultGlobs.length] as string);
          const witnesses = pathWitnesses(vaultGlobs, repoPaths);
          expect(matchingRepoPaths(page, witnesses).length > 0).toBe(
            matchingRepoPaths(page, repoPaths).length > 0,
          );
        },
      ),
      { numRuns: 500 },
    );
  });
});
