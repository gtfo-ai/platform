/**
 * The readiness output's **notes** about the ticket lifecycle — BD-031 ruling 7, product/17's
 * 2026-10-08 amendment (WP-181 ruling (d)).
 *
 * *"The readiness output lists unmapped slots as information, never as a failure."* So this answers
 * one note per slot the project's task-management binding leaves empty, and one note — the
 * platform neither claims tickets nor moves them — for a binding with no `lifecycle` block at all.
 * A note is never a criterion: it moves no level and is never in `next_improvements`, which is why
 * it is computed at the **read** from the binding (`GET …/readiness`) and never stored on an
 * evaluation — a binding edit changes the notes without a re-evaluation.
 *
 * Every message is platform text naming a slot by its product name. No tracker status name appears
 * in one: the names belong to the project's tracker, and an unmapped slot has none anyway.
 */
import type { LifecycleSingleSlot, TicketLifecycle } from '@platform/contracts';

/** The note for one slot the binding leaves empty. */
export const LIFECYCLE_SLOT_UNMAPPED_CODE = 'lifecycle_slot_unmapped';

/** The one note for a task-management binding with no lifecycle block. */
export const LIFECYCLE_NOT_CONFIGURED_CODE = 'lifecycle_not_configured';

/** A slot as the notes name it: `pick_up_from`, the five single slots and `returned`. */
export type LifecycleNoteSlot = 'pick_up_from' | LifecycleSingleSlot | 'returned';

/** The slots in the order a ticket normally passes them — the order the notes are listed in. */
export const LIFECYCLE_NOTE_SLOTS: readonly LifecycleNoteSlot[] = [
  'pick_up_from',
  'in_progress',
  'in_review',
  'approved',
  'qa',
  'returned',
  'done',
];

export interface LifecycleReadinessNote {
  readonly code:
    | typeof LIFECYCLE_SLOT_UNMAPPED_CODE
    | typeof LIFECYCLE_NOT_CONFIGURED_CODE
    | typeof BINDING_ACCOUNT_IS_A_PERSON_CODE;
  readonly severity: 'note';
  /** The slot the note is about; `null` for the not-configured note. */
  readonly slot: LifecycleNoteSlot | null;
  readonly message: string;
}

/** What an empty slot means, in product/04's words (§ "Ticket lifecycle"). */
const CONSEQUENCE: Readonly<Record<LifecycleNoteSlot, string>> = {
  pick_up_from:
    'pick up from is not mapped: intake does not start tickets by their status, and the platform does not move a cancelled or reworked task’s ticket back',
  in_progress:
    'in progress is not mapped: the platform does not move the ticket when it claims it or when a developer stage starts',
  in_review:
    'in review is not mapped: the platform does not move the ticket when the agent’s code review starts',
  approved:
    'approved is not mapped: the platform does not move the ticket when the last agent review approves',
  qa: 'QA is not mapped: the platform does not move the ticket to QA, and new tasks have no QA stage',
  returned:
    'returned is not mapped: no status of its own returns a task; a person moving the ticket back to the in progress or pick up from status still does, and so does a person’s ticket comment or merge request note',
  done: 'done is not mapped: the platform does not move the ticket when the merge request is merged',
};

/** The not-configured note's message (product/17: "neither claims tickets nor moves them"). */
export const LIFECYCLE_NOT_CONFIGURED_MESSAGE =
  'The task-management binding has no ticket lifecycle: the platform neither claims tickets nor moves them, and new tasks have no QA stage. Map the slots in the project settings to change that.';

/**
 * Q118, answered by its recommendation (a) (orchestrator, session 15): a task-management binding
 * may authenticate as a person's own account, and the readiness output then says what that costs —
 * a **note**, never a criterion and never a level. The platform claims a ticket by assigning it to
 * the binding's own account, so on a person's account a ticket assigned to that person reads as
 * already claimed, and the tracker's history shows the person doing what the agent did.
 */
export const BINDING_ACCOUNT_IS_A_PERSON_CODE = 'binding_account_is_a_person';

export const BINDING_ACCOUNT_IS_A_PERSON_MESSAGE =
  'The task-management binding acts as a platform user’s own account. It works, but the platform claims tickets by assigning them to that account, so a ticket assigned to that person reads as already claimed by the platform, and the tracker shows the person doing what the agent did. A dedicated account per installation avoids both. This is information, not a failure.';

/** The note for a binding whose own account is a mapped platform user (Q118 (a)). */
export const bindingAccountPersonNote = (): LifecycleReadinessNote => ({
  code: BINDING_ACCOUNT_IS_A_PERSON_CODE,
  severity: 'note',
  slot: null,
  message: BINDING_ACCOUNT_IS_A_PERSON_MESSAGE,
});

const mapped = (
  slot: LifecycleNoteSlot,
  lifecycle: { readonly pickUpFrom: string | null; readonly slots: TicketLifecycle },
): boolean => {
  if (slot === 'pick_up_from') {
    return lifecycle.pickUpFrom !== null;
  }
  if (slot === 'returned') {
    return (lifecycle.slots.returned ?? []).length > 0;
  }
  return lifecycle.slots[slot] !== undefined;
};

/**
 * The notes for one binding's lifecycle: one per empty slot, in {@link LIFECYCLE_NOTE_SLOTS} order,
 * or the single not-configured note when `lifecycle` is `null` (the binding has no block). A fully
 * mapped block answers `[]`.
 *
 * The caller decides when to ask: a project with **no** task-management binding has no tracker to
 * map and gets no note at all, which is not this function's `null`.
 */
export const lifecycleReadinessNotes = (
  lifecycle: { readonly pickUpFrom: string | null; readonly slots: TicketLifecycle } | null,
): readonly LifecycleReadinessNote[] => {
  if (lifecycle === null) {
    return [
      {
        code: LIFECYCLE_NOT_CONFIGURED_CODE,
        severity: 'note',
        slot: null,
        message: LIFECYCLE_NOT_CONFIGURED_MESSAGE,
      },
    ];
  }
  return LIFECYCLE_NOTE_SLOTS.filter((slot) => !mapped(slot, lifecycle)).map((slot) => ({
    code: LIFECYCLE_SLOT_UNMAPPED_CODE,
    severity: 'note',
    slot,
    message: `The ticket lifecycle slot ${CONSEQUENCE[slot]}. This is information, not a failure.`,
  }));
};
