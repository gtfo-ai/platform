import * as nodeCrypto from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { credentialsMatch, parseBasicAuth } from './ops.js';

vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof nodeCrypto>();
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

describe('parseBasicAuth', () => {
  it('reads a well-formed credential', () => {
    const header = `Basic ${Buffer.from('prom:secret').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ user: 'prom', pass: 'secret' });
  });

  it('is case-insensitive about the scheme', () => {
    const header = `basic ${Buffer.from('a:b').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ user: 'a', pass: 'b' });
  });

  it('keeps colons inside the password', () => {
    const header = `Basic ${Buffer.from('user:pa:ss:word').toString('base64')}`;
    expect(parseBasicAuth(header)).toEqual({ user: 'user', pass: 'pa:ss:word' });
  });

  it('rejects anything that is not basic auth', () => {
    expect(parseBasicAuth(undefined)).toBeNull();
    expect(parseBasicAuth('Bearer token')).toBeNull();
    expect(parseBasicAuth(`Basic ${Buffer.from('no-colon').toString('base64')}`)).toBeNull();
  });
});

describe('credentialsMatch', () => {
  const expected = { user: 'prom', pass: 'a-fake-password' };

  it('accepts the right credential', async () => {
    await expect(credentialsMatch({ ...expected }, expected)).resolves.toBe(true);
  });

  it('rejects a wrong password, a wrong user, and a prefix of either', async () => {
    await expect(credentialsMatch({ user: 'prom', pass: 'wrong' }, expected)).resolves.toBe(false);
    await expect(credentialsMatch({ user: 'other', pass: expected.pass }, expected)).resolves.toBe(
      false,
    );
    // Digesting first is what makes the comparison constant-width, so a prefix cannot be detected
    // by timing or by an early length mismatch.
    await expect(
      credentialsMatch({ user: 'prom', pass: 'a-fake-passwor' }, expected),
    ).resolves.toBe(false);
    await expect(
      credentialsMatch({ user: 'prom', pass: 'a-fake-password-and-more' }, expected),
    ).resolves.toBe(false);
  });

  it('rejects an empty credential', async () => {
    await expect(credentialsMatch({ user: '', pass: '' }, expected)).resolves.toBe(false);
  });

  it('compares both halves even when the username is wrong', async () => {
    // `&&` short-circuits, so a wrong username used to skip the password comparison entirely and
    // answer measurably faster than a right username with a wrong password — which tells an
    // attacker when they have guessed the username and splits one search into two smaller ones.
    // Counting the comparisons is the deterministic way to assert this; a timing assertion would
    // be an assertion about the hardware.
    const spy = vi.mocked(nodeCrypto.timingSafeEqual);
    spy.mockClear();
    await credentialsMatch({ user: 'wrong', pass: 'also-wrong' }, expected);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
