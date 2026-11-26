/**
 * One-time invite links: what state a link is in (TD-022's 2026-11-26 amendment).
 *
 * Pure: `now` is the **database's** `now()`, read beside the row, so the list, the inspect and the
 * accept's refusal all agree with the claim's own `expires_at > now()` — never this process's clock.
 * The refusal each ending answers (`410 invite_used`, `invite_expired`, `invite_revoked`) is the
 * route's (`apps/server/src/routes/invites.ts`), spelled there as literals for the error census.
 *
 * The order of the endings is decided here and only here: an accepted link stays *accepted* after
 * its expiry passes, and so does a revoked one — what ended it first is what a person is told.
 * Accepted and revoked never both hold (the table's `user_invites_one_ending` check).
 */
import type { InviteState } from '@platform/contracts';

export interface InviteEndings {
  readonly acceptedAt: Date | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
}

export const inviteStateAt = (invite: InviteEndings, now: Date): InviteState => {
  if (invite.acceptedAt !== null) return 'accepted';
  if (invite.revokedAt !== null) return 'revoked';
  return invite.expiresAt.getTime() > now.getTime() ? 'pending' : 'expired';
};
