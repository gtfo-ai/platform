/**
 * Issuing a link code, recording what a comment carrying one proved, and the person's confirmation
 * — the half of S-26.6 that writes (TD-031's 2026-11-06 amendment item 9; `link-codes.ts` has the
 * code and the claim, `link-thread.ts` the *I wrote it on …* read).
 *
 * ## A match is not a link
 *
 * {@link createIdentityLinkRecorder} runs **inside** the transaction of whatever read the comment —
 * an inbound delivery's (`integrations/inbound.ts`, with its `inbox` row) or a thread read's — and
 * records at most a **match**: the code, the provider account that wrote the comment, its display
 * name and the comment's id (`identity_link_matches`). It never writes `user_identities`. Only
 * {@link IdentityLinks.confirm}, called with the person's session and an `Idempotency-Key`, links,
 * and it re-checks everything the recorder checked, because time passed in between.
 *
 * ## What the recorder refuses, in order
 *
 *  1. a claim `link-codes.ts` already refused (an edited comment, a platform marker, the binding's
 *     own account, …);
 *  2. an author **ignored for the day** — five comments with non-matching codes in 24 hours;
 *  3. a **`machine`** identity (an operator declared the account a bot, WP-61);
 *  4. **any** binding's stored own account (`bindings.account_identity`) — the adapter checked its
 *     own live, and this is the other half;
 *  5. per code: a code that is no live code is a **miss**; a live one whose author is linked to
 *     **another** user voids the code (`identity_linked_elsewhere`); a live one already matched by a
 *     **different** author voids it (`second_author`, (b)) — two distinct authors means somebody
 *     copied a code posted where others can read it, and the code is no longer evidence of anyone.
 *
 * The code row is **locked** before its matches are read, so two deliveries of two authors cannot
 * both see "no other match" (READ COMMITTED re-reads after the lock).
 *
 * ## Residual
 *
 * A person who confirms the wrong name links the wrong account (BACKLOG 1086): the display name is
 * untrusted (BD-022), so the page shows it beside the provider and the account id.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import type {
  IdentityLinkStore,
  LinkAuthor,
  LinkCodeVoidReason,
  LinkedIdentity,
  StoredLinkCode,
  StoredLinkMatch,
} from '../ports/identity-links.js';
import type { LinkCodeClaim } from '../ports/integrations/common.js';
import type { Logger } from '../ports/logger.js';
import { silentLogger } from '../ports/logger.js';
import type { Transaction } from '../ports/transaction.js';
import type { UnitOfWork } from '../ports/unit-of-work.js';
import {
  generateLinkCode,
  hashLinkCode,
  LINK_CODE_RATE_WINDOW_MS,
  LINK_CODE_TTL_MS,
  LINK_CODES_PER_WINDOW,
  LINK_MISS_WINDOW_MS,
  LINK_MISSES_BEFORE_IGNORED,
  sameLinkCodeHash,
} from './link-codes.js';

const at = (instant: number): IsoDateTime => new Date(instant).toISOString() as IsoDateTime;

/** Whether a code may still be matched or confirmed at `now`. */
export const isLiveLinkCode = (code: StoredLinkCode, now: IsoDateTime): boolean =>
  code.consumedAt === null &&
  code.voidedAt === null &&
  Date.parse(code.expiresAt) > Date.parse(now);

const sameAuthor = (left: LinkAuthor, right: LinkAuthor): boolean =>
  left.provider === right.provider && left.externalId === right.externalId;

/** What a comment's author does to a **live** code. Pure; the recorder and the tests share it. */
export type LiveCodeDecision = 'match' | 'already_matched' | 'second_author' | 'linked_elsewhere';

export const decideLiveCode = (input: {
  readonly codeUserId: Id;
  readonly author: LinkAuthor;
  readonly identity: LinkedIdentity | null;
  readonly matches: readonly LinkAuthor[];
}): LiveCodeDecision => {
  if (
    input.identity !== null &&
    input.identity.kind === 'person' &&
    input.identity.userId !== input.codeUserId
  ) {
    return 'linked_elsewhere';
  }
  if (input.matches.some((match) => !sameAuthor(match, input.author))) {
    return 'second_author';
  }
  return input.matches.length > 0 ? 'already_matched' : 'match';
};

/** Why the recorder recorded nothing for a claim, beside the claim's own refusals. */
export type LinkRecordRefusal =
  | NonNullable<LinkCodeClaim['refusal']>
  | 'author_ignored'
  | 'machine_identity'
  | 'binding_account_stored';

/** What one call recorded — counted, so the caller can log it and a test can assert the branch. */
export interface LinkRecordSummary {
  readonly matched: number;
  readonly missed: number;
  readonly voided: readonly LinkCodeVoidReason[];
  readonly refused: readonly LinkRecordRefusal[];
  /** Authors who reached the miss bound in this call and are ignored for the day. */
  readonly ignored: readonly LinkAuthor[];
}

export const EMPTY_LINK_RECORD: LinkRecordSummary = {
  matched: 0,
  missed: 0,
  voided: [],
  refused: [],
  ignored: [],
};

export interface IdentityLinkRecorder {
  /** Records what the claims proved, in the caller's transaction. Never writes `user_identities`. */
  readonly record: (
    tx: Transaction,
    input: { readonly integrationId: Id; readonly claims: readonly LinkCodeClaim[] },
  ) => Promise<LinkRecordSummary>;
}

export interface IdentityLinkRecorderOptions {
  readonly store: IdentityLinkStore;
  readonly ids: { next(): Id };
  readonly clock: { now(): IsoDateTime };
  readonly logger?: Logger;
}

export const createIdentityLinkRecorder = (
  options: IdentityLinkRecorderOptions,
): IdentityLinkRecorder => {
  const logger = options.logger ?? silentLogger;
  const { store } = options;
  return {
    record: async (tx, input) => {
      const now = options.clock.now();
      const missSince = at(Date.parse(now) - LINK_MISS_WINDOW_MS);
      let matched = 0;
      let missed = 0;
      const voided: LinkCodeVoidReason[] = [];
      const refused: LinkRecordRefusal[] = [];
      const ignored: LinkAuthor[] = [];
      // One comment normalised for two bound projects is one claim, not two.
      const seen = new Set<string>();
      for (const claim of input.claims) {
        const key = `${claim.provider}\0${claim.externalId}\0${claim.commentId}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        if (claim.refusal !== null) {
          refused.push(claim.refusal);
          continue;
        }
        const author: LinkAuthor = { provider: claim.provider, externalId: claim.externalId };
        if (await store.ignoredSince(tx, author, missSince)) {
          refused.push('author_ignored');
          continue;
        }
        const identity = await store.identityOf(tx, author);
        if (identity?.kind === 'machine') {
          refused.push('machine_identity');
          continue;
        }
        if (await store.isBindingAccount(tx, author)) {
          refused.push('binding_account_stored');
          continue;
        }
        const entry = {
          integrationId: input.integrationId,
          provider: claim.provider,
          externalId: claim.externalId,
          displayName: claim.displayName,
          commentId: claim.commentId,
          at: now,
        };
        let newMiss = false;
        for (const hash of claim.codeHashes) {
          const code = await store.lockCodeByHash(tx, hash);
          if (
            code === null ||
            !sameLinkCodeHash(code.codeHash, hash) ||
            !isLiveLinkCode(code, now)
          ) {
            missed += 1;
            newMiss = (await store.insertMiss(tx, { ...entry, id: options.ids.next() })) || newMiss;
            continue;
          }
          const decision = decideLiveCode({
            codeUserId: code.userId,
            author,
            identity,
            matches: await store.matchesOf(tx, code.id),
          });
          if (decision === 'linked_elsewhere' || decision === 'second_author') {
            const reason: LinkCodeVoidReason =
              decision === 'second_author' ? 'second_author' : 'identity_linked_elsewhere';
            await store.voidCode(tx, code.id, now, reason);
            voided.push(reason);
            logger.warn(
              { integration_id: input.integrationId, provider: claim.provider, reason },
              'a link code was voided: the comment carrying it cannot link anybody',
            );
            continue;
          }
          if (decision === 'match') {
            await store.insertMatch(tx, {
              id: options.ids.next(),
              codeId: code.id,
              integrationId: input.integrationId,
              provider: claim.provider,
              externalId: claim.externalId,
              displayName: claim.displayName,
              commentId: claim.commentId,
              createdAt: now,
            });
            matched += 1;
          }
        }
        if (newMiss) {
          const misses = await store.countMissesSince(tx, author, missSince);
          if (misses >= LINK_MISSES_BEFORE_IGNORED) {
            await store.insertIgnored(tx, { ...entry, id: options.ids.next() });
            ignored.push(author);
            logger.warn(
              { integration_id: input.integrationId, provider: claim.provider, misses },
              'a provider account wrote five non-matching link codes in 24 hours and is ignored for the day',
            );
          }
        }
      }
      return { matched, missed, voided, refused, ignored };
    },
  };
};

/** What issuing a code answered. The code itself is in this answer and nowhere else. */
export type LinkCodeIssue =
  | {
      readonly kind: 'issued';
      readonly id: Id;
      readonly code: string;
      readonly expiresAt: IsoDateTime;
    }
  | { readonly kind: 'rate_limited'; readonly retryAfterMs: number };

/** Why a confirmation linked nothing. */
export type LinkConfirmRefusal =
  | 'match_not_found'
  | 'code_expired'
  | 'code_voided'
  | 'code_used'
  | 'identity_linked_elsewhere'
  | 'identity_is_machine'
  | 'identity_is_binding_account';

export type LinkConfirmation =
  | {
      readonly kind: 'linked';
      readonly matchId: Id;
      readonly provider: string;
      readonly externalId: string;
      readonly displayName: string | null;
      /** `true` when this match had already been confirmed (a retry), so nothing was written. */
      readonly replayed: boolean;
    }
  | {
      readonly kind: 'refused';
      readonly reason: LinkConfirmRefusal;
      /** Set for `code_voided`: why the code stopped. */
      readonly voidReason?: LinkCodeVoidReason;
    };

export interface IdentityLinks {
  /** A new code for the user; the previous open one is voided (`replaced`) in the same transaction. */
  readonly issue: (userId: Id) => Promise<LinkCodeIssue>;
  /** The person's confirmation of one match: the only writer of a self-service link. */
  readonly confirm: (userId: Id, matchId: Id) => Promise<LinkConfirmation>;
  readonly recorder: IdentityLinkRecorder;
}

export interface IdentityLinksOptions extends IdentityLinkRecorderOptions {
  readonly unitOfWork: UnitOfWork;
  /** The CSPRNG; `randomBytes` when absent. A test names it to know the code it posts. */
  readonly draw?: (size: number) => Uint8Array;
}

export const createIdentityLinks = (options: IdentityLinksOptions): IdentityLinks => {
  const { store } = options;
  const recorder = createIdentityLinkRecorder(options);

  const issue = async (userId: Id): Promise<LinkCodeIssue> =>
    options.unitOfWork.transaction(async ({ tx }) => {
      await store.lockUser(tx, userId);
      const now = options.clock.now();
      const nowMs = Date.parse(now);
      const issued = await store.countIssuedSince(tx, userId, at(nowMs - LINK_CODE_RATE_WINDOW_MS));
      if (issued.count >= LINK_CODES_PER_WINDOW) {
        const oldest = issued.oldest === null ? nowMs : Date.parse(issued.oldest);
        return {
          kind: 'rate_limited' as const,
          retryAfterMs: Math.max(1_000, oldest + LINK_CODE_RATE_WINDOW_MS - nowMs),
        };
      }
      await store.voidOpen(tx, userId, now, 'replaced');
      const code = generateLinkCode(options.draw);
      const id = options.ids.next();
      const expiresAt = at(nowMs + LINK_CODE_TTL_MS);
      await store.insertCode(tx, {
        id,
        userId,
        codeHash: hashLinkCode(code),
        createdAt: now,
        expiresAt,
      });
      return { kind: 'issued' as const, id, code, expiresAt };
    });

  const confirmIn = async (tx: Transaction, userId: Id, matchId: Id): Promise<LinkConfirmation> => {
    const now = options.clock.now();
    const match = await store.findMatch(tx, matchId);
    if (match === null) {
      return { kind: 'refused', reason: 'match_not_found' };
    }
    const code = await store.lockCode(tx, match.codeId);
    // Another person's match is answered as no match: it says nothing about whose code it was.
    if (code === null || code.userId !== userId) {
      return { kind: 'refused', reason: 'match_not_found' };
    }
    const linked = (replayed: boolean): LinkConfirmation => ({
      kind: 'linked',
      matchId: match.id,
      provider: match.provider,
      externalId: match.externalId,
      displayName: match.displayName,
      replayed,
    });
    if (code.consumedAt !== null) {
      return code.consumedMatchId === match.id
        ? linked(true)
        : { kind: 'refused', reason: 'code_used' };
    }
    if (code.voidedAt !== null) {
      return {
        kind: 'refused',
        reason: 'code_voided',
        ...(code.voidReason === null ? {} : { voidReason: code.voidReason }),
      };
    }
    if (!isLiveLinkCode(code, now)) {
      return { kind: 'refused', reason: 'code_expired' };
    }
    // (b) re-checked at the confirmation: a second author may have matched since the page loaded.
    const matches: readonly StoredLinkMatch[] = await store.matchesOf(tx, code.id);
    if (matches.some((other) => !sameAuthor(other, match))) {
      await store.voidCode(tx, code.id, now, 'second_author');
      return { kind: 'refused', reason: 'code_voided', voidReason: 'second_author' };
    }
    const identity = await store.identityOf(tx, match);
    if (identity?.kind === 'machine') {
      return { kind: 'refused', reason: 'identity_is_machine' };
    }
    if (identity !== null && identity.userId !== userId) {
      await store.voidCode(tx, code.id, now, 'identity_linked_elsewhere');
      return { kind: 'refused', reason: 'identity_linked_elsewhere' };
    }
    if (await store.isBindingAccount(tx, match)) {
      return { kind: 'refused', reason: 'identity_is_binding_account' };
    }
    const write = await store.linkIdentity(tx, {
      provider: match.provider,
      externalId: match.externalId,
      userId,
      displayName: match.displayName,
    });
    if (write === 'machine') {
      return { kind: 'refused', reason: 'identity_is_machine' };
    }
    if (write === 'linked_elsewhere') {
      await store.voidCode(tx, code.id, now, 'identity_linked_elsewhere');
      return { kind: 'refused', reason: 'identity_linked_elsewhere' };
    }
    await store.consume(tx, code.id, match.id, now);
    return linked(false);
  };

  return {
    issue,
    // Refusals that void the code are **committed** (the transaction returns rather than throws),
    // so a code a second author touched stays voided whatever the person does next.
    confirm: async (userId, matchId) =>
      options.unitOfWork.transaction(async ({ tx }) => confirmIn(tx, userId, matchId)),
    recorder,
  };
};
