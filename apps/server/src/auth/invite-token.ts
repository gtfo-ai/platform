/**
 * The invite link's token (TD-022's 2026-11-26 amendment, item 3): 32 bytes from a CSPRNG,
 * base64url, **shown once** in the creation answer and stored only as its SHA-256.
 *
 * A 256-bit random token is a high-entropy secret, so a slow hash buys nothing (TD-022's argument
 * for the worker credential); and the token is **never compared** — its hash is looked up through
 * the unique index on `user_invites.token_sha256`, so there is no comparison whose timing could leak
 * anything but how far a guess's SHA-256 agrees with a stored one's (the link-code argument,
 * `packages/application/src/identity/link-codes.ts`).
 *
 * The link carries the token in the URL's **fragment** — `<origin>/invite#<token>` — so it never
 * reaches an access log, a proxy or a `Referer`; the SPA reads it from `location.hash` and sends it
 * in POST bodies only.
 */
import { createHash, randomBytes } from 'node:crypto';

/** The token's size in bytes: 256 bits. */
export const INVITE_TOKEN_BYTES = 32;

/** A fresh token. `draw` is the CSPRNG, injectable so a test can name the bytes. */
export const generateInviteToken = (draw: (size: number) => Uint8Array = randomBytes): string => {
  const bytes = draw(INVITE_TOKEN_BYTES);
  if (bytes.length !== INVITE_TOKEN_BYTES) {
    throw new TypeError(
      `the random source answered ${bytes.length} bytes, not ${INVITE_TOKEN_BYTES}`,
    );
  }
  return Buffer.from(bytes).toString('base64url');
};

/** What is stored and looked up: the SHA-256 of the token's text, hex. */
export const hashInviteToken = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('hex');

/** The link: the instance's origin (`APP_BASE_URL`, normalised), `/invite`, the token as fragment. */
export const inviteUrl = (baseUrl: string, token: string): string =>
  `${new URL(baseUrl).origin}/invite#${token}`;
