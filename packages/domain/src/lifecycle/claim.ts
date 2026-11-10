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
 *
 * **A linked member's ticket is never taken** (S-26.2, BD-031's 2026-11-06 amendment 2, TD-031's
 * 2026-11-06 amendment item 5): an assignee who maps to a `member`-or-above person of the project is
 * taken at intake whatever `take_assigned_tickets` says, and no claim — first or re-claim — refuses
 * or re-assigns their ticket. Whether an assignee is such a member is the caller's live answer
 * (`TaskOwnerDirectory.classifyAssignee`), handed in as a boolean. Everybody else — an unlinked
 * account, a linked person below `member`, a machine — keeps the rules below unchanged, **unless a
 * person on the platform took or assigned the task** (a platform-sourced owner who may own in the
 * project, TD-031's amendment item 5 as amended for a take): then the claim keeps the ticket as it
 * is too, neither refusing nor re-assigning it ({@link claimPreReadDecision}).
 */
import {
  type ExternalIdentity,
  LIFECYCLE_SINGLE_SLOTS,
  LIFECYCLE_STATUS_POLICY_KEYS,
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
 * behaves exactly as before). A block that holds **only** the status policy (`start_from`, `closed`,
 * `on_ticket_closed` — M28 ruling 1, S-28.4) is read as no block here: choosing which statuses start
 * work is not asking the platform to assign tickets. An explicit `claim: true` beside them claims.
 */
export const lifecycleClaims = (block: TicketLifecycle | null | undefined): boolean => {
  if (block === null || block === undefined || block.claim === false) {
    return false;
  }
  const stated = Object.entries(block)
    .filter(([, value]) => value !== undefined)
    .map(([key]) => key);
  return (
    stated.length === 0 ||
    stated.some((key) => !(LIFECYCLE_STATUS_POLICY_KEYS as readonly string[]).includes(key))
  );
};

/** Two identities name one account: same provider, same provider-side id. */
export const sameAccount = (a: ExternalIdentity, b: ExternalIdentity): boolean =>
  a.provider === b.provider && a.external_id === b.external_id;

/**
 * Intake's question (TD-029 decision 5): on a **claiming** binding, a ticket assigned to somebody
 * who is neither nobody nor the binding's own account creates no task — unless
 * `take_assigned_tickets` is true, **or the assignee is a linked member of the project** (S-26.2:
 * their ticket is taken, and stays theirs). An unknown assignee (the ticket could not be read) is
 * not a reason to skip: the claim before the first run asks again and refuses by name.
 */
export const intakeSkipsAssignedTicket = (input: {
  readonly lifecycle: TicketLifecycle | null | undefined;
  readonly self: ExternalIdentity | null;
  readonly assignee: ExternalIdentity | null;
  /** The directory's live answer: the assignee maps to a `member`-or-above person of the project. */
  readonly assigneeIsLinkedMember: boolean;
}): boolean => {
  if (!lifecycleClaims(input.lifecycle) || input.lifecycle?.take_assigned_tickets === true) {
    return false;
  }
  if (input.assignee === null || input.assigneeIsLinkedMember) {
    return false;
  }
  return input.self === null || !sameAccount(input.self, input.assignee);
};

/**
 * What the claim does with the assignee it read **before** it writes (TD-029 decision 5's WP-177
 * amendment (a), narrowed by S-26.2 and by TD-031's amendment item 5 as amended for a take) —
 * asked of **every** claim, a re-claim and a shadow claim included, because a ticket the platform
 * must not take is left alone by all of them:
 *
 *  - `keep` — the claim writes **no** assign, never refuses, and the ticket still moves to
 *    `in_progress`. Two holders are kept, in this order:
 *     - `held_by: 'member'` — the holder is a linked member of the project (S-26.2);
 *     - `held_by: 'platform_owner'` — somebody else holds the ticket (anybody but nobody and the
 *       binding's own account) **and the task has a platform-sourced owner who may own in the
 *       project** (`owner_source: platform`, set by the owner command or a pick — a maintainer's
 *       *Take it* or *Assign…*). A person on the platform already decided who works the task, so
 *       the claim neither refuses it again nor writes the binding's account over the tracker's
 *       assignee: the tracker keeps showing that assignee until the owner write-back (S-26.3, when
 *       `assign_owner` is on) or a person changes it;
 *  - `refuse` — a **first** claim of a normal task finds somebody else holding the ticket (an
 *    unlinked account, a person below `member`, a machine, another binding's account), the task
 *    has no such platform owner, and the binding does not take assigned tickets:
 *    `ticket_assigned_elsewhere`, without the assign;
 *  - `assign` — everything else: an unassigned ticket, one the binding's own account holds, a
 *    re-claim after a human return (it takes the ticket back from a person who is not a linked
 *    member, on a task nobody on the platform owns), `take_assigned_tickets`, and a shadow claim,
 *    whose writes are `would_have` anyway. A platform owner does not stop the assign over **nobody**
 *    (it overwrites nobody, and it is what tells the tracker's people the ticket is taken) nor over
 *    the binding's own account.
 *
 * A tracker-sourced owner is not a fact here: such an owner is the mapped holder, which
 * `holderIsLinkedMember` already answers.
 */
export type ClaimPreReadDecision =
  | { readonly kind: 'keep'; readonly heldBy: 'member' | 'platform_owner' }
  | { readonly kind: 'refuse'; readonly assignee: ExternalIdentity }
  | { readonly kind: 'assign' };

export const claimPreReadDecision = (input: {
  readonly self: ExternalIdentity;
  readonly holder: ExternalIdentity | null;
  readonly holderIsLinkedMember: boolean;
  /**
   * The task has an owner whose `owner_source` is `platform` and who may own in the project
   * (`member` or above, not disabled) — the caller's live answer, read after the claim's own owner
   * sync, so a tracker change since the take (latest change wins) has already cleared it.
   */
  readonly platformOwner: boolean;
  /** {@link ticketClaimIsFirst} of the claim the task holds. */
  readonly first: boolean;
  readonly shadow: boolean;
  readonly takeAssignedTickets: boolean;
}): ClaimPreReadDecision => {
  if (input.holder === null) {
    return { kind: 'assign' };
  }
  if (input.holderIsLinkedMember) {
    return { kind: 'keep', heldBy: 'member' };
  }
  if (sameAccount(input.self, input.holder)) {
    return { kind: 'assign' };
  }
  if (input.platformOwner) {
    return { kind: 'keep', heldBy: 'platform_owner' };
  }
  if (input.first && !input.shadow && !input.takeAssignedTickets) {
    return { kind: 'refuse', assignee: input.holder };
  }
  return { kind: 'assign' };
};

/**
 * Whether the next agent admission must claim (TD-029 decision 5): the task never claimed, its
 * claim was marked stale (a *Rework*, a human return), or it was released.
 */
export const ticketClaimNeeded = (claim: StoredTicketClaim | null): boolean =>
  claim === null || claim.stale || claim.released_at !== null;

/**
 * Whether the next claim is a **first** claim (TD-029 decision 5, amendments (a) and (c)) — one that
 * reads the assignee before it assigns and refuses, without the assign, a ticket somebody else holds:
 *
 *  - no claim was ever recorded;
 *  - the platform **released** it (a *Rework*, a cancellation, a stopped task): the release put the
 *    ticket back in the pick-up pool, so a person who holds it afterwards took it from there;
 *  - it is stale because its task **stopped** between the assign and the record (`stale_cause:
 *    'stopped'`, WP-178 criterion (17) (ii), PROGRESS backlog 543) — whether or not its `stopped`
 *    release ran. Such a claim was never held by a running task, so a person who took the ticket
 *    meanwhile — after an exhausted release, or before a pending one — is never overwritten.
 *
 * Only a claim stale for a **human return** (or one written before `stale_cause` existed) is a
 * re-claim, which takes the ticket back: the person who returned it may well hold it — unless that
 * person is a linked member of the project, whose ticket no claim takes (S-26.2,
 * {@link claimPreReadDecision}).
 */
export const ticketClaimIsFirst = (claim: StoredTicketClaim | null): boolean =>
  claim === null || claim.released_at !== null || (claim.stale && claim.stale_cause === 'stopped');

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
 * `PLATFORM_COMMENT_MARKERS`, so the platform never reads its own refusal as a person's word. The
 * body opens with it since WP-191 (`claimRefusedCommentFor` in the application ring); before that it
 * travelled only as the provider's `marker_id`.
 */
export const claimRefusedCommentMarker = (taskId: string): string =>
  `agentic:claim-refused:${taskId}`;
