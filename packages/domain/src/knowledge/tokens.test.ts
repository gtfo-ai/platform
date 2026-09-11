import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CHARS_PER_TOKEN, estimateTokens } from './tokens.js';

describe('estimateTokens', () => {
  it('is zero only for the empty string', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens(' ')).toBe(1);
  });

  it('never returns zero for text that exists, so the budget fill cannot admit a free document', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (text) => {
        expect(estimateTokens(text)).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: 300 },
    );
  });

  it('is monotone in length, which is what makes a budget a budget', () => {
    fc.assert(
      fc.property(fc.string(), fc.string({ minLength: 1 }), (head, tail) => {
        expect(estimateTokens(head + tail)).toBeGreaterThanOrEqual(estimateTokens(head));
      }),
      { numRuns: 300 },
    );
  });

  it('produces the stated ratio at the shipped constant', () => {
    // Pinned rather than described: `CHARS_PER_TOKEN` is the divisor every budget in the platform
    // is denominated in, and a change to it must move a number in a test rather than pass silently.
    expect(CHARS_PER_TOKEN).toBe(4);
    expect(estimateTokens('a'.repeat(4))).toBe(1);
    expect(estimateTokens('a'.repeat(5))).toBe(2);
    expect(estimateTokens('a'.repeat(48_000))).toBe(12_000);
  });
});
