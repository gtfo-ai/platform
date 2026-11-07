/**
 * **A ticket someone else holds, in words** (S-25.14, product/10's Task detail amendment of
 * 2026-11-07; the owner's AUT-6676, AUT-6795 and AUT-6746): the needs-you callout's sentence for a
 * task that stopped because its ticket is assigned to somebody else in the tracker.
 *
 * - **Which stop it is** ({@link heldElsewhereStop}) is the escalation's `reason` **key**,
 *   `ticket_assigned_elsewhere`, while the task is `needs_human` — never a reading of the brief,
 *   which is platform text that may quote a provider and stays under *Details*.
 * - **Whose ticket it is** ({@link ticketHolder}) is the task's `tracker_assignee` — the person
 *   the tracker shows, with the platform user they are, or `null` for somebody the platform cannot
 *   link (or who may not own tasks in the project) — and `unlinked_assignee` for the name when the
 *   read has no `tracker_assignee`. A blank name is no name.
 * - **The sentence** ({@link heldElsewhereWords}): "AUT-6676 is assigned in Jira to Vojtěch Kaizr,
 *   so no agent started on it.", and "Vojtěch Kaizr has no linked platform account." when the
 *   person is not linked; "…to someone else" when the platform knows no name. The tracker's word is
 *   `trackerName` (Jira, GitLab, *the tracker*), the one #103's words use.
 *
 * Every name and the ticket key are somebody's own text: a part is platform text (a `string`) or
 * `{ untrusted }`, rendered by `WaitingWords` through `UntrustedText` (BD-022). The words live here,
 * in the task page's lazy chunk, rather than in `ui/humanize.ts`, which is in the initial graph.
 * The person-facing words never say *claim*, *offer* or *seat*.
 */
import type { TaskDetailResponse, TaskRecord } from '@platform/contracts';
import type { WaitingPart } from './waiting-words.js';

/** The escalation reason key this stop is (TD-029 decision 5's refusal). */
export const TICKET_ASSIGNED_ELSEWHERE = 'ticket_assigned_elsewhere';

/** Whether the task waits for a person because its ticket is assigned to somebody else. */
export const heldElsewhereStop = (detail: {
  readonly task: Pick<TaskRecord, 'state'>;
  readonly escalation: TaskDetailResponse['escalation'];
}): boolean =>
  detail.task.state === 'needs_human' && detail.escalation?.reason === TICKET_ASSIGNED_ELSEWHERE;

/** Who holds the ticket: the name the tracker sent (or none), and whether they are unlinked. */
export interface TicketHolder {
  readonly name: string | null;
  /** The platform cannot link them to a person who may own tasks in the project. */
  readonly unlinked: boolean;
}

const named = (value: string | null | undefined): string | null =>
  value === null || value === undefined || value.trim() === '' ? null : value;

export const ticketHolder = (
  task: Pick<TaskRecord, 'tracker_assignee' | 'unlinked_assignee'>,
): TicketHolder => {
  const shown = task.tracker_assignee ?? null;
  const unlinked = task.unlinked_assignee ?? null;
  return {
    name: named(shown?.display_name) ?? named(unlinked?.display_name),
    unlinked: shown === null ? unlinked !== null : shown.user_id === null,
  };
};

/** The callout's sentence, and the second one an unlinked person adds. */
export interface HeldElsewhereWords {
  readonly sentence: readonly WaitingPart[];
  /** "Vojtěch Kaizr has no linked platform account."; `null` for a linked or nameless person. */
  readonly unlinked: readonly WaitingPart[] | null;
}

export const heldElsewhereWords = (
  ticketKey: string,
  tracker: string,
  holder: TicketHolder,
): HeldElsewhereWords => ({
  sentence: [
    { untrusted: ticketKey },
    ` is assigned in ${tracker} to `,
    holder.name === null ? 'someone else' : { untrusted: holder.name },
    ', so no agent started on it.',
  ],
  unlinked:
    holder.unlinked && holder.name !== null
      ? [{ untrusted: holder.name }, ' has no linked platform account.']
      : null,
});

/** The words of the ways out that are not the owner control's (`OWNER_WORDS`). */
export const HELD_ELSEWHERE_WORDS = {
  open: (tracker: string): string => `Open in ${tracker}`,
  /** After an owner is set: the task goes back to the stage it stopped at (`resume`). */
  owned:
    'It has an owner now. Give it back to the agent and it runs the stage it stopped at again.',
  handBack: 'Give it back to the agent',
  cancel: 'Cancel task…',
  details: 'Details',
} as const;
