import { workerCredentialSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  formatWorkerCredential,
  parseWorkerCredential,
  workerIdFromBase32,
  workerIdToBase32,
} from './credential.js';

/** An obviously fake secret half: 43 base64url characters nobody issued. */
const FAKE_SECRET = `FAKE-${'x'.repeat(38)}`;

describe('the worker credential', () => {
  it('round-trips every uuid through 26 base32 characters', () => {
    fc.assert(
      fc.property(fc.uuid(), (uuid) => {
        const encoded = workerIdToBase32(uuid);
        expect(encoded).toMatch(/^[a-z2-7]{26}$/);
        expect(workerIdFromBase32(encoded)).toBe(uuid.toLowerCase());
      }),
    );
  });

  it('pins the encoding on known values', () => {
    expect(workerIdToBase32('00000000-0000-0000-0000-000000000000')).toBe('a'.repeat(26));
    expect(workerIdToBase32('ffffffff-ffff-ffff-ffff-ffffffffffff')).toBe(`${'7'.repeat(25)}4`);
  });

  it('refuses a non-canonical spelling whose padding bits are set, and a foreign character', () => {
    expect(workerIdFromBase32(`${'a'.repeat(25)}b`)).toBeNull();
    expect(workerIdFromBase32(`${'a'.repeat(25)}1`)).toBeNull();
    expect(workerIdFromBase32('a'.repeat(25))).toBeNull();
  });

  it('formats a credential the contract accepts and parses it back to its worker', () => {
    const id = '0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f506';
    const credential = formatWorkerCredential(id, FAKE_SECRET);
    expect(credential.startsWith('wkr_')).toBe(true);
    expect(workerCredentialSchema.safeParse(credential).success).toBe(true);
    expect(parseWorkerCredential(credential)).toEqual({ workerId: id });
  });

  it('refuses to format a secret that is not 43 base64url characters', () => {
    expect(() => formatWorkerCredential('0192f3a4-5b6c-7d8e-9fa0-b1c2d3e4f506', 'short')).toThrow();
    expect(() => formatWorkerCredential('not-a-uuid', FAKE_SECRET)).toThrow();
  });

  it('parses nothing that is not a credential', () => {
    expect(parseWorkerCredential('')).toBeNull();
    expect(parseWorkerCredential(`wkr_${'a'.repeat(25)}b_${FAKE_SECRET}`)).toBeNull();
    expect(parseWorkerCredential(`Bearer wkr_${'a'.repeat(26)}_${FAKE_SECRET}`)).toBeNull();
  });
});
