/**
 * The task-management port's pure parts (WP-171): the status-category normalisation of ruling (b)
 * and the member → capability table the shared contract suite runs its branches from.
 */
import { describe, expect, it } from 'vitest';
import {
  commentPageSchema,
  LIFECYCLE_MEMBER_CAPABILITY,
  listCommentsOptionsSchema,
  MAX_TICKET_SEARCH_WORD_CHARS,
  MAX_TICKET_SEARCH_WORDS,
  normaliseStatusCategory,
  parseTicketSearchQuery,
  ticketSearchOptionsSchema,
} from './task-management.js';

describe('normaliseStatusCategory (WP-171 ruling (b), research/15 J1a, J3)', () => {
  it.each([
    ['new', 'todo'],
    ['indeterminate', 'in_progress'],
    ['in-flight', 'in_progress'],
    ['done', 'done'],
    // Anything the table does not hold is unknown — never a guess, and the raw key survives.
    ['undefined', 'unknown'],
    ['some-fourth-key', 'unknown'],
    ['DONE', 'unknown'],
    ['New', 'unknown'],
    [' done', 'unknown'],
    ['todo', 'unknown'],
    ['in_progress', 'unknown'],
  ] as const)('maps the key %j to %j and keeps it', (raw, category) => {
    expect(normaliseStatusCategory(raw)).toEqual({ category, raw_category: raw });
  });

  it.each([null, undefined, ''])('answers unknown with no raw key for %j', (raw) => {
    expect(normaliseStatusCategory(raw)).toEqual({ category: 'unknown', raw_category: null });
  });
});

describe('the lifecycle members', () => {
  it('declares each of the seven members by one of the five flags, and every flag is used', () => {
    expect(Object.keys(LIFECYCLE_MEMBER_CAPABILITY).toSorted()).toEqual(
      [
        'assignTo',
        'assignToSelf',
        'listComments',
        'listStatuses',
        'listTransitions',
        'selfIdentity',
        'unassign',
      ].toSorted(),
    );
    expect([...new Set(Object.values(LIFECYCLE_MEMBER_CAPABILITY))].toSorted()).toEqual(
      ['assign', 'assignOthers', 'commentsRead', 'lifecycleStatuses', 'transitionsRead'].toSorted(),
    );
    // S-26.3: the owner write-back has a flag of its own, never the claim's.
    expect(LIFECYCLE_MEMBER_CAPABILITY.assignTo).toBe('assignOthers');
  });

  it('bounds a comment page request at one provider page', () => {
    expect(listCommentsOptionsSchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(listCommentsOptionsSchema.safeParse({ limit: 101 }).success).toBe(false);
    expect(listCommentsOptionsSchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(listCommentsOptionsSchema.safeParse({ limit: 5, since: 'yesterday' }).success).toBe(
      false,
    );
  });

  it('carries an unknown total as null, never as a number it invented', () => {
    expect(commentPageSchema.safeParse({ comments: [], total: null }).success).toBe(true);
    expect(commentPageSchema.safeParse({ comments: [] }).success).toBe(false);
  });
});

describe('parseTicketSearchQuery (the Start a ticket typeahead)', () => {
  it.each([
    ['ACME-12', 'ACME', '12'],
    ['acme-12', 'ACME', '12'],
    ['  Go-1234  ', 'GO', '1234'],
    ['ACME-', 'ACME', ''],
    ['A_B2-7', 'A_B2', '7'],
  ])('reads %j as a key of project %j starting with %j', (text, project, number) => {
    expect(parseTicketSearchQuery(text)).toEqual({ kind: 'key', project, number });
  });

  it.each([
    ['invoice pdf', ['invoice', 'pdf']],
    ['Invoice  PDF invoice', ['invoice', 'pdf']],
    ['Rezervace přes změnu', ['rezervace', 'přes', 'změnu']],
    // Not key-shaped: a digit first, a space, two dashes, too many digits.
    ['1-2', [] as string[]],
    ['ACME 12', ['acme', '12']],
    ['ACME-12-3', ['acme', '12']],
    ['ACME-1234567890123', ['acme', '1234567890123']],
  ])('reads %j as words %j', (text, words) => {
    const parsed = parseTicketSearchQuery(text);
    expect(parsed).toEqual(words.length === 0 ? null : { kind: 'words', words });
  });

  it('keeps no punctuation of the person’s: quotes, operators, wildcards and escapes are dropped', () => {
    for (const hostile of [
      '") OR project != "X',
      'a\\" OR 1=1 --',
      'summary ~ "x*" ORDER BY',
      '*?~^:[]{}()+!&|',
      'pdf*" AND assignee = currentUser()',
    ]) {
      const parsed = parseTicketSearchQuery(hostile);
      if (parsed === null) {
        continue;
      }
      expect(parsed.kind, hostile).toBe('words');
      for (const word of parsed.kind === 'words' ? parsed.words : []) {
        expect(word, hostile).toMatch(/^[\p{L}\p{M}\p{N}]+$/u);
        expect(word, hostile).toBe(word.toLowerCase());
      }
    }
    expect(parseTicketSearchQuery('*?~^:[]{}()+!&|')).toBeNull();
  });

  it('answers null when nothing searchable is left', () => {
    for (const text of ['', '   ', 'a', 'a b c', '-', '""', '...']) {
      expect(parseTicketSearchQuery(text), JSON.stringify(text)).toBeNull();
    }
  });

  it('bounds the words: at most MAX_TICKET_SEARCH_WORDS, each cut to MAX_TICKET_SEARCH_WORD_CHARS', () => {
    const parsed = parseTicketSearchQuery(
      `${'x'.repeat(MAX_TICKET_SEARCH_WORD_CHARS + 10)} b1 c1 d1 e1 f1 g1`,
    );
    expect(parsed?.kind).toBe('words');
    const words = parsed?.kind === 'words' ? parsed.words : [];
    expect(words).toHaveLength(MAX_TICKET_SEARCH_WORDS);
    expect(words[0]).toBe('x'.repeat(MAX_TICKET_SEARCH_WORD_CHARS));
    expect(words.slice(1)).toEqual(['b1', 'c1', 'd1', 'e1']);
  });

  it('bounds the limit at 1 to MAX_TICKET_SEARCH_RESULTS', () => {
    expect(ticketSearchOptionsSchema.safeParse({ limit: 10 }).success).toBe(true);
    expect(ticketSearchOptionsSchema.safeParse({ limit: 11 }).success).toBe(false);
    expect(ticketSearchOptionsSchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});
