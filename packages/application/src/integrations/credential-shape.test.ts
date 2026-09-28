/**
 * The minted-credential shape (WP-80, TD-012's M5 amendment): a non-secret description of a value
 * the platform minted, from which every process compiles a redaction rule. Every value here is an
 * obviously fake stand-in.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  hasMintedCredentialShape,
  MINTED_CREDENTIAL_CHARSETS,
  type MintedCredentialShape,
  mintedCredentialShapePattern,
  mintedCredentialShapeRecordSchema,
  mintedCredentialShapeSchema,
} from './credential-shape.js';

const VALUE = 'acmepat-FAKE0shaped0value0000';
const SHAPE: MintedCredentialShape = { prefix: 'acmepat-', charset: 'token', length: VALUE.length };

describe('a minted-credential shape', () => {
  it('matches the value it was declared for, exactly', () => {
    expect(hasMintedCredentialShape(SHAPE, VALUE)).toBe(true);
    expect(hasMintedCredentialShape(SHAPE, `${VALUE}0`)).toBe(false);
    expect(hasMintedCredentialShape(SHAPE, VALUE.slice(0, -1))).toBe(false);
    expect(hasMintedCredentialShape({ ...SHAPE, prefix: 'glpat-' }, VALUE)).toBe(false);
    expect(hasMintedCredentialShape({ ...SHAPE, charset: 'alnum' }, VALUE)).toBe(true);
    expect(
      hasMintedCredentialShape({ ...SHAPE, charset: 'alnum' }, 'acmepat-FAKE-shaped-value0000'),
    ).toBe(false);
  });

  it('finds the value inside text, and a regex metacharacter in the prefix is a literal', () => {
    const pattern = mintedCredentialShapePattern(SHAPE);
    expect(`https://agentic:${VALUE}@git.example.test`.match(pattern)).toEqual([VALUE]);
    const dotted: MintedCredentialShape = { prefix: 'a.b+c-', charset: 'alnum', length: 26 };
    const value = 'a.b+c-FAKE0000000000000000';
    expect(hasMintedCredentialShape(dotted, value)).toBe(true);
    expect(hasMintedCredentialShape(dotted, 'aXbbc-FAKE0000000000000000')).toBe(false);
  });

  it.each([
    ['a prefix too short to be specific', { prefix: 'ab', charset: 'alnum', length: 20 }],
    ['a prefix with whitespace', { prefix: 'acme pat-', charset: 'alnum', length: 20 }],
    [
      'a prefix with a character class opener',
      { prefix: 'acme[pat', charset: 'alnum', length: 20 },
    ],
    ['a charset outside the closed set', { prefix: 'acmepat-', charset: '.*', length: 20 }],
    ['a length below the minimum', { prefix: 'acmepat-', charset: 'alnum', length: 15 }],
    [
      'a length with no random part',
      { prefix: 'acmepat-FAKE0000000', charset: 'alnum', length: 19 },
    ],
    ['an unknown key', { prefix: 'acmepat-', charset: 'alnum', length: 20, sample: 'x' }],
  ])('refuses %s', (_case, shape) => {
    expect(mintedCredentialShapeSchema.safeParse(shape).success).toBe(false);
    expect(() => mintedCredentialShapePattern(shape as MintedCredentialShape)).toThrow();
    expect(hasMintedCredentialShape(shape as MintedCredentialShape, VALUE)).toBe(false);
  });

  it('records an expiry that is an instant, and nothing else', () => {
    expect(
      mintedCredentialShapeRecordSchema.safeParse({
        shape: SHAPE,
        expiresAt: '2026-09-30T00:00:00.000Z',
      }).success,
    ).toBe(true);
    expect(
      mintedCredentialShapeRecordSchema.safeParse({ shape: SHAPE, expiresAt: 'tomorrow' }).success,
    ).toBe(false);
  });

  /**
   * The property the amendment rests on: whatever value of a declared shape was minted, the rule
   * compiled from the shape finds all of it in any surrounding text, and the shape carries no
   * character of the value past the declared prefix.
   */
  it('finds every value of its shape in any text, and names none of its random part', () => {
    const charsets = Object.keys(
      MINTED_CREDENTIAL_CHARSETS,
    ) as (keyof typeof MINTED_CREDENTIAL_CHARSETS)[];
    const alphabet: Record<string, string> = {
      alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
      token: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-',
      token_dotted: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_.-',
    };
    fc.assert(
      fc.property(
        fc.constantFrom(...charsets),
        fc.integer({ min: 16, max: 60 }),
        fc.string({ unit: fc.constantFrom(' ', ':', '@', '/', '"', '\n'), maxLength: 5 }),
        fc.string({ unit: fc.constantFrom(' ', ':', '@', '/', '"', '\n'), maxLength: 5 }),
        fc.integer(),
        (charset, tail, before, after, seed) => {
          const letters = alphabet[charset] as string;
          let random = '';
          for (let index = 0; index < tail; index += 1) {
            random += letters[Math.abs(seed * 31 + index * 17) % letters.length];
          }
          const value = `fakepat_${random}`;
          const shape: MintedCredentialShape = {
            prefix: 'fakepat_',
            charset,
            length: value.length,
          };
          expect(hasMintedCredentialShape(shape, value)).toBe(true);
          expect(`${before}${value}${after}`.match(mintedCredentialShapePattern(shape))).toEqual([
            value,
          ]);
          expect(JSON.stringify(shape)).not.toContain(random);
        },
      ),
    );
  });
});
