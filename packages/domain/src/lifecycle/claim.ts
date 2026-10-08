/**
 * The ticket claim's pure rules — BD-031 ruling 5, TD-029 decisions 1, 3 and 5 (WP-177).
 *
 * The application asks these questions between the `stage.execute` job's transactions (the claim),
 * in `runIntakeCheck` (the intake skip), in the status-mapping handler (whether `status_mapping` is
 * superseded) and in the lifecycle and release duties. Each answer is a function of values the
 * caller already holds, so every branch is a unit case rather than a provider fixture.
 *
 * **Who is "me"** is the binding's own account, compared by the provider and the provider's
 * account id — never by display name or email, which a tracker lets two people share. A binding
 * authenticated as a person's own account cannot tell the platform's claim from that person's own
 * assignment (Q118), and two installations sharing one account both see themselves as the assignee
 * (PROGRESS backlog 538). Both residuals are TD-029's, stated there.
 */
import {
  type ExternalIdentity,
  LIFECYCLE_SINGLE_SLOTS,
  type StoredTicketClaim,
  type TicketLifecycle,
} from '@platform/contracts';

/**
 * Whether the block maps **any** slot other than `pick_up_from` — TD-029 decision 3: when it does,
 * the slots are the project's ticket lifecycle and `status_mapping` is not applied at all. `claim`
 * and `take_assigned_tickets` are switches, not slots, and an empty `returned` maps nothing.
 */
export const lifecycleMapsAnySlot = (block: TicketLifecycle | null | undefined): boolean =>
  block !== null &&
  block !== undefined &&
  (LIFECYCLE_SINGLE_SLOTS.some((slot) => block[slot] !== undefined) ||
    (block.returned ?? []).length > 0);

/**
 * Whether the binding claims — TD-029 decision 1: `claim` defaults to **true when a `lifecycle`
 * block is present**, and a binding with no block never claims (BD-031 ruling 2: nothing mapped
 * behaves exactly as before).
 */
export const lifecycleClaims = (block: TicketLifecycle | null | undefined): boolean =>
  block !== null && block !== undefined && block.claim !== false;

/** Two identities name one account: same provider, same provider-side id. */
export const sameAccount = (a: ExternalIdentity, b: ExternalIdentity): boolean =>
  a.provider === b.provider && a.external_id === b.external_id;

/**
 * Intake's question (TD-029 decision 5): on a **claiming** binding, a ticket assigned to somebody
 * who is neither nobody nor the binding's own account creates no task — unless
 * `take_assigned_tickets` is true. An unknown assignee (the ticket could not be read) is not a
 * reason to skip: the claim before the first run asks again and refuses by name.
 */
export const intakeSkipsAssignedTicket = (input: {
  readonly lifecycle: TicketLifecycle | null | undefined;
  readonly self: ExternalIdentity | null;
  readonly assignee: ExternalIdentity | null;
}): boolean => {
  if (!lifecycleClaims(input.lifecycle) || input.lifecycle?.take_assigned_tickets === true) {
    return false;
  }
  if (input.assignee === null) {
    return false;
  }
  return input.self === null || !sameAccount(input.self, input.assignee);
};

/**
 * Whether the next agent admission must claim (TD-029 decision 5): the task never claimed, its
 * claim was marked stale (a *Rework*, a human return), or it was released.
 */
export const ticketClaimNeeded = (claim: StoredTicketClaim | null): boolean =>
  claim === null || claim.stale || claim.released_at !== null;

/**
 * Whether the task holds its ticket now — what the lifecycle duty asks before it moves a ticket on
 * a claiming binding, so it never moves a ticket somebody else may hold.
 */
export const ticketClaimHeld = (claim: StoredTicketClaim | null): boolean =>
  claim !== null && !claim.stale && claim.released_at === null;

/** The claim's verdict on the re-read: held by the binding's own account, or by somebody else. */
export type ClaimReadback =
  | { readonly kind: 'held' }
  | { readonly kind: 'elsewhere'; readonly assignee: ExternalIdentity | null };

/**
 * The re-read's verdict. An unassigned ticket after the assign is **not** held: something cleared
 * it between the write and the read, and only a person can say who should have it.
 */
export const claimReadback = (
  self: ExternalIdentity,
  assignee: ExternalIdentity | null,
): ClaimReadback =>
  assignee !== null && sameAccount(self, assignee)
    ? { kind: 'held' }
    : { kind: 'elsewhere', assignee };

/**
 * The marker the claim refusal's ticket comment opens with (TD-029 decision 5), one of
 * `PLATFORM_COMMENT_MARKERS`, so the platform never reads its own refusal as a person's word.
 */
export const claimRefusedCommentMarker = (taskId: string): string =>
  `agentic:claim-refused:${taskId}`;
