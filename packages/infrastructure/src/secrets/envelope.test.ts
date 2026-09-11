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
  rewrapSecret,
  SEALED_ENVELOPE_LAYOUT,
  SECRET_ENVELOPE_VERSION,
  SecretEnvelopeError,
  sealSecret,
} from './envelope.js';

const KEY = 'not-a-real-app-secret-key-000000000000';
const OTHER_KEY = 'also-not-a-real-app-secret-key-11111111';
const ROW = '00000000-0000-4000-8000-00000000e001';
const OTHER_ROW = '00000000-0000-4000-8000-00000000e002';

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
      expect(openSecret(key, sealSecret(key, plaintext, ROW), ROW)).toBe(plaintext);
    }
  });

  it('is different every time, so two rows holding one credential do not look alike', () => {
    const key = deriveSecretKey(KEY);
    const left = sealSecret(key, 'glpat-FAKE-not-a-real-token', ROW);
    const right = sealSecret(key, 'glpat-FAKE-not-a-real-token', ROW);
    expect(left.equals(right)).toBe(false);
  });

  it('refuses to open under another platform key, naming the key id to check', () => {
    const sealed = sealSecret(deriveSecretKey(KEY), 'glpat-FAKE-not-a-real-token', ROW);
    expect(() => openSecret(deriveSecretKey(OTHER_KEY), sealed, ROW)).toThrow(
      /does not authenticate/,
    );
  });

  it('refuses a tampered body', () => {
    const key = deriveSecretKey(KEY);
    const sealed = sealSecret(key, 'glpat-FAKE-not-a-real-token', ROW);
    sealed.writeUInt8(sealed.readUInt8(sealed.length - 1) ^ 0xff, sealed.length - 1);
    expect(() => openSecret(key, sealed, ROW)).toThrow(SecretEnvelopeError);
  });

  /**
   * The discriminating negative: take one row's header (its wrapped data key) and another row's
   * body. Without the body's AAD binding it to that wrapped key, this is the shape that hands a
   * caller the wrong credential while every tag still verifies.
   */
  it('refuses a body spliced onto another row’s header', () => {
    const key = deriveSecretKey(KEY);
    const left = sealSecret(key, 'glpat-FAKE-left-not-a-real-token', ROW);
    const right = sealSecret(key, 'glpat-FAKE-right-not-a-real-token', ROW);
    const header = 1 + 12 + 16 + 32;
    const spliced = Buffer.concat([left.subarray(0, header), right.subarray(header)]);
    expect(() => openSecret(key, spliced, ROW)).toThrow(SecretEnvelopeError);
  });

  /**
   * Review round 1's minor, and a database-write attack the splice test could not see: it only
   * ever cut an envelope in half, while the cheap attack is to copy a **whole** envelope from one
   * `secrets` row into another and let a binding resolve someone else's credential. The row's own
   * uuid is in the wrap's AAD, so it does not open under a different id.
   *
   * Removing `secretId` from `wrapAad` kills this test by name and nothing else in this file.
   */
  it('refuses an envelope transplanted into another secrets row', () => {
    const key = deriveSecretKey(KEY);
    const sealed = sealSecret(key, 'glpat-FAKE-not-a-real-token', ROW);
    expect(openSecret(key, sealed, ROW)).toBe('glpat-FAKE-not-a-real-token');
    expect(() => openSecret(key, sealed, OTHER_ROW)).toThrow(
      /belongs to another secrets row, or was sealed under another key/,
    );
  });

  /**
   * The nonces — and the second version of this test, because the first one admitted a counter.
   *
   * Round 2 pinned *distinctness* over 64 seals. Standing rule 43 asks which **wrong**
   * implementations a negative also passes, and the answer was a bad one: a per-process counter
   * (`iv.writeUInt32BE(n)`) produced 64 distinct values and passed all 13 tests. Distinctness within
   * one process is not what the docblock claims — it claims no two rows share a nonce under one
   * KEK, and two replicas each counting from 1 collide on every row.
   *
   * **What a unit test can and cannot do here, stated rather than implied** (standing rule 44). It
   * cannot establish unpredictability: entropy is a property of the generator, and the guarantee
   * comes from `node:crypto`'s `randomBytes`, which is a CSPRNG seeded by the OS. What it *can* do
   * is reject a **structured** generator, and that is what kills every counter shape: a counter
   * leaves most byte positions constant for ever, wherever in the 12 bytes it is placed. So the
   * census below asserts that **every byte position varies**, which no counter satisfies and which
   * `randomBytes` satisfies with a false-failure probability under 12 × 256 × 256^-255.
   *
   * The third random value, the data key, is covered by the body: with a fixed DEK and a fixed body
   * IV, two seals of one plaintext produce identical bodies.
   */
  it('gives every seal an unstructured nonce, so no counter or constant can pass for one', () => {
    const key = deriveSecretKey(KEY);
    const census = 256;
    const seals = Array.from({ length: census }, () =>
      // One plaintext and one row id throughout: everything that differs below is a nonce.
      sealSecret(key, 'glpat-FAKE-not-a-real-token', ROW),
    );

    const field = (sealed: Buffer, name: 'wrapIv' | 'bodyIv'): Buffer =>
      sealed.subarray(
        SEALED_ENVELOPE_LAYOUT[name].offset,
        SEALED_ENVELOPE_LAYOUT[name].offset + SEALED_ENVELOPE_LAYOUT[name].bytes,
      );

    for (const name of ['wrapIv', 'bodyIv'] as const) {
      const values = seals.map((sealed) => field(sealed, name));
      // Distinctness: no nonce is reused inside this process.
      expect(new Set(values.map((value) => value.toString('hex'))).size).toBe(census);
      // Structure: a counter — at any offset, of any width — pins the positions it does not reach.
      const constantPositions = [...Array(SEALED_ENVELOPE_LAYOUT[name].bytes).keys()].filter(
        (position) => new Set(values.map((value) => value[position])).size === 1,
      );
      expect({ nonce: name, constantPositions }).toEqual({ nonce: name, constantPositions: [] });
    }

    // And the bodies differ, which is the data key's own randomness: same plaintext, same row.
    const bodyStart = SEALED_ENVELOPE_LAYOUT.bodyTag.offset + SEALED_ENVELOPE_LAYOUT.bodyTag.bytes;
    expect(new Set(seals.map((sealed) => sealed.subarray(bodyStart).toString('hex'))).size).toBe(
      census,
    );
  });

  /**
   * The procedure the module docblock promises, as a test rather than a paragraph (rule 30).
   *
   * Until round 3 this threw: the body's AAD was the wrapped data key, so a rewrapped row no longer
   * authenticated and "rotating rewraps 32 bytes per row" was a documented procedure that did not
   * work. The assertion that matters is the last one — the **body bytes are untouched**, which is
   * the whole claim: the credential never exists in plaintext in a process that is rotating keys.
   */
  it('rotates the platform key by rewrapping the data key, without touching the credential', () => {
    const oldKey = deriveSecretKey(KEY);
    const newKey = deriveSecretKey(OTHER_KEY);
    const sealed = sealSecret(oldKey, 'glpat-FAKE-not-a-real-token', ROW);

    const rotated = rewrapSecret(oldKey, newKey, sealed, ROW);

    expect(openSecret(newKey, rotated, ROW)).toBe('glpat-FAKE-not-a-real-token');
    // The old key no longer opens it, which is what makes the rotation a rotation.
    expect(() => openSecret(oldKey, rotated, ROW)).toThrow(SecretEnvelopeError);
    // Still bound to its row.
    expect(() => openSecret(newKey, rotated, OTHER_ROW)).toThrow(SecretEnvelopeError);
    // The body — IV, tag and ciphertext — is copied through byte for byte.
    const from = SEALED_ENVELOPE_LAYOUT.bodyIv.offset;
    expect(rotated.subarray(from).equals(sealed.subarray(from))).toBe(true);
  });

  it('refuses to rotate a row that does not authenticate under the key it is leaving', () => {
    const oldKey = deriveSecretKey(KEY);
    const newKey = deriveSecretKey(OTHER_KEY);
    const sealed = sealSecret(oldKey, 'glpat-FAKE-not-a-real-token', ROW);
    expect(() => rewrapSecret(newKey, oldKey, sealed, ROW)).toThrow(
      /does not authenticate for this row under the key it is being rotated from/,
    );
    expect(() => rewrapSecret(oldKey, newKey, sealed, OTHER_ROW)).toThrow(SecretEnvelopeError);
  });

  it('refuses a row shorter than the header instead of reading past the end', () => {
    const key = deriveSecretKey(KEY);
    expect(() => openSecret(key, Buffer.alloc(10), ROW)).toThrow(/the header alone is/);
  });

  it('refuses a format version it does not read, rather than guessing the layout', () => {
    const key = deriveSecretKey(KEY);
    const sealed = sealSecret(key, 'glpat-FAKE-not-a-real-token', ROW);
    sealed[0] = SECRET_ENVELOPE_VERSION + 7;
    expect(() => openSecret(key, sealed, ROW)).toThrow(/format version 8; this build reads 1/);
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
