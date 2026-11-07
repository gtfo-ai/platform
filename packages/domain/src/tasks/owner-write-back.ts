/**
 * **Writing the owner back to the tracker** — the decisions, pure (S-26.3, TD-031's 2026-11-06
 * amendment item 4).
 *
 * When a project's task-management binding sets `lifecycle.assign_owner`, a person the platform
 * makes a task's owner is assigned the ticket in the tracker too. The application ring
 * (`packages/application/src/pipeline/owner-write-back.ts`) reads the rows and makes the call; every
 * question about *whether* and every write of the ownership columns is answered here:
 *
 * 1. **Which changes are written back** ({@link ownerChangeWritesBack}): a change the platform made
 *    (`source: platform` — a command or a pick) that names somebody. A tracker sync is the tracker's
 *    own answer, and a release (`null`) writes nothing: the platform never unassigns a person
 *    (TD-029 decision 5).
 * 2. **Whether it is still due when the duty fires** ({@link ownerWriteBackStillDue}): the task's
 *    owner and the instant of its last change still equal the event's (TD-004: a job cannot be
 *    cancelled). A platform assignment to Bob followed by a tracker change to Carol is a different
 *    owner, and a later change back to Bob is a different instant, so neither writes Bob.
 * 3. **The stored assignee is set before the call** ({@link presetTicketAssignee}): the tracker
 *    assignee the platform last read (`ticket_assignee`) becomes the identity the call writes, so the
 *    sync that reads the call's own result back compares equal and changes nothing (rule 1 of
 *    `owner.ts`). The owner, its source and its instant are untouched.
 * 4. **A refusal puts the previous value back** ({@link restoreTicketAssignee}), only while the
 *    column still holds the intended identity: a read that replaced it meanwhile is newer than both.
 *
 * Nothing here reads a clock or a row.
 */
import type { Id, IsoDateTime, TaskOwnerSource, TicketAssignee } from '@platform/contracts';
import { type OwnershipDecision, sameTicketAssignee, type TaskOwnership } from './owner.js';

/**
 * Whether a recorded owner change asks for the write-back: made by the platform and naming a person.
 * The binding's switch is the caller's other question.
 */
export const ownerChangeWritesBack = (change: {
  readonly ownerUserId: Id | null;
  readonly source: TaskOwnerSource;
}): boolean => change.source === 'platform' && change.ownerUserId !== null;

/** Two instants are the same instant, whatever their spelling (a row reads back at milliseconds). */
const sameInstant = (left: string, right: string): boolean => {
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && a === b;
};

/** Why a write-back the duty was woken for is not made. */
export type OwnerWriteBackSkip =
  /** The owner is somebody else now — a tracker change, a command or a pick since the event. */
  | 'owner_changed'
  /** The same owner, set again since: the later change's own wake-up writes it. */
  | 'owner_changed_again'
  /** The current owner was not set by the platform (a tracker sync or a link since). */
  | 'owner_not_platform';

/**
 * The duty's re-validation on fire (TD-004): `null` when the change the event recorded is still the
 * task's latest — the same owner, set by the platform, at the same instant — and otherwise why not.
 */
export const ownerWriteBackStillDue = (
  current: TaskOwnership,
  event: { readonly ownerUserId: Id; readonly ownerChangedAt: IsoDateTime },
): OwnerWriteBackSkip | null => {
  if (current.ownerUserId !== event.ownerUserId) {
    return 'owner_changed';
  }
  if (current.ownerSource !== 'platform') {
    return 'owner_not_platform';
  }
  if (
    current.ownerChangedAt === null ||
    !sameInstant(current.ownerChangedAt, event.ownerChangedAt)
  ) {
    return 'owner_changed_again';
  }
  return null;
};

/**
 * The stored assignee the write-back writes: the owner's `person` identity for the ticket's
 * provider. The display name is **not** stored — it is shown only for an assignee the platform
 * cannot map, which a linked owner is not, and the next tracker read that names this identity keeps
 * whatever this wrote (rule 1 of `owner.ts`), so a name here would be one more stored copy of text
 * nobody reads.
 */
export const intendedTicketAssignee = (identity: {
  readonly provider: string;
  readonly externalId: string;
}): TicketAssignee => ({
  provider: identity.provider.slice(0, 255),
  external_id: identity.externalId.slice(0, 255),
  display_name: null,
  platform: false,
});

/**
 * Before the call: `ticket_assignee` := the intended identity. `unchanged` when it already names
 * that identity (the tracker read it, or an earlier try of the same duty set it).
 */
export const presetTicketAssignee = (
  current: TaskOwnership,
  intended: TicketAssignee,
): OwnershipDecision =>
  sameTicketAssignee(current.ticketAssignee, intended)
    ? { kind: 'unchanged' }
    : { kind: 'write', next: { ...current, ticketAssignee: intended }, change: null };

/**
 * After a refused call: the value the preset replaced, back — only while the column still names the
 * intended identity, so a tracker read that replaced it since is never overwritten. `unchanged` when
 * nothing was replaced.
 */
export const restoreTicketAssignee = (
  current: TaskOwnership,
  write: { readonly intended: TicketAssignee; readonly previous: TicketAssignee | null },
): OwnershipDecision =>
  !sameTicketAssignee(current.ticketAssignee, write.intended) ||
  sameTicketAssignee(write.previous, write.intended)
    ? { kind: 'unchanged' }
    : { kind: 'write', next: { ...current, ticketAssignee: write.previous }, change: null };
