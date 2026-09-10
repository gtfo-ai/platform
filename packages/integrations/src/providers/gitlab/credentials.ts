/**
 * Minting, revoking and using a short-lived GitLab credential (BD-025).
 *
 * Sources, retrieved 2026-09-10:
 *  - <https://docs.gitlab.com/api/project_access_tokens/> — create (`POST projects/:id/access_tokens`,
 *    `expires_at` is "Expiration date of the token in ISO format (`YYYY-MM-DD`)") and revoke
 *    (`DELETE projects/:id/access_tokens/:token_id`, "returns `204 No content`", "`404: Not Found`
 *    if the access token does not exist").
 *  - <https://docs.gitlab.com/security/tokens/access_token_scopes/> — `read_repository` grants pull
 *    over Git-over-HTTP, `write_repository` grants pull and push and "Does not support API
 *    authentication".
 *  - <https://docs.gitlab.com/user/profile/personal_access_tokens/#access-token-expiration> —
 *    "Personal, group, and project access tokens expire at **midnight UTC on the expiry date**."
 *  - <https://docs.gitlab.com/user/project/settings/project_access_tokens/> — "You can use a project
 *    access token to authenticate … With Git over HTTPS. Use: Any non-blank value as a username.
 *    The project access token as the password." And: "On GitLab.com, project access tokens require
 *    a Premium or Ultimate subscription."
 *
 * ## Two places this adapter is *not* what the port's wording suggests
 *
 * Both are written here rather than left for a green suite to imply (standing rule 1's dual).
 *
 *  1. **`ttlSeconds` is granted in whole days.** GitLab's `expires_at` is a date, and the token
 *     dies at midnight UTC on it. A 3600-second request therefore buys somewhere between one and
 *     two days of validity. `MintedCredential.expiresAt` reports the instant GitLab will actually
 *     stop honouring the token — `T00:00:00.000Z` of the granted date — and never `now + ttl`,
 *     because a workspace manager that believed the shorter figure would tear down a credential
 *     that is still live, and an auditor reading the row would believe a lifetime the provider
 *     never enforced.
 *  2. **`branchPatterns` is not enforced by GitLab.** A project access token has scopes and a role;
 *     it has no branch scoping, so `push:agentic/*` is a platform-side constraint carried on the
 *     credential for the workspace manager and the audit, not a limit the provider applies. What
 *     does keep the token off `main` is the *protected branch* configuration, which is why this
 *     provider also exposes `isBranchProtected` (see `provider.ts`) and why the setup guide makes
 *     protecting the default branch a prerequisite rather than a suggestion. Filed as Q40.
 *
 * ## A minted credential carries its own revocation address
 *
 * A GitLab access token is deleted at `DELETE /projects/:id/access_tokens/:token_id`, so a token
 * id alone does not say where the token lives. `mintCredential` mints against the project the
 * *request* names, which is not always the project the binding names — so a `revokeId` that held
 * only the token id left `revokeCredential` guessing, and a `DELETE` sent to the wrong project
 * answers `404`, which the "already gone" absorption then swallowed: the caller was told the
 * credential was revoked while the token stayed live until midnight UTC (WP-09 review round 1).
 *
 * `revokeId` is therefore the whole address — `<project>#<token_id>` — and the registry stores the
 * same address beside it. The encoded form is what survives a restart, a serialisation round trip
 * or a second process; the registry is what says whether *this* provider minted it, which is the
 * only evidence that separates "already revoked" from "never existed here" when GitLab answers
 * `404` (see `provider.ts` `revokeCredential`).
 */
import {
  type CredentialScope,
  IntegrationError,
  type MintedCredential,
} from '@platform/application';
import { GITLAB_PROVIDER_ID } from './http.js';

/** GitLab's own scope names for the two things a workspace needs. */
export const scopesFor = (scope: CredentialScope): string[] =>
  scope === 'push' ? ['read_repository', 'write_repository'] : ['read_repository'];

const MS_PER_DAY = 86_400_000;

/**
 * The earliest `expires_at` date that still covers `ttlSeconds`, and the instant it expires.
 *
 * Rounds **up**: a date whose midnight falls before `now + ttl` would hand back a credential that
 * dies inside the window the caller asked for.
 */
export const expiryForTtl = (
  nowIso: string,
  ttlSeconds: number,
): { readonly date: string; readonly expiresAt: string } => {
  const now = Date.parse(nowIso);
  if (Number.isNaN(now)) {
    throw new IntegrationError('invalid_request', GITLAB_PROVIDER_ID, 'clock returned no instant', {
      action: 'mint_credential',
    });
  }
  const wanted = now + ttlSeconds * 1000;
  const midnightAfterWanted = Math.ceil(wanted / MS_PER_DAY) * MS_PER_DAY;
  // `Math.ceil` returns `wanted` itself when it is exactly midnight, which is still >= wanted.
  const expiresAt = new Date(midnightAfterWanted).toISOString();
  return { date: expiresAt.slice(0, 10), expiresAt };
};

/**
 * Builds the clone URL, embedding the credential.
 *
 * The username is documented as "any non-blank value"; `oauth2` is the conventional one and is
 * what the git credential helper will send. The result is secret-bearing: it is returned to the
 * workspace manager and never logged, stored or audited (BD-025).
 */
export const buildCloneUrl = (
  baseUrl: string,
  project: string,
  credential: MintedCredential,
): string => {
  const url = new URL(baseUrl);
  url.username = encodeURIComponent(credential.username ?? 'oauth2');
  url.password = encodeURIComponent(credential.value);
  const path = project.replace(/^\/+|\/+$/g, '');
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/${path}.git`;
  return url.toString();
};

/** Where a minted token can be deleted: the project it was minted on, and its GitLab token id. */
export interface RevocationAddress {
  readonly project: string;
  readonly tokenId: number;
}

/**
 * `acme/api#58`. `#` cannot occur in a GitLab project path (path segments are
 * `[A-Za-z0-9_.-]`, joined by `/`), so the last one is always the separator.
 */
export const formatRevokeId = (address: RevocationAddress): string =>
  `${address.project}#${address.tokenId}`;

/** The inverse, or `null` for a handle this provider did not write. */
export const parseRevokeId = (revokeId: string): RevocationAddress | null => {
  const cut = revokeId.lastIndexOf('#');
  if (cut <= 0) {
    return null;
  }
  const project = revokeId.slice(0, cut);
  const tokenId = Number(revokeId.slice(cut + 1));
  if (project === '' || !/^[0-9]+$/.test(revokeId.slice(cut + 1)) || tokenId <= 0) {
    return null;
  }
  return { project, tokenId };
};

/**
 * What the adapter remembers about a credential it minted, so that `cloneUrl` can refuse a dead
 * one. The port makes that an adapter obligation:
 *
 * > `cloneUrl` … @throws `invalid_request` when the credential has been revoked or has expired.
 * > This is an obligation on the *adapter* … it minted and revoked the credential itself, so it
 * > knows.
 *
 * Keyed by `revokeId` rather than by the token value, so the registry never becomes a second place
 * a secret is stored under its own name.
 */
export interface MintedCredentialRegistry {
  remember(credential: MintedCredential, address: RevocationAddress): void;
  markRevoked(revokeId: string): void;
  /**
   * The address *this provider* minted the handle at, or `null` when it did not mint it. A
   * revocation sent anywhere else is a `DELETE` against the wrong project.
   */
  addressFor(revokeId: string): RevocationAddress | null;
  /** Whether this provider has already revoked the handle, so a second teardown sends nothing. */
  isRevoked(revokeId: string): boolean;
  /** @throws {IntegrationError} `invalid_request` when the credential is unknown, revoked or expired. */
  assertUsable(credential: MintedCredential, nowIso: string): void;
  readonly size: number;
}

export const createMintedCredentialRegistry = (): MintedCredentialRegistry => {
  const revoked = new Set<string>();
  const known = new Map<string, RevocationAddress>();

  const refuse = (detail: string): never => {
    throw new IntegrationError('invalid_request', GITLAB_PROVIDER_ID, detail, {
      action: 'clone_url',
    });
  };

  return {
    remember: (credential, address) => {
      if (credential.revokeId !== null) {
        known.set(credential.revokeId, address);
        revoked.delete(credential.revokeId);
      }
    },
    addressFor: (revokeId) => known.get(revokeId) ?? null,
    isRevoked: (revokeId) => revoked.has(revokeId),
    markRevoked: (revokeId) => {
      revoked.add(revokeId);
    },
    assertUsable: (credential, nowIso) => {
      if (credential.revokeId === null) {
        refuse('credential carries no revocation handle, so it was not minted by this provider');
        return;
      }
      if (!known.has(credential.revokeId)) {
        refuse('credential was not minted by this provider');
        return;
      }
      if (revoked.has(credential.revokeId)) {
        refuse('credential has been revoked');
        return;
      }
      const expiresAt = Date.parse(credential.expiresAt);
      if (Number.isNaN(expiresAt)) {
        refuse('credential carries no expiry');
        return;
      }
      if (expiresAt <= Date.parse(nowIso)) {
        refuse('credential has expired');
      }
    },
    get size() {
      return known.size;
    },
  };
};
