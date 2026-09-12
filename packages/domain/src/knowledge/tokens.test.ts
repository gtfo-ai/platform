import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { MODEL_RUNS, PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import { BYTES_PER_TOKEN, estimateTokens, utf8ByteLength } from './tokens.js';

describe('utf8ByteLength', () => {
  it(
    'agrees with TextEncoder on every string, lone surrogates included',
    () => {
      fc.assert(
        fc.property(fc.string({ unit: 'binary' }), (text) => {
          expect(utf8ByteLength(text)).toBe(new TextEncoder().encode(text).length);
        }),
        { numRuns: MODEL_RUNS },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('counts the scripts the ratio is wrong about, one at a time', () => {
    expect(utf8ByteLength('abcd')).toBe(4);
    expect(utf8ByteLength('ěščř')).toBe(8);
    // CJK is three bytes per character, which is the whole of PROGRESS backlog 14.
    expect(utf8ByteLength('日本語')).toBe(9);
    expect(utf8ByteLength('😀')).toBe(4);
    expect(utf8ByteLength('\u{D800}')).toBe(3);
  });
});

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

  it(
    'is exactly the stated ratio over UTF-8 bytes',
    () => {
      // PROGRESS backlog 14: "`tokens.test.ts` asserts non-zero and monotone, and both properties
      // are satisfied by an **arbitrarily wrong** estimator, so the suite cannot tell a
      // 4-bytes-per-token model from a 40-bytes-per-token one." This one can: it fails for any
      // divisor but the shipped constant, and for any unit but UTF-8 bytes.
      fc.assert(
        fc.property(fc.string({ unit: 'binary' }), (text) => {
          const bytes = new TextEncoder().encode(text).length;
          expect(estimateTokens(text)).toBe(bytes === 0 ? 0 : Math.ceil(bytes / BYTES_PER_TOKEN));
        }),
        { numRuns: MODEL_RUNS },
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('counts bytes and not JavaScript characters, which is the fix backlog 14 asked for', () => {
    expect(BYTES_PER_TOKEN).toBe(4);
    expect(estimateTokens('a'.repeat(4))).toBe(1);
    expect(estimateTokens('a'.repeat(5))).toBe(2);
    // ASCII is unchanged by the move to bytes: 48 000 characters are 48 000 bytes.
    expect(estimateTokens('a'.repeat(48_000))).toBe(12_000);
    // The measured corner. 48 000 CJK characters used to estimate at exactly the shipped 12 000
    // default budget; they are 144 000 bytes and now estimate at 36 000.
    expect(estimateTokens('日'.repeat(48_000))).toBe(36_000);
  });
});
