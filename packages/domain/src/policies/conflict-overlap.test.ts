import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  type ChangedPaths,
  MAX_OVERLAP_PATH_CHARS,
  MAX_OVERLAP_PATHS,
  pathOverlap,
} from './conflict-overlap.js';

const side = (paths: readonly string[], overrides: Partial<ChangedPaths> = {}): ChangedPaths => ({
  newPaths: paths,
  oldPaths: paths,
  truncated: false,
  ...overrides,
});

describe('pathOverlap', () => {
  it('reports the files both merge requests touch, and nothing else', () => {
    const overlap = pathOverlap(
      side(['src/totals.ts', 'src/footer.ts']),
      side(['src/totals.ts', 'src/vat.ts']),
    );
    expect(overlap).toEqual({ paths: ['src/totals.ts'], count: 1, truncated: false });
  });

  /**
   * The other direction, and it is the one a warning is judged on: a pair that shares a *directory*
   * is not an overlap. git merges two changes to two files in one directory without a conflict, and
   * a warning that fired on them would fire on every pair of tasks in a small repository.
   */
  it('says nothing about two tasks in the same directory', () => {
    expect(pathOverlap(side(['src/a.ts']), side(['src/b.ts']))).toEqual({
      paths: [],
      count: 0,
      truncated: false,
    });
  });

  it('matches a renamed file under either of its names', () => {
    // One side moved `src/totals.ts` to `src/money/totals.ts`; the other edited it where it was.
    const renamer: ChangedPaths = {
      newPaths: ['src/money/totals.ts'],
      oldPaths: ['src/totals.ts'],
      truncated: false,
    };
    expect(pathOverlap(renamer, side(['src/totals.ts'])).paths).toEqual(['src/totals.ts']);
    expect(pathOverlap(side(['src/money/totals.ts']), renamer).paths).toEqual([
      'src/money/totals.ts',
    ]);
  });

  it('compares case-sensitively, because the repository’s filesystem is not this platform’s', () => {
    expect(pathOverlap(side(['Src/A.ts']), side(['src/a.ts'])).count).toBe(0);
  });

  it('ignores an empty or whitespace-only path rather than matching everything on it', () => {
    expect(pathOverlap(side(['', '   ', 'src/a.ts']), side(['', 'src/b.ts'])).count).toBe(0);
  });

  it('sorts, so the same pair renders the same warning twice', () => {
    const left = side(['b.ts', 'a.ts', 'c.ts']);
    const right = side(['c.ts', 'a.ts', 'b.ts']);
    expect(pathOverlap(left, right).paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
    expect(pathOverlap(right, left).paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });

  it('caps the list it names and still counts what it found', () => {
    const many = Array.from({ length: MAX_OVERLAP_PATHS + 5 }, (_, index) => `src/f${index}.ts`);
    const overlap = pathOverlap(side(many), side(many));
    expect(overlap.paths).toHaveLength(MAX_OVERLAP_PATHS);
    // The number found is not the length of the list, which is what lets a warning say "and 5 more"
    // rather than under-reporting (standing rule 18).
    expect(overlap.count).toBe(MAX_OVERLAP_PATHS + 5);
  });

  it('bounds a path the provider let grow, on both sides of the comparison', () => {
    const long = `src/${'x'.repeat(MAX_OVERLAP_PATH_CHARS * 2)}.ts`;
    const overlap = pathOverlap(side([long]), side([long]));
    expect(overlap.count).toBe(1);
    expect(overlap.paths[0]).toHaveLength(MAX_OVERLAP_PATH_CHARS);
  });

  it('carries `truncated` from either side, so an empty overlap can say why', () => {
    expect(pathOverlap(side(['a.ts'], { truncated: true }), side(['b.ts'])).truncated).toBe(true);
    expect(pathOverlap(side(['a.ts']), side(['b.ts'], { truncated: true })).truncated).toBe(true);
    expect(pathOverlap(side(['a.ts']), side(['b.ts'])).truncated).toBe(false);
  });

  it('is symmetric in what it finds and bounded in what it names, for arbitrary path sets', {
    timeout: PROPERTY_TEST_TIMEOUT_MS,
  }, () => {
    const paths = fc.array(fc.string({ minLength: 1, maxLength: 40 }), { maxLength: 30 });
    fc.assert(
      fc.property(paths, paths, (left, right) => {
        const forwards = pathOverlap(side(left), side(right));
        const backwards = pathOverlap(side(right), side(left));
        // Symmetric in the *set* found — the two calls sort the same intersection.
        expect(forwards.count).toBe(backwards.count);
        expect(forwards.paths).toEqual(backwards.paths);
        expect(forwards.paths.length).toBeLessThanOrEqual(MAX_OVERLAP_PATHS);
        expect(forwards.paths.length).toBeLessThanOrEqual(forwards.count);
        for (const path of forwards.paths) {
          expect(path.length).toBeLessThanOrEqual(MAX_OVERLAP_PATH_CHARS);
        }
        // Nothing is invented: every reported path was named by both sides (after the same
        // trimming and cutting the comparison applies).
        const rightSet = new Set(right.map((path) => path.trim().slice(0, MAX_OVERLAP_PATH_CHARS)));
        const leftSet = new Set(left.map((path) => path.trim().slice(0, MAX_OVERLAP_PATH_CHARS)));
        for (const path of forwards.paths) {
          expect(leftSet.has(path) && rightSet.has(path)).toBe(true);
        }
      }),
    );
  });
});
