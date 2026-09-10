/**
 * Credential arithmetic and the `cloneUrl` refusal the port makes an adapter obligation.
 *
 * The expiry tests are the ones worth reading twice. GitLab's `expires_at` is a **date** and
 * "Personal, group, and project access tokens expire at midnight UTC on the expiry date", so a
 * TTL in seconds cannot be honoured exactly. Rounding the wrong way hands back a credential that
 * dies inside the window the caller asked for; reporting `now + ttl` instead of the granted
 * instant tells the workspace manager and the audit a lifetime the provider never enforced.
 */
import { IntegrationError, type MintedCredential } from '@platform/application';
import { describe, expect, it } from 'vitest';
import {
  buildCloneUrl,
  createMintedCredentialRegistry,
  expiryForTtl,
  formatRevokeId,
  parseRevokeId,
  type RevocationAddress,
  scopesFor,
} from './credentials.js';

const credential = (overrides: Partial<MintedCredential> = {}): MintedCredential => ({
  username: 'oauth2',
  value: 'FAKE-project-access-token-DO-NOT-USE',
  scope: 'push',
  branchPatterns: ['agentic/*'],
  expiresAt: '2026-06-02T00:00:00.000Z',
  revokeId: 'acme/api#58',
  ...overrides,
});

const ADDRESS: RevocationAddress = { project: 'acme/api', tokenId: 58 };

describe('scopesFor', () => {
  it('asks for read_repository to pull and adds write_repository to push', () => {
    expect(scopesFor('read')).toEqual(['read_repository']);
    expect(scopesFor('push')).toEqual(['read_repository', 'write_repository']);
  });

  it('never asks for the api scope, which would let a workspace token call the API', () => {
    expect(scopesFor('push')).not.toContain('api');
    expect(scopesFor('read')).not.toContain('api');
  });
});

describe('expiryForTtl', () => {
  it('rounds up to the next midnight UTC, never down', () => {
    const result = expiryForTtl('2026-06-01T08:00:00.000Z', 3600);
    expect(result.date, 'GitLab takes a YYYY-MM-DD date').toBe('2026-06-02');
    expect(result.expiresAt, 'the reported instant is when GitLab stops honouring the token').toBe(
      '2026-06-02T00:00:00.000Z',
    );
  });

  it('covers a TTL that crosses midnight by granting the day after it', () => {
    // 23:30 + 1h lands at 00:30 on the 2nd, and a token dated the 2nd is already dead by then —
    // so the 3rd is the first date that covers the window. Rounding to the day the TTL *ends on*
    // would hand back an already-expired credential, which is the direction that matters.
    const result = expiryForTtl('2026-06-01T23:30:00.000Z', 3600);
    expect(result.date).toBe('2026-06-03');
    expect(Date.parse(result.expiresAt)).toBeGreaterThanOrEqual(
      Date.parse('2026-06-02T00:30:00.000Z'),
    );
  });

  it('never grants an expiry earlier than now + ttl', () => {
    for (const ttl of [1, 60, 3600, 86_400, 604_800]) {
      for (const at of [
        '2026-06-01T00:00:00.000Z',
        '2026-06-01T08:00:00.000Z',
        '2026-06-01T23:59:59.000Z',
      ]) {
        const result = expiryForTtl(at, ttl);
        expect(
          Date.parse(result.expiresAt),
          `ttl ${ttl}s from ${at} must not expire early`,
        ).toBeGreaterThanOrEqual(Date.parse(at) + ttl * 1000);
      }
    }
  });

  it('reports the granted instant, not now + ttl', () => {
    // The whole divergence in one assertion: an hour was asked for, a day and a bit was granted,
    // and the credential says so.
    const result = expiryForTtl('2026-06-01T08:00:00.000Z', 3600);
    expect(result.expiresAt).not.toBe('2026-06-01T09:00:00.000Z');
    expect(Date.parse(result.expiresAt) - Date.parse('2026-06-01T08:00:00.000Z')).toBe(
      16 * 3600 * 1000,
    );
  });

  it('refuses a clock that returns no instant', () => {
    expect(() => expiryForTtl('never', 60)).toThrow(IntegrationError);
  });
});

describe('buildCloneUrl', () => {
  it('embeds the credential as the password with a non-blank username', () => {
    // "You can use a project access token to authenticate … With Git over HTTPS. Use: Any
    // non-blank value as a username. The project access token as the password."
    const url = buildCloneUrl('https://gitlab.example.test', 'acme/api', credential());
    expect(url).toBe(
      'https://oauth2:FAKE-project-access-token-DO-NOT-USE@gitlab.example.test/acme/api.git',
    );
  });

  it('works on a self-managed instance served from a sub-path', () => {
    const url = buildCloneUrl('https://code.example.test/gitlab', 'acme/api', credential());
    expect(url).toBe(
      'https://oauth2:FAKE-project-access-token-DO-NOT-USE@code.example.test/gitlab/acme/api.git',
    );
  });

  it('percent-encodes a credential that contains URL syntax', () => {
    const url = buildCloneUrl(
      'https://gitlab.example.test',
      'acme/api',
      credential({ value: 'FAKE/token:with@syntax' }),
    );
    expect(url).toContain('FAKE%2Ftoken%3Awith%40syntax');
    expect(new URL(url).hostname, 'the host is still the host').toBe('gitlab.example.test');
  });
});

describe('the minted-credential registry (the cloneUrl obligation)', () => {
  const at = '2026-06-01T08:00:00.000Z';

  it('accepts a credential it minted', () => {
    const registry = createMintedCredentialRegistry();
    registry.remember(credential(), ADDRESS);
    expect(() => registry.assertUsable(credential(), at)).not.toThrow();
  });

  // Mutation: drop the `revoked` check, and this fails with its own message.
  it('refuses a revoked credential', () => {
    const registry = createMintedCredentialRegistry();
    registry.remember(credential(), ADDRESS);
    registry.markRevoked('acme/api#58');
    expect(() => registry.assertUsable(credential(), at)).toThrow(/revoked/);
  });

  // Mutation: drop the expiry comparison, and this fails.
  it('refuses an expired credential', () => {
    const registry = createMintedCredentialRegistry();
    registry.remember(credential({ expiresAt: '2026-06-01T07:00:00.000Z' }), ADDRESS);
    expect(() =>
      registry.assertUsable(credential({ expiresAt: '2026-06-01T07:00:00.000Z' }), at),
    ).toThrow(/expired/);
  });

  it('refuses a credential it never minted', () => {
    const registry = createMintedCredentialRegistry();
    expect(() => registry.assertUsable(credential(), at)).toThrow(/not minted by this provider/);
  });

  it('refuses a credential with no revocation handle', () => {
    const registry = createMintedCredentialRegistry();
    expect(() => registry.assertUsable(credential({ revokeId: null }), at)).toThrow(
      /no revocation handle/,
    );
  });

  it('reports invalid_request, which is the code the port documents', () => {
    const registry = createMintedCredentialRegistry();
    registry.remember(credential(), ADDRESS);
    registry.markRevoked('acme/api#58');
    try {
      registry.assertUsable(credential(), at);
      expect.unreachable('a revoked credential must be refused');
    } catch (error) {
      expect((error as IntegrationError).code).toBe('invalid_request');
      expect((error as IntegrationError).action).toBe('clone_url');
    }
  });

  /**
   * The round 1 major, in the registry that now answers it: a credential minted on one project
   * must be revoked on that project, and the handle is what says which one.
   */
  it('remembers the project a handle was minted on, not the one somebody asks about', () => {
    const registry = createMintedCredentialRegistry();
    registry.remember(credential({ revokeId: 'other/repo#58' }), {
      project: 'other/repo',
      tokenId: 58,
    });
    expect(
      registry.addressFor('other/repo#58'),
      'the revocation address is the project the token was minted on',
    ).toEqual({ project: 'other/repo', tokenId: 58 });
    expect(
      registry.addressFor('acme/api#58'),
      'and a handle it never minted has no address here, however familiar the token id looks',
    ).toBeNull();
  });

  it('reports a handle it has revoked, so a second teardown needs no round trip', () => {
    const registry = createMintedCredentialRegistry();
    registry.remember(credential(), ADDRESS);
    expect(registry.isRevoked('acme/api#58')).toBe(false);
    registry.markRevoked('acme/api#58');
    expect(registry.isRevoked('acme/api#58'), 'the no-op is a fact, not a 404').toBe(true);
  });

  it('never stores the secret value under its own name', () => {
    const registry = createMintedCredentialRegistry();
    registry.remember(credential(), ADDRESS);
    expect(
      JSON.stringify(registry),
      'the registry keys on the revocation handle, not on the token',
    ).not.toContain('FAKE-project-access-token-DO-NOT-USE');
  });
});

describe('the revocation address carried by a handle', () => {
  it('round-trips the project and the token id', () => {
    const address: RevocationAddress = { project: 'acme/api', tokenId: 58 };
    expect(formatRevokeId(address)).toBe('acme/api#58');
    expect(parseRevokeId(formatRevokeId(address))).toEqual(address);
  });

  it('survives a nested namespace, which is where a token id alone is least sufficient', () => {
    const address: RevocationAddress = { project: 'acme/team/sub/api', tokenId: 7 };
    expect(parseRevokeId(formatRevokeId(address))).toEqual(address);
  });

  /**
   * The separator is the **last** `#`, and that is a property of this parser rather than of
   * GitLab's path grammar.
   *
   * Changing `lastIndexOf` to `indexOf` survived all 356 tests at review round 2: harmless today,
   * because `#` cannot occur in a GitLab project path, but the whole point of `formatRevokeId` /
   * `parseRevokeId` is that they are inverses of each other, and the next provider to reuse the
   * shape may allow the character. Pin the parser to the formatter, not to a vendor's grammar.
   */
  it('cuts at the last separator, so any project a handle can carry round-trips', () => {
    const address: RevocationAddress = { project: 'a#b#c', tokenId: 1 };
    expect(formatRevokeId(address)).toBe('a#b#c#1');
    expect(
      parseRevokeId('a#b#c#1'),
      'the first "#" is part of the project; only the last one separates',
    ).toEqual(address);
    expect(parseRevokeId(formatRevokeId({ project: '#', tokenId: 3 }))).toEqual({
      project: '#',
      tokenId: 3,
    });
  });

  it('refuses a handle that is not an address', () => {
    // A bare token id is exactly the round 1 shape: it says what to delete and not where.
    expect(parseRevokeId('58'), 'a bare token id names no project').toBeNull();
    expect(parseRevokeId('acme/api#'), 'and an empty id is not an id').toBeNull();
    expect(parseRevokeId('#58'), 'nor is an empty project a project').toBeNull();
    expect(parseRevokeId('acme/api#0x3a'), 'GitLab token ids are decimal').toBeNull();
    expect(parseRevokeId('acme/api#-1')).toBeNull();
  });
});
