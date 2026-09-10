import { describe, expect, it } from 'vitest';
import { MIN_RUN_TOKEN_LENGTH, RunletTokenError, tokensMatch, validateRunToken } from './token.js';

const GOOD = 'run-token-0000000000000000000000';

describe('the run token (standing rule 18: an empty credential is not a credential)', () => {
  describe('validateRunToken refuses rather than defaults', () => {
    it.each([
      ['absent', undefined],
      ['null', null],
      ['a number', 123456789012345],
      ['empty', ''],
      ['a single space', ' '],
      ['only whitespace', '   \t\n  '],
      // Long enough to pass the length check on its own: without the blank check this one is
      // accepted, and a shim listening with a token of spaces is standing rule 18 again.
      ['whitespace longer than the minimum length', ' '.repeat(MIN_RUN_TOKEN_LENGTH + 8)],
      ['too short', 'x'.repeat(MIN_RUN_TOKEN_LENGTH - 1)],
    ])('refuses %s', (_name, value) => {
      expect(() => validateRunToken(value)).toThrow(RunletTokenError);
    });

    it('accepts a token of the minimum length', () => {
      expect(validateRunToken('x'.repeat(MIN_RUN_TOKEN_LENGTH))).toHaveLength(MIN_RUN_TOKEN_LENGTH);
    });
  });

  describe('tokensMatch', () => {
    it('matches the same token', () => {
      expect(tokensMatch(GOOD, GOOD)).toBe(true);
    });

    it('refuses an empty presented token even against an empty expected one', () => {
      // `validateRunToken` makes the second case unreachable in the shim; it is asserted anyway,
      // because a comparison that answers `true` to `('', '')` is the WP-08 defect exactly.
      expect(tokensMatch(GOOD, '')).toBe(false);
      expect(tokensMatch('', '')).toBe(false);
    });

    it('refuses a non-string, a prefix and a superstring', () => {
      expect(tokensMatch(GOOD, undefined)).toBe(false);
      expect(tokensMatch(GOOD, { toString: () => GOOD })).toBe(false);
      expect(tokensMatch(GOOD, GOOD.slice(0, -1))).toBe(false);
      expect(tokensMatch(GOOD, `${GOOD}x`)).toBe(false);
    });

    it('compares a different-length token without throwing (the length would be an oracle)', () => {
      expect(() => tokensMatch(GOOD, 'short')).not.toThrow();
      expect(tokensMatch(GOOD, 'short')).toBe(false);
    });
  });
});
