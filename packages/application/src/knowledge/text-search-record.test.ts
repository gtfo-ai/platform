/**
 * The text step's record (WP-44, PROGRESS backlog 172): five outcomes that must be told apart, and
 * the redaction that decides which terms may be stored.
 */
import { contextPackRecordSchema } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { exactSecretRedactor } from '../integrations/redaction.js';
import {
  NOT_SEARCHED,
  redactTextSearchTerms,
  textSearchRecordOf,
  type textStepOutcome,
} from './text-search-record.js';

const facts = (over: Partial<Parameters<typeof textStepOutcome>[0]> = {}) => ({
  queryTerms: ['session', 'rollback'],
  kept: ['session', 'rollback'],
  uninformative: [] as string[],
  floor: 'applied' as const,
  matchedDocuments: 3,
  ...over,
});

describe('the text step outcome', () => {
  it('tells the five causes of an empty tier 1 apart', () => {
    const rows = [
      NOT_SEARCHED,
      textSearchRecordOf(facts({ queryTerms: [], kept: [], matchedDocuments: 0 })),
      textSearchRecordOf(facts({ kept: [], uninformative: ['session', 'rollback'] })),
      textSearchRecordOf(facts({ matchedDocuments: 0 })),
      textSearchRecordOf(facts({ matchedDocuments: 0, floor: 'no_statistics' })),
    ];
    expect(rows.map((row) => [row.outcome, row.floor])).toEqual([
      ['not_searched', null],
      ['no_terms', 'applied'],
      ['all_uninformative', 'applied'],
      ['no_match', 'applied'],
      ['no_match', 'no_statistics'],
    ]);
    // Five distinct rows: no two of them can be read as the same fact.
    expect(new Set(rows.map((row) => JSON.stringify(row))).size).toBe(5);
    // And every one of them is a record the published schema accepts.
    for (const row of rows) {
      expect(
        contextPackRecordSchema.safeParse({
          tier0: [],
          tier1: [],
          budget_tokens: 12_000,
          total_tokens: 0,
          text_search: row,
        }).success,
      ).toBe(true);
    }
  });

  it('names the dropped words when the floor took every one', () => {
    expect(
      textSearchRecordOf(facts({ kept: [], uninformative: ['demo'], queryTerms: ['demo'] })),
    ).toEqual({
      outcome: 'all_uninformative',
      kept_terms: [],
      dropped_terms: ['demo'],
      floor: 'applied',
      matched_documents: 3,
      omitted_terms: 0,
    });
  });

  it('leaves out a term past the bound and counts it, rather than cutting it', () => {
    const blob = 'x'.repeat(65);
    const record = textSearchRecordOf(facts({ kept: ['session', blob] }));
    expect(record.kept_terms).toEqual(['session']);
    expect(record.omitted_terms).toBe(1);
  });
});

describe('the recorded terms and the run’s redactor', () => {
  it('leaves out a term the redactor would change, and counts it', () => {
    const secret = 'plantedsecretfake0001';
    const record = {
      tier0: [],
      tier1: [],
      budget_tokens: 12_000,
      total_tokens: 0,
      text_search: textSearchRecordOf(
        facts({ kept: ['session', secret], queryTerms: ['session'] }),
      ),
    };
    const redacted = redactTextSearchTerms(
      record,
      exactSecretRedactor([{ name: 'token', value: secret }]),
    );
    expect(redacted.text_search?.kept_terms).toEqual(['session']);
    expect(redacted.text_search?.omitted_terms).toBe(1);
    expect(JSON.stringify(redacted)).not.toContain(secret);
  });

  it('passes a record with no text step through untouched', () => {
    const record = { tier0: [], tier1: [], budget_tokens: 1, total_tokens: 0 };
    expect(redactTextSearchTerms(record, exactSecretRedactor([]))).toBe(record);
  });
});
