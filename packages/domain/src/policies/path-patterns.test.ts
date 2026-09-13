/**
 * The repository-path glob, moved into the domain ring at WP-24.
 *
 * Every case here was already covered through `path-guard.ts` — this file exists because the syntax
 * now has a **second** consumer (review-only's path trigger), and a shared function whose only tests
 * run through one caller is a function the other caller has no evidence about. The fold that
 * `path-guard.ts` applies is deliberately absent here: these are byte comparisons, which is what the
 * review-only filter does.
 */
import { describe, expect, it } from 'vitest';
import { pathMatchesPattern } from './path-patterns.js';

describe('a repository path pattern', () => {
  it('crosses separators with `**` and not with `*`', () => {
    expect(pathMatchesPattern('src/**/*.ts', 'src/a/b/c.ts')).toBe(true);
    expect(pathMatchesPattern('src/*.ts', 'src/a.ts')).toBe(true);
    expect(pathMatchesPattern('src/*.ts', 'src/a/b.ts')).toBe(false);
  });

  it('reads `infra`, `infra/` and `infra/**` as the same instruction', () => {
    for (const pattern of ['infra', 'infra/', 'infra/**']) {
      expect(pathMatchesPattern(pattern, 'infra'), pattern).toBe(true);
      expect(pathMatchesPattern(pattern, 'infra/main.tf'), pattern).toBe(true);
      expect(pathMatchesPattern(pattern, 'infrastructure/main.tf'), pattern).toBe(false);
    }
  });

  it('matches one character with `?` and never a separator', () => {
    expect(pathMatchesPattern('src/a?.ts', 'src/ab.ts')).toBe(true);
    expect(pathMatchesPattern('src/a?.ts', 'src/a/.ts')).toBe(false);
  });

  it('treats regex metacharacters in a pattern as literals', () => {
    expect(pathMatchesPattern('src/a.ts', 'src/a.ts')).toBe(true);
    // `.` is not "any character": a pattern naming `a.ts` must not match `axts`.
    expect(pathMatchesPattern('src/a.ts', 'src/axts')).toBe(false);
    expect(pathMatchesPattern('src/(a).ts', 'src/(a).ts')).toBe(true);
  });

  it('does not let a space in a directory name behave like a wildcard', () => {
    // The private-use placeholder exists for exactly this: a space as the `**` stand-in would turn
    // `my dir/*` into `my.*dir/[^/]*`.
    expect(pathMatchesPattern('my dir/*', 'my dir/a.ts')).toBe(true);
    expect(pathMatchesPattern('my dir/*', 'myXXXdir/a.ts')).toBe(false);
  });

  it('compares bytes: it folds no case and normalises no Unicode', () => {
    // The statement `path-guard.ts` depends on being **false** here, which is why it folds first.
    expect(pathMatchesPattern('src/App.ts', 'src/app.ts')).toBe(false);
  });
});
