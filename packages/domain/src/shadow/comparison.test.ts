/**
 * product/19 §13's arithmetic, both ways (WP-34).
 *
 * Standing rule 42 shapes every case here: a Jaccard that always answered 1 would pass every
 * "the agent matched" assertion, and a bucket that counted everything would pass every
 * distribution assertion, so each figure is asserted at a value **and** at a value that must
 * differ. The three refusals (`tests_added_ratio` with no human test, an absent size band, a
 * launch-candidate list with nothing in it) each have a case where they fire and one where they do
 * not, because "no answer" is the branch a reader is most likely to be given wrongly.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  compareShadowDiffs,
  filesJaccard,
  isTestPath,
  LAUNCH_CANDIDATE_SIMILARITY,
  medianOf,
  type ShadowBatchEntry,
  SIMILARITY_BUCKETS,
  summariseShadowBatch,
} from './comparison.js';

const PROPERTY_RUNS = Number(process.env.MODEL_RUNS ?? 200);

describe('filesJaccard', () => {
  it('is 1 for the same set and 0 for disjoint ones', () => {
    expect(filesJaccard(['a.ts', 'b.ts'], ['b.ts', 'a.ts'])).toBe(1);
    expect(filesJaccard(['a.ts'], ['b.ts'])).toBe(0);
  });

  it('counts the intersection over the union, and duplicates do not inflate either', () => {
    // |{a,b} ∩ {b,c}| = 1, |{a,b} ∪ {b,c}| = 3.
    expect(filesJaccard(['a.ts', 'b.ts', 'b.ts'], ['b.ts', 'c.ts'])).toBeCloseTo(1 / 3, 10);
  });

  it('answers 1 for two empty diffs, because two changes of nothing are identical', () => {
    expect(filesJaccard([], [])).toBe(1);
    // …and 0 when only one side is empty, which is the case the report refuses to publish at all.
    expect(filesJaccard(['a.ts'], [])).toBe(0);
  });

  it('is symmetric and always inside [0, 1]', () => {
    const paths = fc.array(fc.string({ minLength: 1, maxLength: 6 }), { maxLength: 8 });
    fc.assert(
      fc.property(paths, paths, (left, right) => {
        const value = filesJaccard(left, right);
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
        expect(filesJaccard(right, left)).toBe(value);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });

  it('is case-sensitive, because path identity is the repository’s and not the platform’s', () => {
    expect(filesJaccard(['src/Totals.ts'], ['src/totals.ts'])).toBe(0);
  });
});

describe('isTestPath', () => {
  it('recognises the conventions this platform has met', () => {
    for (const path of [
      'src/totals.test.ts',
      'src/totals.spec.tsx',
      'test/totals.py',
      'tests/api/totals.rb',
      'src/__tests__/totals.js',
      'spec/models/invoice_spec.rb',
      'app/testing/helpers.go',
      'pkg/totals_test.go',
      'tests/test_totals.py',
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
  });

  it('does not claim a source file is a test', () => {
    for (const path of [
      'src/totals.ts',
      'src/latest.ts',
      'src/protest/index.ts',
      'src/contest.ts',
      'docs/specification.md',
    ]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });

  it('never lets a name escape its own ecosystem of markers', () => {
    // The property the docblock claims: a path with no marker and no test directory is never a
    // test, whatever else is in it.
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), (raw) => {
        const path = `src/${raw.replaceAll(/[^A-Za-z0-9]/g, 'x')}.ts`;
        const lower = path.toLowerCase();
        const marked =
          lower.includes('.test.') ||
          lower.includes('.spec.') ||
          /\/(test|spec)_/.test(lower) ||
          lower.includes('_test.') ||
          lower.includes('-test.') ||
          lower.includes('_spec.') ||
          lower.includes('-spec.');
        expect(isTestPath(path)).toBe(marked);
      }),
      { numRuns: PROPERTY_RUNS },
    );
  });
});

describe('compareShadowDiffs', () => {
  const agent = {
    paths: ['src/totals.ts', 'src/totals.test.ts'],
    insertions: 40,
    deletions: 4,
  };
  const human = {
    paths: ['src/totals.ts', 'src/format.ts', 'src/totals.test.ts', 'src/format.test.ts'],
    insertions: 80,
    deletions: 8,
  };

  it('computes every field of the block from the two sides', () => {
    const overlap = compareShadowDiffs(agent, human);
    expect(overlap.files_jaccard).toBeCloseTo(2 / 4, 10);
    expect(overlap.size_ratio).toBeCloseTo(44 / 88, 10);
    expect(overlap.agent_test_files).toBe(1);
    expect(overlap.human_test_files).toBe(2);
    expect(overlap.tests_added_ratio).toBeCloseTo(0.5, 10);
  });

  it('refuses a tests ratio the human side cannot denominate, and keeps the counts', () => {
    const overlap = compareShadowDiffs(agent, { ...human, paths: ['src/totals.ts'] });
    expect(overlap.tests_added_ratio).toBeNull();
    // Both ways (standing rule 42): the counts are still there, so a reader can tell "no tests
    // were added" from "this repository does not name its tests the way we look for them".
    expect(overlap.agent_test_files).toBe(1);
    expect(overlap.human_test_files).toBe(0);
  });

  it('refuses a size ratio the human side cannot denominate, both ways', () => {
    // Round 2's major finding: this answered `0` for a human side with no countable line, and the
    // Shadow screen printed *"size ratio: 0.00"* — a measurement of the agent against a
    // denominator nobody has (standing rule 16). It is reachable: a provider that renders no patch
    // (`omitted`, a null body) contributes paths and no lines, so `report.ts` counts zero for a
    // merge request that plainly changed something.
    const unrendered = { paths: ['src/totals.ts'], insertions: 0, deletions: 0 };
    expect(compareShadowDiffs(agent, unrendered).size_ratio).toBeNull();
    // …including the both-empty case the old docblock claimed `0` for while the code answered `1`:
    // "nothing over nothing" is still a division by zero, and `filesJaccard` is where two empty
    // sides are answered as identical.
    expect(compareShadowDiffs(unrendered, unrendered).size_ratio).toBeNull();
    // …and the other direction (standing rule 42): a rendered human diff still yields a number, so
    // a function that returned `null` for everything would fail here.
    expect(compareShadowDiffs(agent, human).size_ratio).toBeCloseTo(44 / 88, 10);
  });
});

describe('medianOf', () => {
  it('is the middle value for an odd count and the mean of the two middles for an even one', () => {
    expect(medianOf([3, 1, 2])).toBe(2);
    expect(medianOf([4, 1, 3, 2])).toBe(2.5);
  });

  it('is null for nothing, because there is no median of no samples', () => {
    expect(medianOf([])).toBeNull();
  });

  it('is not the mean — one outlier does not move it', () => {
    expect(medianOf([1, 1, 1, 1, 1000])).toBe(1);
  });
});

const entry = (overrides: Partial<ShadowBatchEntry>): ShadowBatchEntry => ({
  ticketKey: 'ACME-1',
  taskId: '00000000-0000-4000-8000-000000000001',
  size: 'M',
  costUsd: 5,
  predictedCostUsd: 6,
  similarity: 0.5,
  reported: true,
  ...overrides,
});

describe('summariseShadowBatch', () => {
  it('reports a median per size band and omits a band nobody shadowed', () => {
    const aggregate = summariseShadowBatch([
      entry({ ticketKey: 'A-1', size: 'S', costUsd: 2, predictedCostUsd: 3 }),
      entry({ ticketKey: 'A-2', size: 'S', costUsd: 6, predictedCostUsd: null }),
      entry({ ticketKey: 'A-3', size: 'L', costUsd: 30, predictedCostUsd: 28 }),
    ]);
    expect(aggregate.cost_by_size).toEqual([
      { size: 'S', tickets: 2, median_cost_usd: 4, median_predicted_cost_usd: 3 },
      { size: 'L', tickets: 1, median_cost_usd: 30, median_predicted_cost_usd: 28 },
    ]);
    // Absent, not zero (standing rule 16): `M` and `XL` are simply not in the table.
    expect(aggregate.cost_by_size.map((row) => row.size)).not.toContain('M');
  });

  it('counts an unreported ticket in nothing at all', () => {
    const aggregate = summariseShadowBatch([
      entry({ ticketKey: 'A-1', reported: false, similarity: null }),
      entry({ ticketKey: 'A-2', costUsd: 9 }),
    ]);
    expect(aggregate.reported).toBe(1);
    expect(aggregate.compared).toBe(1);
    expect(aggregate.cost_by_size).toEqual([
      { size: 'M', tickets: 1, median_cost_usd: 9, median_predicted_cost_usd: 6 },
    ]);
  });

  it('puts each similarity in exactly one fixed bucket, and 1.0 in the last one', () => {
    const aggregate = summariseShadowBatch([
      entry({ ticketKey: 'A-1', similarity: 0 }),
      entry({ ticketKey: 'A-2', similarity: 0.2 }),
      entry({ ticketKey: 'A-3', similarity: 0.79 }),
      entry({ ticketKey: 'A-4', similarity: 1 }),
      entry({ ticketKey: 'A-5', similarity: null, reported: true }),
    ]);
    expect(aggregate.similarity_distribution.map((bucket) => bucket.tickets)).toEqual([
      1, 1, 0, 1, 1,
    ]);
    expect(aggregate.similarity_distribution).toHaveLength(SIMILARITY_BUCKETS.length);
    // A reported ticket with no comparison is counted in `reported` and in no bucket.
    expect(aggregate.reported).toBe(5);
    expect(aggregate.compared).toBe(4);
  });

  it('names the launch candidates and orders them, and leaves out the expensive twin', () => {
    const aggregate = summariseShadowBatch([
      // Similar and cheap — the shape product/19 §13 calls a launch candidate.
      entry({ ticketKey: 'A-1', similarity: 0.9, costUsd: 2 }),
      entry({ ticketKey: 'A-2', similarity: 0.7, costUsd: 2 }),
      // Similar and **dearer than the median**, so not a candidate.
      entry({ ticketKey: 'A-3', similarity: 0.95, costUsd: 40 }),
      // Cheap and **not similar**, so not a candidate either — the other direction (rule 42).
      entry({ ticketKey: 'A-4', similarity: 0.1, costUsd: 1 }),
    ]);
    expect(aggregate.launch_candidates.map((candidate) => candidate.ticket_key)).toEqual([
      'A-1',
      'A-2',
    ]);
    expect(aggregate.launch_candidates[0]?.similarity).toBe(0.9);
  });

  it('takes the threshold from the bucket boundary, at it and one step below', () => {
    const at = summariseShadowBatch([
      entry({ ticketKey: 'A-1', similarity: LAUNCH_CANDIDATE_SIMILARITY }),
    ]);
    expect(at.launch_candidates).toHaveLength(1);
    const below = summariseShadowBatch([
      entry({ ticketKey: 'A-1', similarity: LAUNCH_CANDIDATE_SIMILARITY - 0.01 }),
    ]);
    expect(below.launch_candidates).toEqual([]);
  });

  it('is empty in every field for a batch nothing has reported yet', () => {
    const aggregate = summariseShadowBatch([
      entry({ reported: false, similarity: null }),
      entry({ ticketKey: 'A-2', reported: false, similarity: null }),
    ]);
    expect(aggregate.cost_by_size).toEqual([]);
    expect(aggregate.launch_candidates).toEqual([]);
    expect(aggregate.reported).toBe(0);
    expect(aggregate.similarity_distribution.every((bucket) => bucket.tickets === 0)).toBe(true);
  });
});
