import { describe, expect, it } from 'vitest';
import {
  generateInviteToken,
  hashInviteToken,
  INVITE_TOKEN_BYTES,
  inviteUrl,
} from './invite-token.js';

describe('the invite token', () => {
  it('is 32 bytes as 43 base64url characters, without padding', () => {
    const token = generateInviteToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(INVITE_TOKEN_BYTES);
  });

  it('draws fresh bytes each time', () => {
    expect(generateInviteToken()).not.toBe(generateInviteToken());
  });

  it('refuses a random source that answers short', () => {
    expect(() => generateInviteToken(() => new Uint8Array(31))).toThrow(/31 bytes/);
  });

  it('is stored as the SHA-256 of its text, 64 hex characters, never the token itself', () => {
    const token = generateInviteToken(() => new Uint8Array(32).fill(7));
    const hash = hashInviteToken(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain(token);
    // A known vector: SHA-256 of the empty string.
    expect(hashInviteToken('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('puts the token in the fragment of the instance’s origin', () => {
    expect(inviteUrl('https://agentic.example.test/some/path/', 'abc_-1')).toBe(
      'https://agentic.example.test/invite#abc_-1',
    );
    expect(inviteUrl('http://localhost:8080', 'x')).toBe('http://localhost:8080/invite#x');
  });
});
