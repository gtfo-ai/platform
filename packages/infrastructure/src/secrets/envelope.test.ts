/**
 * The sealed format, held to the four ways it can be wrong.
 *
 * Every negative here is one an *attacker with database access* can attempt — that is the threat
 * this format exists for, since `secrets.ciphertext` is a column a backup, a replica and a support
 * dump all carry. "It decrypts" is not the property; "it decrypts **only** the document that was
 * written, under **this** key" is, so each test mutates one part and asserts the refusal.
 *
 * Standing rule 43: a negative case every candidate implementation would reject proves nothing. The
 * splice test is the one that discriminates — a format that authenticated each half separately,
 * without binding the body to its own wrapped key, would pass every other test in this file and
 * hand back another row's credential.
 */
import { describe, expect, it } from 'vitest';
import {
  deriveSecretKey,
  isSealedUnder,
  openSecret,
  SECRET_ENVELOPE_VERSION,
  SecretEnvelopeError,
  sealSecret,
} from './envelope.js';

const KEY = 'not-a-real-app-secret-key-000000000000';
const OTHER_KEY = 'also-not-a-real-app-secret-key-11111111';

describe('deriveSecretKey', () => {
  it('is deterministic, and the key id changes with the platform key', () => {
    const first = deriveSecretKey(KEY);
    expect(deriveSecretKey(KEY).keyId).toBe(first.keyId);
    expect(deriveSecretKey(OTHER_KEY).keyId).not.toBe(first.keyId);
    expect(first.keyId).toMatch(/^v1:[0-9a-f]{16}$/);
  });

  it('refuses a platform key too short to derive from, rather than deriving a weak one', () => {
    expect(() => deriveSecretKey('short')).toThrow(SecretEnvelopeError);
  });

  it('does not put the platform key in the key id', () => {
    expect(deriveSecretKey(KEY).keyId).not.toContain(KEY.slice(0, 12));
  });
});

describe('a sealed secret', () => {
  it('round-trips, including an empty value and one with newlines', () => {
    const key = deriveSecretKey(KEY);
    for (const plaintext of ['', 'glpat-FAKE-not-a-real-token', 'line\nline\n', '🙂 unicode']) {
      expect(openSecret(key, sealSecret(key, plaintext))).toBe(plaintext);
    }
  });

  it('is different every time, so two rows holding one credential do not look alike', () => {
    const key = deriveSecretKey(KEY);
    const left = sealSecret(key, 'glpat-FAKE-not-a-real-token');
    const right = sealSecret(key, 'glpat-FAKE-not-a-real-token');
    expect(left.equals(right)).toBe(false);
  });

  it('refuses to open under another platform key, naming the key id to check', () => {
    const sealed = sealSecret(deriveSecretKey(KEY), 'glpat-FAKE-not-a-real-token');
    expect(() => openSecret(deriveSecretKey(OTHER_KEY), sealed)).toThrow(/does not authenticate/);
  });

  it('refuses a tampered body', () => {
    const key = deriveSecretKey(KEY);
    const sealed = sealSecret(key, 'glpat-FAKE-not-a-real-token');
    sealed.writeUInt8(sealed.readUInt8(sealed.length - 1) ^ 0xff, sealed.length - 1);
    expect(() => openSecret(key, sealed)).toThrow(SecretEnvelopeError);
  });

  /**
   * The discriminating negative: take one row's header (its wrapped data key) and another row's
   * body. Without the body's AAD binding it to that wrapped key, this is the shape that hands a
   * caller the wrong credential while every tag still verifies.
   */
  it('refuses a body spliced onto another row’s header', () => {
    const key = deriveSecretKey(KEY);
    const left = sealSecret(key, 'glpat-FAKE-left-not-a-real-token');
    const right = sealSecret(key, 'glpat-FAKE-right-not-a-real-token');
    const header = 1 + 12 + 16 + 32;
    const spliced = Buffer.concat([left.subarray(0, header), right.subarray(header)]);
    expect(() => openSecret(key, spliced)).toThrow(SecretEnvelopeError);
  });

  it('refuses a row shorter than the header instead of reading past the end', () => {
    const key = deriveSecretKey(KEY);
    expect(() => openSecret(key, Buffer.alloc(10))).toThrow(/the header alone is/);
  });

  it('refuses a format version it does not read, rather than guessing the layout', () => {
    const key = deriveSecretKey(KEY);
    const sealed = sealSecret(key, 'glpat-FAKE-not-a-real-token');
    sealed[0] = SECRET_ENVELOPE_VERSION + 7;
    expect(() => openSecret(key, sealed)).toThrow(/format version 8; this build reads 1/);
  });
});

describe('isSealedUnder', () => {
  it('answers for this process’s key and for nothing else', () => {
    const key = deriveSecretKey(KEY);
    expect(isSealedUnder(key, key.keyId)).toBe(true);
    expect(isSealedUnder(key, deriveSecretKey(OTHER_KEY).keyId)).toBe(false);
    // Length differs: `timingSafeEqual` throws on unequal lengths, so the guard has to answer first.
    expect(isSealedUnder(key, '')).toBe(false);
    expect(isSealedUnder(key, `${key.keyId}x`)).toBe(false);
  });
});
