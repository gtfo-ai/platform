/**
 * **Which tracker statuses start work, and which mean a person finished the ticket** — the M28
 * rulings 1–3 (S-28.4), amending TD-029.
 *
 * A pick-up label says a ticket is *meant* for the platform; it does not say the ticket is *ready*.
 * On the dogfood installation a ticket a person had delivered and released three weeks earlier still
 * carried the label, and the poll started it again. So the binding's lifecycle block carries a
 * **status policy** beside its slots:
 *
 *  - `start_from` — the statuses work is started from. Absent: every status whose tracker category
 *    is **To Do**. `pickup_status` (the `pick_up_from` slot) is always startable: it is the binding's
 *    own statement of when a ticket is ready.
 *  - `closed` — the statuses that mean a person finished the ticket. Absent: every status whose
 *    category is **Done**.
 *  - `on_ticket_closed` — `stop` (default) or `ignore`, read by the reverse sync.
 *
 * A status of an **unknown** category is never startable. Every name is compared as the slots
 * compare ({@link lifecycleStatusKey}: trimmed, case-insensitive).
 *
 * This module is pure: the caller hands in the status it read, the category the provider reported
 * (`null` when it reported none — which is not the same as `unknown`, a category the provider
 * reported and the platform does not recognise) and the policy. Every door asks it: the poll's
 * query and the webhook's rule (the provider adapters, which render the same policy into their own
 * terms), intake ({@link intakeStatusDecision}) and the claim before the first run
 * ({@link claimStatusDecision}).
 */
import type { TicketLifecycle, TicketStatusCategory } from '@platform/contracts';
import { LIFECYCLE_SINGLE_SLOTS, lifecycleStatusKey } from '@platform/contracts';
import { lifecycleMapsAnySlot } from './claim.js';

/** A binding's status policy, as every door reads it. */
export interface TicketStatusPolicy {
  /** `pickup_status` — the `pick_up_from` slot — or `null` when the binding picks up by label. */
  readonly pickUpFrom: string | null;
  /** `start_from`, or `null` for the tracker's To Do category. */
  readonly startFrom: readonly string[] | null;
  /** `closed`, or `null` for the tracker's Done category. */
  readonly closed: readonly string[] | null;
  readonly onTicketClosed: 'stop' | 'ignore';
  /**
   * The statuses the platform's own lifecycle writes or reads as a person handing work back: the
   * five single slots and `returned` (TD-029 decision 1). For a ticket the platform holds, a move
   * into one of these is the platform's own (or a human return), never a person taking it.
   */
  readonly platformStatuses: readonly string[];
}

/**
 * The policy of a binding: its `pickup_status` and its `lifecycle` block, which may be absent — the
 * policy's defaults apply to **every** binding, block or not (M28 ruling 1: the default changes
 * behaviour for existing bindings, deliberately).
 */
export const ticketStatusPolicyOf = (
  pickUpFrom: string | null,
  block: TicketLifecycle | null | undefined,
): TicketStatusPolicy => ({
  pickUpFrom,
  startFrom: block?.start_from ?? null,
  closed: block?.closed ?? null,
  onTicketClosed: block?.on_ticket_closed ?? 'stop',
  platformStatuses:
    block === null || block === undefined
      ? []
      : [
          ...LIFECYCLE_SINGLE_SLOTS.flatMap((slot) => {
            const name = block[slot];
            return name === undefined ? [] : [name];
          }),
          ...(block.returned ?? []),
        ],
});

/**
 * **The legacy `status_mapping` writes count as the platform's own** (S-28.4 review finding 1): a
 * block that maps no slot does not supersede `status_mapping` (TD-029 decision 3), so the status
 * mapping handler moves the ticket — into an In Progress status, or a Done one — and the claim's
 * pre-read, the reverse sync and the sweep must not read that move as a person's. Adds the
 * mapping's target statuses to `platformStatuses` exactly when no slot is mapped; idempotent.
 */
export const withStatusMappingStatuses = (
  policy: TicketStatusPolicy,
  block: TicketLifecycle | null | undefined,
  statusMapping: Readonly<Record<string, string>> | null | undefined,
): TicketStatusPolicy => {
  if (lifecycleMapsAnySlot(block) || statusMapping === null || statusMapping === undefined) {
    return policy;
  }
  const extra = Object.values(statusMapping).filter(
    (name) => !listHas(policy.platformStatuses, name),
  );
  return extra.length === 0
    ? policy
    : { ...policy, platformStatuses: [...policy.platformStatuses, ...extra] };
};

/** The policy of a binding that declares nothing: the category defaults, no `pickup_status`. */
export const DEFAULT_TICKET_STATUS_POLICY: TicketStatusPolicy = ticketStatusPolicyOf(null, null);

/**
 * What a ticket's status means to the platform (M28 ruling 2):
 *
 *  - `startable` — work may start: `pickup_status`, a `start_from` status, or (no list) a To Do
 *    status;
 *  - `closed` — a person finished it: a `closed` status, or (no list) a Done status;
 *  - `hands_off` — a person is working it: a status of the In Progress category that is neither of
 *    the above, and — for a ticket the platform holds — not one the platform's own lifecycle writes
 *    (a slot) or reads as a hand-back (`returned`);
 *  - `not_ready` — everything else: a waiting status outside `start_from` (an *Idea*), a status of
 *    an unknown or unreported category, or the platform's own status on a ticket it holds. Nothing
 *    to act on.
 */
export type TicketStatusDisposition = 'startable' | 'not_ready' | 'hands_off' | 'closed';

const listHas = (list: readonly string[], status: string): boolean => {
  const key = lifecycleStatusKey(status);
  return list.some((name) => lifecycleStatusKey(name) === key);
};

/** Whether the status starts work (`pickup_status`, `start_from`, or the To Do category). */
const startable = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
): boolean =>
  (policy.pickUpFrom !== null && listHas([policy.pickUpFrom], status)) ||
  (policy.startFrom === null ? category === 'todo' : listHas(policy.startFrom, status));

/** Whether the status means a person finished the ticket (`closed`, or the Done category). */
const closed = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
): boolean => (policy.closed === null ? category === 'done' : listHas(policy.closed, status));

/**
 * The disposition of one status — see {@link TicketStatusDisposition}. `platformHolds` is whether
 * the platform holds this ticket for a live task (it claimed it, or the task is past its first
 * stage); a status the platform's lifecycle writes is then its own, and answers `not_ready` before
 * anything else, so the platform's own `done` write never reads as a person closing the ticket.
 */
export const ticketStatusDisposition = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
  platformHolds: boolean,
): TicketStatusDisposition => {
  if (platformHolds && listHas(policy.platformStatuses, status)) {
    return 'not_ready';
  }
  if (closed(status, category, policy)) {
    return 'closed';
  }
  if (startable(status, category, policy)) {
    return 'startable';
  }
  return category === 'in_progress' ? 'hands_off' : 'not_ready';
};

/**
 * Whether the answer depended on a category the provider did not report: a status outside both
 * lists (or with no list to decide it) whose category is `null`. Jira always reports one; a
 * provider — or a fake — that does not cannot be judged by category, and intake then fails open as
 * it does for a ticket it could not read (M28 ruling 3 (c)).
 */
const undecidedForWantOfCategory = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
): boolean =>
  category === null &&
  !(policy.closed !== null && listHas(policy.closed, status)) &&
  policy.startFrom === null &&
  !(policy.pickUpFrom !== null && listHas([policy.pickUpFrom], status));

/** What intake does with a matched ticket's status. */
export type IntakeStatusDecision =
  | { readonly kind: 'take' }
  | { readonly kind: 'skip'; readonly disposition: Exclude<TicketStatusDisposition, 'startable'> };

/**
 * **Intake's question** (M28 ruling 3 (c)): a matched ticket becomes a task only when its status is
 * startable. Intake holds no ticket, so the platform's own statuses are not exempt. A status the
 * provider gave no category for, outside both lists, is taken — the same fail-open as a ticket that
 * could not be read; the claim before the first run asks again.
 */
export const intakeStatusDecision = (
  status: string,
  category: TicketStatusCategory | null,
  policy: TicketStatusPolicy,
): IntakeStatusDecision => {
  const disposition = ticketStatusDisposition(status, category, policy, false);
  if (disposition === 'startable' || undecidedForWantOfCategory(status, category, policy)) {
    return { kind: 'take' };
  }
  return { kind: 'skip', disposition };
};

/** What the claim's pre-read does with the ticket's status. */
export type ClaimStatusDecision =
  | { readonly kind: 'proceed' }
  | {
      readonly kind: 'refuse';
      readonly reason: 'ticket_not_startable' | 'ticket_closed_in_tracker';
    };

/**
 * **The claim's re-check** (M28 ruling 3 (d)): a task that waited — WIP-queued, or behind a gate —
 * may find its ticket moved by the time its first agent run is admitted.
 *
 *  - A `closed` ticket refuses every claim (`ticket_closed_in_tracker`), unless the binding says
 *    `on_ticket_closed: ignore`.
 *  - A **first** claim refuses a ticket that is not startable any more (`ticket_not_startable`) —
 *    a person took it (`hands_off`) or put it back to wait (`not_ready`). The platform's own slot
 *    statuses are exempt: a claim that crashed after its `in_progress` write meets its own move.
 *  - A **re-claim** (after a human return) proceeds from any status that is not closed: the person
 *    who returned the work moved the ticket wherever their workflow sends returned work.
 *  - A status of no reported category, outside both lists, proceeds (intake's fail-open).
 */
export const claimStatusDecision = (input: {
  readonly status: string;
  readonly category: TicketStatusCategory | null;
  readonly policy: TicketStatusPolicy;
  readonly first: boolean;
  /**
   * The claim was made for a person's explicit instruction — a *Rework*, a resume, a return to a
   * stage, a hand-back (S-28.4 review ruling (a)): where the ticket sits does not override it, so
   * nothing is refused; the caller may say a closed status as a notice.
   */
  readonly humanCommanded?: boolean;
}): ClaimStatusDecision => {
  const { status, category, policy, first } = input;
  if (input.humanCommanded === true) {
    return { kind: 'proceed' };
  }
  const disposition = ticketStatusDisposition(status, category, policy, true);
  if (disposition === 'closed') {
    return policy.onTicketClosed === 'ignore'
      ? { kind: 'proceed' }
      : { kind: 'refuse', reason: 'ticket_closed_in_tracker' };
  }
  if (
    !first ||
    disposition === 'startable' ||
    listHas(policy.platformStatuses, status) ||
    undecidedForWantOfCategory(status, category, policy)
  ) {
    return { kind: 'proceed' };
  }
  return { kind: 'refuse', reason: 'ticket_not_startable' };
};
