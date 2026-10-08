import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import { sha256Hex } from './sha256.js';

const reference = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    [
      'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq',
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    ],
  ])('matches the FIPS 180-4 vector for %j', (text, digest) => {
    expect(sha256Hex(text)).toBe(digest);
  });

  it('matches node:crypto across the padding boundaries', () => {
    for (const length of [55, 56, 63, 64, 65, 119, 120, 1000]) {
      const text = 'x'.repeat(length);
      expect(sha256Hex(text)).toBe(reference(text));
    }
  });

  it(
    'matches node:crypto for any string, non-ASCII and lone surrogates included (property)',
    () => {
      fc.assert(
        fc.property(fc.oneof(fc.string(), fc.string({ unit: 'binary' })), (text) => {
          expect(sha256Hex(text)).toBe(reference(text));
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
