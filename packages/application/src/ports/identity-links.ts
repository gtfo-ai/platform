/**
 * The store behind a person's self-service account link (S-26.6, migration 0105) — the codes, the
 * matches a comment proved, and the one write into `user_identities` a confirmation makes.
 *
 * Every method that decides takes the caller's transaction: an inbound delivery records its matches
 * in the transaction that writes its `inbox` row (`integrations/inbound.ts`), and a confirmation
 * re-checks and links in one. The PostgreSQL adapter is
 * `packages/infrastructure/src/integrations/postgres-identity-links.ts`.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type { Transaction } from './transaction.js';

/** Why a code stopped before its expiry. */
export type LinkCodeVoidReason = 'replaced' | 'second_author' | 'identity_linked_elsewhere';

export interface StoredLinkCode {
  readonly id: Id;
  readonly userId: Id;
  readonly codeHash: string;
  readonly createdAt: IsoDateTime;
  readonly expiresAt: IsoDateTime;
  readonly consumedAt: IsoDateTime | null;
  readonly consumedMatchId: Id | null;
  readonly voidedAt: IsoDateTime | null;
  readonly voidReason: LinkCodeVoidReason | null;
}

/** A provider account, as a link names it. */
export interface LinkAuthor {
  readonly provider: string;
  readonly externalId: string;
}

export interface StoredLinkMatch extends LinkAuthor {
  readonly id: Id;
  readonly codeId: Id;
  readonly integrationId: Id;
  readonly displayName: string | null;
  readonly commentId: string;
  readonly createdAt: IsoDateTime;
  readonly confirmedAt: IsoDateTime | null;
}

/** A `user_identities` row as the link path reads it. */
export interface LinkedIdentity {
  readonly kind: 'person' | 'machine';
  readonly userId: Id | null;
}

/** What linking one account to one user found. */
export type IdentityLinkWrite = 'linked' | 'already_linked' | 'linked_elsewhere' | 'machine';

/** A miss or an ignored mark: an author and the comment, never its text. */
export interface LinkAuthorEntry extends LinkAuthor {
  readonly id: Id;
  readonly integrationId: Id;
  readonly displayName: string | null;
  readonly commentId: string;
  readonly at: IsoDateTime;
}

/** What `GET /api/me/identity-links` reads: the newest code and its matches. */
export interface LinkCodeState {
  readonly code: StoredLinkCode | null;
  readonly matches: readonly (StoredLinkMatch & { readonly integrationName: string | null })[];
}

export interface IdentityLinkStore {
  /** Serialises one user's issuing for the rest of the transaction (an advisory lock). */
  readonly lockUser: (tx: Transaction, userId: Id) => Promise<void>;
  /** Codes this user was issued at or after `since`, and the oldest of them. */
  readonly countIssuedSince: (
    tx: Transaction,
    userId: Id,
    since: IsoDateTime,
  ) => Promise<{ readonly count: number; readonly oldest: IsoDateTime | null }>;
  /** Voids every code of the user that has neither been consumed nor voided. */
  readonly voidOpen: (
    tx: Transaction,
    userId: Id,
    at: IsoDateTime,
    reason: LinkCodeVoidReason,
  ) => Promise<number>;
  readonly insertCode: (
    tx: Transaction,
    code: Pick<StoredLinkCode, 'id' | 'userId' | 'codeHash' | 'createdAt' | 'expiresAt'>,
  ) => Promise<void>;
  /** The code with this hash, **locked for update**, or `null`. */
  readonly lockCodeByHash: (tx: Transaction, codeHash: string) => Promise<StoredLinkCode | null>;
  /** The code, **locked for update**, or `null`. */
  readonly lockCode: (tx: Transaction, codeId: Id) => Promise<StoredLinkCode | null>;
  /** Voids the code when it is still open; a consumed or voided code is left as it is. */
  readonly voidCode: (
    tx: Transaction,
    codeId: Id,
    at: IsoDateTime,
    reason: LinkCodeVoidReason,
  ) => Promise<void>;
  /** Consumes the code with its confirmed match, and stamps the match confirmed. */
  readonly consume: (tx: Transaction, codeId: Id, matchId: Id, at: IsoDateTime) => Promise<void>;
  readonly matchesOf: (tx: Transaction, codeId: Id) => Promise<readonly StoredLinkMatch[]>;
  readonly findMatch: (tx: Transaction, matchId: Id) => Promise<StoredLinkMatch | null>;
  /** `false` when this author already has a match for the code (one per author per code). */
  readonly insertMatch: (
    tx: Transaction,
    match: Omit<StoredLinkMatch, 'confirmedAt'>,
  ) => Promise<boolean>;
  /** `false` when this author already has a miss for the comment. */
  readonly insertMiss: (tx: Transaction, entry: LinkAuthorEntry) => Promise<boolean>;
  readonly insertIgnored: (tx: Transaction, entry: LinkAuthorEntry) => Promise<void>;
  readonly countMissesSince: (
    tx: Transaction,
    author: LinkAuthor,
    since: IsoDateTime,
  ) => Promise<number>;
  readonly ignoredSince: (
    tx: Transaction,
    author: LinkAuthor,
    since: IsoDateTime,
  ) => Promise<boolean>;
  readonly identityOf: (tx: Transaction, author: LinkAuthor) => Promise<LinkedIdentity | null>;
  /** Whether any binding stores this account as its own (`bindings.account_identity`, 0090). */
  readonly isBindingAccount: (tx: Transaction, author: LinkAuthor) => Promise<boolean>;
  /**
   * Writes `user_identities` (`kind: person`) for the user — **only** when the account is not
   * mapped yet; a row that exists is answered, never overwritten.
   */
  readonly linkIdentity: (
    tx: Transaction,
    input: LinkAuthor & { readonly userId: Id; readonly displayName: string | null },
  ) => Promise<IdentityLinkWrite>;
  /** The user's newest code and its matches, read outside any transaction. */
  readonly readState: (userId: Id) => Promise<LinkCodeState>;
}
