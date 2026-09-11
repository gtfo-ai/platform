/**
 * An **oracle** for the PageRank weighting, independent of the implementation it audits.
 *
 * ## Why this file exists
 *
 * `graph.test.ts` tests the ranking's *shape* — who outranks whom, that the ordering is
 * deterministic, that mass is conserved. Review found that every *numeric* choice underneath it was
 * untested: `DAMPING 0.85 → 0.5`, `sqrt(occurrences) / targets.length → occurrences`, and dropping
 * `/ targets.length` were all **alive** across 13 files and 215 tests. Those are precisely the
 * three modelling decisions the module's docblock spends three paragraphs justifying, and a
 * justification nothing can falsify is a comment. Standing rules 3 and 68: mutate every guard, and
 * test over the set you branch on rather than the set you remembered.
 *
 * ## What makes it an oracle rather than a second copy
 *
 * Standing rule 65: an oracle that shares a shape with the parser it audits is one guard, not two.
 * So the split here is deliberate and stated.
 *
 * **Not shared — the part under test.** The edge weights are *written out by hand* for each case,
 * from the sentence the docblock claims: "a symbol defined in many files is weak evidence, so its
 * vote is divided by the number of definers; a symbol referenced many times is stronger, so the
 * vote grows with `sqrt`". `buildEdges` is never called to produce them, so a change to the
 * weighting formula changes the implementation and not the expectation.
 *
 * **Shared — the part not under test.** {@link referencePageRank} is an ordinary power iteration,
 * written independently here with its own damping literal `0.85`. It shares the *algorithm* with
 * the implementation, because PageRank is PageRank; what it does not share is the constant, so a
 * `DAMPING` mutation makes the two disagree.
 *
 * **What it therefore cannot catch, stated rather than left to be discovered:** an error in the
 * power iteration itself that both sides make the same way — a wrong dangling treatment, say, if I
 * had reproduced my own mistake. Two cases below bound that: the first is small enough to have a
 * **closed-form** answer that is derived in the comment by algebra and written as a literal, so it
 * is independent of both implementations.
 */
import { describe, expect, it } from 'vitest';
import { type CodeFileSymbols, DAMPING, rankCodeGraph } from './graph.js';

/**
 * An independent power iteration over an explicit weight matrix.
 *
 * `weights[from][to]` is the raw weight of the edge; rows are normalised here exactly as PageRank
 * requires, a row that sums to zero is dangling, and its mass is redistributed over the restart
 * vector. The damping constant is this file's own literal.
 */
const REFERENCE_DAMPING = 0.85;

/**
 * Decimal places the two must agree to.
 *
 * Six, and the number is the implementation's own: `rankCodeGraph` stops when the total change
 * across an iteration drops below `CONVERGENCE_TOLERANCE = 1e-6`, so it is converged to about
 * **7e-8** per node and no tighter — measured, not assumed (at nine places the agreement is
 * 7.18e-8 short). The reference here runs to 1e-12, so this bound is a statement about the shipped
 * iteration and not about the oracle. It is still four orders of magnitude below what the mutations
 * move: `DAMPING 0.85 → 0.5` shifts the first case from 0.3509 to 0.4000.
 */
const ORACLE_PRECISION = 6;

const referencePageRank = (
  weights: readonly (readonly number[])[],
  restart: readonly number[],
): readonly number[] => {
  const n = restart.length;
  let rank = [...restart];
  for (let iteration = 0; iteration < 500; iteration += 1) {
    const next = new Array<number>(n).fill(0);
    let dangling = 0;
    for (let from = 0; from < n; from += 1) {
      const row = weights[from] as readonly number[];
      const total = row.reduce((sum, weight) => sum + weight, 0);
      if (total === 0) {
        dangling += rank[from] as number;
        continue;
      }
      for (let to = 0; to < n; to += 1) {
        next[to] = (next[to] as number) + (rank[from] as number) * ((row[to] as number) / total);
      }
    }
    const updated = next.map(
      (value, at) =>
        REFERENCE_DAMPING * (value + dangling * (restart[at] as number)) +
        (1 - REFERENCE_DAMPING) * (restart[at] as number),
    );
    const delta = updated.reduce(
      (sum, value, at) => sum + Math.abs(value - (rank[at] as number)),
      0,
    );
    rank = updated;
    if (delta < 1e-12) break;
  }
  return rank;
};

const file = (
  path: string,
  definitions: readonly string[],
  references: readonly string[],
): CodeFileSymbols => ({
  path,
  language: 'ts',
  definitions: definitions.map((name, index) => ({ name, kind: 'function', line: index + 1 })),
  references,
});

const ranksOf = (files: readonly CodeFileSymbols[]): ReadonlyMap<string, number> =>
  new Map(rankCodeGraph({ files, focusPaths: [] }).map((entry) => [entry.path, entry.rank]));

const uniform = (n: number): readonly number[] => new Array<number>(n).fill(1 / n);

describe('the damping factor is 0.85, and a closed form says so', () => {
  /**
   * Two files, `caller.ts → definer.ts`, and `definer.ts` references nothing.
   *
   * Solved by hand rather than by either implementation. With a uniform restart `(½, ½)`, one edge
   * of weight 1 out of `caller`, and `definer` dangling:
   *
   *     a = d·(b·½) + (1−d)·½                 (caller receives only the dangling redistribution)
   *     b = d·(a + b·½) + (1−d)·½             (definer receives caller's whole vote)
   *     a + b = 1
   *
   * Substituting `b = 1 − a` into the first: `a = ½d − ½d·a + ½ − ½d`, so `a(1 + ½d) = ½`, and
   *
   *     a = 1 / (2 + d)
   *
   * At `d = 0.85` that is `1/2.85 = 0.350877192982…`; at `d = 0.5` it would be `0.4`. The literal
   * below is the arithmetic, not a number read off a run.
   */
  const CALLER_RANK_AT_085 = 1 / 2.85;

  const twoFiles: readonly CodeFileSymbols[] = [
    file('caller.ts', [], ['definer']),
    file('definer.ts', ['definer'], []),
  ];

  it('matches the closed form 1/(2+d) for the caller', () => {
    const ranks = ranksOf(twoFiles);
    expect(ranks.get('caller.ts') ?? 0).toBeCloseTo(CALLER_RANK_AT_085, ORACLE_PRECISION);
    expect(ranks.get('definer.ts') ?? 0).toBeCloseTo(1 - CALLER_RANK_AT_085, ORACLE_PRECISION);
    // The shipped constant is the one the closed form was solved at.
    expect(DAMPING).toBe(0.85);
  });

  it('agrees with an independently written power iteration over the same hand-written weights', () => {
    const expected = referencePageRank(
      [
        [0, 1],
        [0, 0],
      ],
      uniform(2),
    );
    const ranks = ranksOf(twoFiles);
    expect(ranks.get('caller.ts') ?? 0).toBeCloseTo(expected[0] as number, ORACLE_PRECISION);
    expect(ranks.get('definer.ts') ?? 0).toBeCloseTo(expected[1] as number, ORACLE_PRECISION);
  });
});

describe('a repeated reference grows the vote by sqrt, not linearly', () => {
  /**
   * One caller, two definers, and the only difference between them is how often the caller mentions
   * each: `alpha` once, `beta` four times.
   *
   * The docblock's claim is `sqrt(occurrences) / definers`, so the hand-written weights are
   * `alpha → sqrt(1)/1 = 1` and `beta → sqrt(4)/1 = 2`. A linear model would make them `1` and `4`,
   * which is the mutation that survived review.
   */
  const files: readonly CodeFileSymbols[] = [
    file('caller.ts', [], ['alpha', 'beta', 'beta', 'beta', 'beta']),
    file('alpha.ts', ['alpha'], []),
    file('beta.ts', ['beta'], []),
  ];

  it('matches hand-written weights of 1 and 2', () => {
    const expected = referencePageRank(
      [
        [0, 1, 2],
        [0, 0, 0],
        [0, 0, 0],
      ],
      uniform(3),
    );
    const ranks = ranksOf(files);
    expect(ranks.get('caller.ts') ?? 0).toBeCloseTo(expected[0] as number, ORACLE_PRECISION);
    expect(ranks.get('alpha.ts') ?? 0).toBeCloseTo(expected[1] as number, ORACLE_PRECISION);
    expect(ranks.get('beta.ts') ?? 0).toBeCloseTo(expected[2] as number, ORACLE_PRECISION);
  });

  it('does not match the linear model, which is the alternative under test', () => {
    // Stated as its own assertion rather than trusted to the one above: a test that only says
    // "equals X" leaves a reader unable to tell whether X discriminates (standing rule 43 — ask
    // which wrong implementations your assertion would also pass).
    const linear = referencePageRank(
      [
        [0, 1, 4],
        [0, 0, 0],
        [0, 0, 0],
      ],
      uniform(3),
    );
    const ranks = ranksOf(files);
    expect(ranks.get('beta.ts') ?? 0).not.toBeCloseTo(linear[2] as number, 4);
  });

  it('is sublinear in the number of references, as an invariant', () => {
    // The same claim without any reference implementation at all: four mentions must be worth more
    // than one and less than four, whatever the exact curve.
    const excess = (occurrences: number): number => {
      const graph = [
        file('caller.ts', [], ['alpha', ...Array.from({ length: occurrences }, () => 'beta')]),
        file('alpha.ts', ['alpha'], []),
        file('beta.ts', ['beta'], []),
      ];
      const ranks = ranksOf(graph);
      return (ranks.get('beta.ts') ?? 0) / (ranks.get('alpha.ts') ?? 1);
    };
    const one = excess(1);
    const four = excess(4);
    expect(four).toBeGreaterThan(one);
    expect(four).toBeLessThan(one * 4);
  });
});

describe('a symbol many files define is worth a fraction of a vote to each', () => {
  /**
   * `caller.ts` mentions `shared` four times — and `shared` is defined by **two** files — and
   * `only` once, defined by one.
   *
   * Hand-written weights from the docblock's claim: `shared → sqrt(4)/2 = 1` to *each* definer,
   * `only → sqrt(1)/1 = 1`. All three definers therefore receive the same vote, which is the whole
   * point of dividing by the definer count: a name everybody uses must not out-vote a name one file
   * owns. Without the division `shared` would send 2 to each and the two common definers would
   * outrank the specific one.
   */
  const files: readonly CodeFileSymbols[] = [
    file('caller.ts', [], ['shared', 'shared', 'shared', 'shared', 'only']),
    file('common-a.ts', ['shared'], []),
    file('common-b.ts', ['shared'], []),
    file('specific.ts', ['only'], []),
  ];

  it('gives all three definers the same rank', () => {
    const ranks = ranksOf(files);
    const a = ranks.get('common-a.ts') ?? 0;
    const b = ranks.get('common-b.ts') ?? 0;
    const specific = ranks.get('specific.ts') ?? 0;
    expect(a).toBeCloseTo(b, ORACLE_PRECISION);
    expect(a).toBeCloseTo(specific, ORACLE_PRECISION);
  });

  it('matches hand-written weights of 1, 1, 1', () => {
    const expected = referencePageRank(
      [
        [0, 1, 1, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      uniform(4),
    );
    const ranks = ranksOf(files);
    for (const [at, path] of ['caller.ts', 'common-a.ts', 'common-b.ts', 'specific.ts'].entries()) {
      expect(ranks.get(path) ?? 0).toBeCloseTo(expected[at] as number, ORACLE_PRECISION);
    }
  });

  it('does not match the undivided model, where the common definers win', () => {
    const undivided = referencePageRank(
      [
        [0, 2, 2, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
      ],
      uniform(4),
    );
    const ranks = ranksOf(files);
    expect(ranks.get('common-a.ts') ?? 0).not.toBeCloseTo(undivided[1] as number, 4);
    // And the invariant behind it, independent of any reference: the specific definer is not beaten
    // by a definer of a name two files share.
    expect(ranks.get('specific.ts') ?? 0).toBeGreaterThanOrEqual(
      (ranks.get('common-a.ts') ?? 0) - 1e-9,
    );
  });
});

describe('personalisation, against the same oracle', () => {
  it('matches a hand-written restart vector', () => {
    const files: readonly CodeFileSymbols[] = [
      file('caller.ts', [], ['definer']),
      file('definer.ts', ['definer'], []),
      file('island.ts', ['island'], []),
    ];
    const focused = rankCodeGraph({ files, focusPaths: ['island.ts'] });
    const expected = referencePageRank(
      [
        [0, 1, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      [0, 0, 1],
    );
    const byPath = new Map(focused.map((entry) => [entry.path, entry.rank]));
    for (const [at, path] of ['caller.ts', 'definer.ts', 'island.ts'].entries()) {
      expect(byPath.get(path) ?? 0).toBeCloseTo(expected[at] as number, ORACLE_PRECISION);
    }
  });
});
