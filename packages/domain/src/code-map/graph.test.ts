import { describe, expect, it } from 'vitest';
import { type CodeFileSymbols, MAX_ITERATIONS, rankCodeGraph } from './graph.js';

const file = (
  path: string,
  definitions: readonly [string, string][],
  references: readonly string[],
): CodeFileSymbols => ({
  path,
  language: 'ts',
  definitions: definitions.map(([name, kind], index) => ({ name, kind, line: index + 1 })),
  references,
});

/**
 * A small graph with an obvious answer: `session.ts` defines what `router.ts` and `billing.ts` both
 * call, and `unrelated.ts` neither defines nor calls anything anyone else touches.
 */
const CORPUS: readonly CodeFileSymbols[] = [
  file(
    'src/api/session.ts',
    [
      ['createSession', 'function'],
      ['verifySession', 'function'],
      ['privateHelper', 'function'],
    ],
    ['randomUUID'],
  ),
  file(
    'src/api/router.ts',
    [['dispatch', 'function']],
    ['createSession', 'verifySession', 'verifySession'],
  ),
  file('src/billing/invoice.ts', [['buildInvoice', 'function']], ['verifySession']),
  file('src/unrelated/util.ts', [['clamp', 'function']], ['Math']),
];

describe('rankCodeGraph', () => {
  it('is empty for an empty corpus', () => {
    expect(rankCodeGraph({ files: [], focusPaths: [] })).toEqual([]);
  });

  it('ranks the file everyone calls above the file nobody calls', () => {
    const ranked = rankCodeGraph({ files: CORPUS, focusPaths: [] });
    const order = ranked.map((entry) => entry.path);
    expect(order[0]).toBe('src/api/session.ts');
    expect(order.at(-1)).toBe('src/unrelated/util.ts');
  });

  it('personalisation moves the ranking toward the task, which is the whole point', () => {
    const neutral = rankCodeGraph({ files: CORPUS, focusPaths: [] });
    const focused = rankCodeGraph({ files: CORPUS, focusPaths: ['src/billing/invoice.ts'] });
    const rankOf = (ranked: readonly { path: string; rank: number }[], path: string): number =>
      ranked.find((entry) => entry.path === path)?.rank ?? 0;
    expect(rankOf(focused, 'src/billing/invoice.ts')).toBeGreaterThan(
      rankOf(neutral, 'src/billing/invoice.ts'),
    );
  });

  it('falls back to a uniform restart when the focus set matches no known file', () => {
    // Not a cosmetic fallback: an all-zero personalisation vector makes the power iteration decay
    // to zero and every rank becomes equal *and* meaningless. Asserted by comparing with the
    // deliberate uniform case rather than by asserting the ranks are non-zero.
    const unknown = rankCodeGraph({ files: CORPUS, focusPaths: ['does/not/exist.ts'] });
    const uniform = rankCodeGraph({ files: CORPUS, focusPaths: [] });
    expect(unknown.map((entry) => entry.path)).toEqual(uniform.map((entry) => entry.path));
    expect(unknown.reduce((sum, entry) => sum + entry.rank, 0)).toBeGreaterThan(0.99);
  });

  it('orders a file symbols by how often other files reference them', () => {
    const ranked = rankCodeGraph({ files: CORPUS, focusPaths: [] });
    const session = ranked.find((entry) => entry.path === 'src/api/session.ts');
    expect(session?.symbols.map((symbol) => symbol.name)).toEqual([
      'verifySession',
      'createSession',
      'privateHelper',
    ]);
    expect(session?.symbols.at(-1)?.externalReferences).toBe(0);
  });

  it('ignores a file referencing its own definitions', () => {
    const selfReferential = [
      file('a.ts', [['thing', 'function']], ['thing', 'thing', 'thing', 'thing']),
      file('b.ts', [['other', 'function']], []),
    ];
    const ranked = rankCodeGraph({ files: selfReferential, focusPaths: [] });
    // With the self-edge dropped, `a.ts` has no outgoing edges at all and the two files split the
    // mass evenly. A self-edge would have put `a.ts` on top for referencing itself.
    expect(ranked[0]?.rank).toBeCloseTo(ranked[1]?.rank ?? 0, 10);
  });

  it('is deterministic — identical input gives a byte-identical ordering', () => {
    const once = rankCodeGraph({ files: CORPUS, focusPaths: ['src/api/router.ts'] });
    const twice = rankCodeGraph({ files: CORPUS, focusPaths: ['src/api/router.ts'] });
    expect(JSON.stringify(once)).toBe(JSON.stringify(twice));
  });

  it('terminates on a graph with no edges at all', () => {
    const isolated = Array.from({ length: 5 }, (_unused, index) =>
      file(`f${String(index)}.ts`, [[`s${String(index)}`, 'function']], []),
    );
    const ranked = rankCodeGraph({ files: isolated, focusPaths: [] });
    expect(ranked).toHaveLength(5);
    expect(ranked.reduce((sum, entry) => sum + entry.rank, 0)).toBeCloseTo(1, 6);
    expect(MAX_ITERATIONS).toBe(100);
  });

  it('keeps the total mass at 1 when dangling files are present', () => {
    // `src/unrelated/util.ts` has no outgoing edge. Without the dangling redistribution its mass
    // would leak out of the system on every iteration and the ranks would shrink toward zero.
    const ranked = rankCodeGraph({ files: CORPUS, focusPaths: [] });
    expect(ranked.reduce((sum, entry) => sum + entry.rank, 0)).toBeCloseTo(1, 6);
  });
});
