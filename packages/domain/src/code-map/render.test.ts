import { describe, expect, it } from 'vitest';
import { estimateTokens } from '../knowledge/tokens.js';
import type { RankedFile } from './graph.js';
import {
  DEFAULT_CODE_MAP_TOKEN_BUDGET,
  focusHash,
  MAX_SYMBOLS_PER_FILE,
  renderCodeMap,
} from './render.js';

const ranked = (path: string, rank: number, symbols: number): RankedFile => ({
  path,
  rank,
  symbols: Array.from({ length: symbols }, (_unused, index) => ({
    name: `symbol${String(index)}`,
    kind: 'function',
    line: index + 1,
    externalReferences: symbols - index,
  })),
});

describe('renderCodeMap', () => {
  it('renders files in rank order with their symbols', () => {
    const rendered = renderCodeMap([ranked('a.ts', 0.5, 2), ranked('b.ts', 0.2, 1)], 1_000);
    expect(rendered.text.split('\n')).toEqual([
      'Repository map — files and their key symbols, most relevant first.',
      'a.ts: symbol0 (function), symbol1 (function)',
      'b.ts: symbol0 (function)',
    ]);
    expect(rendered.filesIncluded).toBe(2);
    expect(rendered.filesOmitted).toBe(0);
  });

  it('summarises the tail of a file with many symbols', () => {
    const rendered = renderCodeMap([ranked('a.ts', 1, MAX_SYMBOLS_PER_FILE + 7)], 1_000);
    expect(rendered.text).toContain('… 7 more');
    expect(rendered.text.split(', ').filter((part) => part.includes('(function)'))).toHaveLength(
      MAX_SYMBOLS_PER_FILE,
    );
  });

  it('renders a file with no symbols as a bare path rather than an empty entry', () => {
    const rendered = renderCodeMap([ranked('a.ts', 1, 0)], 1_000);
    expect(rendered.text.split('\n')[1]).toBe('a.ts');
  });

  it('stops at the budget and reports what it omitted', () => {
    const files = Array.from({ length: 200 }, (_unused, index) =>
      ranked(`src/module-${String(index).padStart(3, '0')}.ts`, 1 - index / 1000, 6),
    );
    const rendered = renderCodeMap(files, 200);
    expect(rendered.tokens).toBeLessThanOrEqual(200);
    expect(rendered.filesIncluded).toBeGreaterThan(0);
    expect(rendered.filesOmitted).toBe(200 - rendered.filesIncluded);
    expect(estimateTokens(rendered.text)).toBeLessThanOrEqual(200);
  });

  it('emits the header alone when not even the first file fits', () => {
    const rendered = renderCodeMap([ranked('a-very-long-path-indeed.ts', 1, 40)], 20);
    expect(rendered.filesIncluded).toBe(0);
    expect(rendered.filesOmitted).toBe(1);
    expect(rendered.text).toBe(
      'Repository map — files and their key symbols, most relevant first.',
    );
  });

  it('never reorders to fit — a big file that does not fit ends the map', () => {
    const big = ranked('big.ts', 0.9, 60);
    const small = ranked('small.ts', 0.1, 1);
    const budget =
      estimateTokens('Repository map — files and their key symbols, most relevant first.') + 5;
    const rendered = renderCodeMap([big, small], budget);
    expect(rendered.text).not.toContain('small.ts');
    expect(rendered.filesIncluded).toBe(0);
  });

  it('ships the budget technical/07 names', () => {
    expect(DEFAULT_CODE_MAP_TOKEN_BUDGET).toBe(2_000);
    expect(DEFAULT_CODE_MAP_TOKEN_BUDGET).toBeGreaterThanOrEqual(1_000);
    expect(DEFAULT_CODE_MAP_TOKEN_BUDGET).toBeLessThanOrEqual(4_000);
  });
});

describe('focusHash', () => {
  it('is order-independent, so two callers with the same focus set share a cache entry', () => {
    expect(focusHash(['b.ts', 'a.ts'])).toBe(focusHash(['a.ts', 'b.ts']));
  });

  it('separates focus sets that differ', () => {
    expect(focusHash(['a.ts'])).not.toBe(focusHash(['a.ts', 'b.ts']));
    expect(focusHash([])).not.toBe(focusHash(['a.ts']));
  });

  it('does not collide on a concatenation of the same characters', () => {
    // A hash that folded paths together without a separator would give these one key, and a cache
    // hit would then serve one task another task's map.
    expect(focusHash(['ab', 'c'])).not.toBe(focusHash(['a', 'bc']));
  });

  it('is eight hex characters', () => {
    expect(focusHash(['a.ts'])).toMatch(/^[0-9a-f]{8}$/);
  });
});
