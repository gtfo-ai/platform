/**
 * One-time invite links: what state a link is in (TD-022's 2026-11-26 amendment).
 *
 * Pure: `now` is the **database's** `now()`, read beside the row, so the list, the inspect and the
 * accept's refusal all agree with the claim's own `expires_at > now()` — never this process's clock.
 * The refusal each ending answers (`410 invite_used`, `invite_expired`, `invite_revoked`) is the
 * route's (`apps/server/src/routes/invites.ts`), spelled there as literals for the error census.
 *
 * The order of the endings is decided here and only here: an ended link stays ended after its
 * expiry passes. A link that made an account reads *accepted*; a revoked one reads *revoked* even
 * while an accept holds its claim (the revoke stands, and the release does not undo it); a claim
 * with neither an account nor a revoke reads *accepted* — in flight, or spent by a crash.
 */
import type { InviteState } from '@platform/contracts';

export interface InviteEndings {
  /** The claim's instant: set by an accept in flight, and kept when its account is made. */
  readonly acceptedAt: Date | null;
  /** The account the link made, once it exists. */
  readonly acceptedUserId: string | null;
  readonly revokedAt: Date | null;
  readonly expiresAt: Date;
}

export const inviteStateAt = (invite: InviteEndings, now: Date): InviteState => {
  // An account exists: that is what happened, whatever else the row says.
  if (invite.acceptedUserId !== null) return 'accepted';
  // A revoke stands over a claim that has made no account yet (an in-flight or released accept).
  if (invite.revokedAt !== null) return 'revoked';
  // Claimed, no account: in flight, or a crash between the claim and the account — spent.
  if (invite.acceptedAt !== null) return 'accepted';
  return invite.expiresAt.getTime() > now.getTime() ? 'pending' : 'expired';
};
