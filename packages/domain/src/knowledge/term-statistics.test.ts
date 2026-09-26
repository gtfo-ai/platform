import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  isUninformative,
  MAX_TERM_DOCUMENT_SHARE,
  MIN_DROPPABLE_DOCUMENTS,
  selectInformativeTerms,
  termStatisticsOf,
} from './term-statistics.js';

const page = (...texts: string[]) => ({ chunks: texts.map((text) => ({ text })) });

describe('termStatisticsOf', () => {
  it('counts documents, not occurrences, and a term once per document across its chunks', () => {
    const statistics = termStatisticsOf([
      page('session session session', 'session again'),
      page('billing and session'),
      page('billing only'),
    ]);
    expect(statistics.documents).toBe(3);
    expect(statistics.frequencies.get('session')).toBe(2);
    expect(statistics.frequencies.get('billing')).toBe(2);
    expect(statistics.frequencies.get('again')).toBe(1);
    // Sub-keyword tokens are never counted, because they are never searched.
    expect(statistics.frequencies.has('and')).toBe(false);
  });
});

describe('selectInformativeTerms — Q58', () => {
  const over = (documents: number, frequencies: Record<string, number>) => ({
    documents,
    frequency: (term: string) => frequencies[term] ?? 0,
  });

  it('drops a term only past half plus two standard errors (architect ruling, session 8)', () => {
    expect(MAX_TERM_DOCUMENT_SHARE).toBe(0.5);
    // N = 23 (the fixture vault): the line is 11.5 + √23 ≈ 16.30, so 16 is kept and 17 dropped.
    expect(
      selectInformativeTerms(
        ['demo', 'edge', 'session'],
        over(23, { demo: 17, edge: 16, session: 13 }),
      ),
    ).toEqual({ kept: ['edge', 'session'], uninformative: ['demo'], floor: 'applied' });
    // N = 160 (this repository's Markdown): the line is 80 + √160 ≈ 92.65.
    expect(isUninformative(93, 160)).toBe(true);
    expect(isUninformative(92, 160)).toBe(false);
  });

  it('drops nothing on a vault of four pages or fewer, and only a term in every page at five', () => {
    expect(MIN_DROPPABLE_DOCUMENTS).toBe(2);
    for (const documents of [1, 2, 3, 4]) {
      for (let frequency = 0; frequency <= documents; frequency += 1) {
        expect(isUninformative(frequency, documents), `${frequency}/${documents}`).toBe(false);
      }
    }
    // N = 5: 2.5 + √5 ≈ 4.74.
    expect(isUninformative(4, 5)).toBe(false);
    expect(isUninformative(5, 5)).toBe(true);
    expect(selectInformativeTerms(['only'], over(1, { only: 1 })).kept).toEqual(['only']);
  });

  it('drops nothing and says so when the index carries no statistics', () => {
    expect(selectInformativeTerms(['that', 'with'], null)).toEqual({
      kept: ['that', 'with'],
      uninformative: [],
      floor: 'no_statistics',
    });
  });

  it('partitions the request: every term is kept or dropped, once, in the caller order', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-z]{4,8}$/), { maxLength: 12 }),
        fc.integer({ min: 1, max: 40 }),
        fc.func(fc.nat()),
        (terms, documents, frequencyOf) => {
          const decided = selectInformativeTerms(terms, {
            documents,
            frequency: (term) => frequencyOf(term) % (documents + 1),
          });
          expect([...decided.kept, ...decided.uninformative].sort()).toEqual([...terms].sort());
          expect(decided.kept).toEqual(terms.filter((term) => decided.kept.includes(term)));
          for (const term of decided.uninformative) {
            const frequency = frequencyOf(term) % (documents + 1);
            expect(frequency).toBeGreaterThan(documents / 2 + Math.sqrt(documents));
            expect(frequency).toBeGreaterThanOrEqual(2);
          }
        },
      ),
      { numRuns: 300 },
    );
  });
});
