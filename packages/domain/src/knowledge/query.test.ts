import { describe, expect, it } from 'vitest';
import { extractQueryTerms, MAX_QUERY_TERMS, MIN_QUERY_TERM_LENGTH } from './query.js';

describe('extractQueryTerms', () => {
  it('keeps the words a ticket is actually about', () => {
    expect(
      extractQueryTerms('the session service fails its tests with a foreign key violation'),
    ).toEqual(['session', 'service', 'fails', 'tests', 'with', 'foreign', 'violation']);
  });

  it('extracts nothing from the degenerate queries that caused the harm', () => {
    // The measured case: `"the"` ranked four padded pages at 0.947 against a real PostgreSQL —
    // higher than any real query scores its own answer — and filled 87 % of a pack with them. The
    // guard is here, at the query, because no score threshold can separate those two (`retrieval.ts`).
    expect(extractQueryTerms('the')).toEqual([]);
    expect(extractQueryTerms('and the of')).toEqual([]);
    expect(extractQueryTerms('a an is to be')).toEqual([]);
    expect(extractQueryTerms('')).toEqual([]);
    expect(extractQueryTerms('   ')).toEqual([]);
  });

  it('lowercases and de-duplicates, in first-seen order', () => {
    expect(extractQueryTerms('Session SESSION session service')).toEqual(['session', 'service']);
  });

  it('drops every token shorter than the floor and keeps every token at it', () => {
    expect(MIN_QUERY_TERM_LENGTH).toBe(4);
    expect(extractQueryTerms('abc abcd abcde')).toEqual(['abcd', 'abcde']);
  });

  it('yields tokens that cannot carry a tsquery operator', () => {
    // The safety property the adapter relies on to `join(' OR ')` at all: whatever a model or a
    // ticket writes, what reaches the query is word characters. Asserted over the operators
    // `websearch_to_tsquery` and `to_tsquery` actually have.
    const hostile = '\' or 1=1 -- & | ! ( ) :* <-> "phrase" session_store';
    const terms = extractQueryTerms(hostile);
    expect(terms).toEqual(['phrase', 'session_store']);
    for (const term of terms) expect(term).toMatch(/^[\p{L}\p{N}_]+$/u);
  });

  it('keeps letters outside ASCII, because the vault is mixed Czech and English', () => {
    expect(extractQueryTerms('chybí příloha faktury')).toEqual(['chybí', 'příloha', 'faktury']);
  });

  it('caps the number of terms, so a pasted stack trace is not a thousand-branch query', () => {
    const many = Array.from(
      { length: MAX_QUERY_TERMS * 3 },
      (_unused, index) => `term${String(index).padStart(4, '0')}`,
    ).join(' ');
    const terms = extractQueryTerms(many);
    expect(terms).toHaveLength(MAX_QUERY_TERMS);
    // First-seen order, so the terms kept are the ones nearest the start of the ticket.
    expect(terms[0]).toBe('term0000');
  });

  it('counts distinct terms towards the cap, not repeats', () => {
    expect(extractQueryTerms(Array.from({ length: 100 }, () => 'session').join(' '))).toEqual([
      'session',
    ]);
  });
});
