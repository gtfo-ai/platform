/**
 * The ticket lifecycle's save-time rules — TD-029 decision 1 (BD-031, WP-174 ruling (c)).
 *
 * The binding's `lifecycle` block maps slots onto the tracker's own status names, and the server
 * checks it at `PUT …/bindings` before anything is saved (WP-181). This is the pure half of that
 * check: given the block, the binding's `pickup_status` (which **is** the `pick_up_from` slot) and
 * the status names the provider listed, it returns every problem as a typed issue and never throws,
 * so the caller can answer all of them at once and choose the status code (`422
 * lifecycle_status_unknown` for a name outside the loaded set).
 *
 * Every comparison is {@link lifecycleStatusKey} — trimmed and lower-cased — because the tracker
 * compares that way (`transition` resolves the target case-insensitively): a name that differs from
 * a loaded status only in case **is** that status, and two slots that differ only in case name one
 * status.
 *
 * What it checks:
 *  - `duplicate_slot`: two single slots, or a single slot and `pick_up_from`, name one status;
 *  - `returned_overlap`: a `returned` name is also a single slot's or `pick_up_from`'s;
 *  - `returned_duplicate`: `returned` names one status twice;
 *  - `unknown_status`: a named status is not in the provider's loaded set.
 *
 * `ticketLifecycleSchema` (`@platform/contracts`) already refuses the first three inside the block;
 * they are checked again here because `pick_up_from` is a sibling key the block's schema cannot
 * see, and because a reader that trusts a parse done elsewhere is a reader that can be handed an
 * unparsed value.
 */
import {
  LIFECYCLE_SINGLE_SLOTS,
  type LifecycleSingleSlot,
  lifecycleStatusKey,
  type TicketLifecycle,
} from '@platform/contracts';

/** A slot as the issues name it: the five single slots, `pick_up_from`, and `returned`. */
export type LifecycleSlotName = LifecycleSingleSlot | 'pick_up_from' | 'returned';

export type LifecycleIssue =
  | {
      readonly code: 'duplicate_slot';
      readonly slot: LifecycleSlotName;
      /** The slot that already names the status. */
      readonly other: LifecycleSlotName;
      readonly name: string;
    }
  | {
      readonly code: 'returned_overlap';
      readonly index: number;
      readonly other: LifecycleSlotName;
      readonly name: string;
    }
  | { readonly code: 'returned_duplicate'; readonly index: number; readonly name: string }
  | {
      readonly code: 'unknown_status';
      readonly slot: LifecycleSlotName;
      /** The position in `returned`, or `null` for a single slot. */
      readonly index: number | null;
      readonly name: string;
    };

/** Every named slot in the order a ticket normally passes them, `pick_up_from` first. */
const namedSingles = (
  slots: TicketLifecycle,
  pickupStatus: string | null,
): readonly (readonly [LifecycleSlotName, string])[] => [
  ...(pickupStatus === null ? [] : [['pick_up_from', pickupStatus] as const]),
  ...LIFECYCLE_SINGLE_SLOTS.flatMap((slot) => {
    const name = slots[slot];
    return name === undefined ? [] : [[slot, name] as const];
  }),
];

const distinctnessIssues = (
  singles: readonly (readonly [LifecycleSlotName, string])[],
  returned: readonly string[],
): LifecycleIssue[] => {
  const issues: LifecycleIssue[] = [];
  const holders = new Map<string, LifecycleSlotName>();
  for (const [slot, name] of singles) {
    const other = holders.get(lifecycleStatusKey(name));
    if (other === undefined) {
      holders.set(lifecycleStatusKey(name), slot);
    } else {
      issues.push({ code: 'duplicate_slot', slot, other, name });
    }
  }
  const seen = new Set<string>();
  for (const [index, name] of returned.entries()) {
    const key = lifecycleStatusKey(name);
    const other = holders.get(key);
    if (other !== undefined) {
      issues.push({ code: 'returned_overlap', index, other, name });
    }
    if (seen.has(key)) {
      issues.push({ code: 'returned_duplicate', index, name });
    }
    seen.add(key);
  }
  return issues;
};

const membershipIssues = (
  singles: readonly (readonly [LifecycleSlotName, string])[],
  returned: readonly string[],
  loadedNames: readonly string[],
): LifecycleIssue[] => {
  const loaded = new Set(loadedNames.map(lifecycleStatusKey));
  const unknown = (name: string) => !loaded.has(lifecycleStatusKey(name));
  return [
    ...singles
      .filter(([, name]) => unknown(name))
      .map(([slot, name]): LifecycleIssue => ({ code: 'unknown_status', slot, index: null, name })),
    ...[...returned.entries()]
      .filter(([, name]) => unknown(name))
      .map(
        ([index, name]): LifecycleIssue => ({
          code: 'unknown_status',
          slot: 'returned',
          index,
          name,
        }),
      ),
  ];
};

/**
 * Every problem with a lifecycle block, as typed issues — `[]` when it may be saved. Never throws.
 *
 * `pickupStatus` is the binding's `pickup_status`, or `null` when the binding picks up by label.
 * `loadedNames` is every status name the provider listed (`listStatuses`, TD-029 decision 2).
 */
export const validateLifecycle = (
  slots: TicketLifecycle,
  pickupStatus: string | null,
  loadedNames: readonly string[],
): readonly LifecycleIssue[] => {
  const singles = namedSingles(slots, pickupStatus);
  const returned = slots.returned ?? [];
  return [
    ...distinctnessIssues(singles, returned),
    ...membershipIssues(singles, returned, loadedNames),
  ];
};
