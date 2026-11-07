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
 *   so no agent started on it.", and "Vojtěch Kaizr isn't a linked member of this project." when
 *   `user_id` is `null` — which is both a person with no linked account and a linked one below
 *   `member` (BACKLOG 1361), so the words say what is true of both; "…to someone else" when the
 *   platform knows no name. The tracker's word is `trackerName` (Jira, GitLab, *the tracker*), the
 *   one #103's words use.
 * - **What an owner changes** ({@link heldElsewhereOwnedWords}): the task can be given back. Since
 *   TD-031's 2026-11-07 amendment (item 5, #117) the claim **keeps** a ticket for an owner set on
 *   the platform (`held_by: 'platform_owner'`) while the tracker still names somebody else, so
 *   *Give it back to the agent* is offered as soon as the task has an owner — no longer only once
 *   `unlinked_assignee` is `null`. A take or an assignment still does not change the tracker's
 *   assignee by itself (`decideOwnerCommand`'s rule 1), so while it names somebody else the words
 *   say what the tracker shows, and that it does not stop the agent: the write-back landing
 *   (`owner_writes_back`), or the other person until somebody changes the ticket there.
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
  /** "Vojtěch Kaizr isn't a linked member of this project."; `null` for a linked or nameless one. */
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
      ? [{ untrusted: holder.name }, ' isn’t a linked member of this project.']
      : null,
});

/**
 * Once the task has an owner, what the box says (review of #115, S-25.15 part B): that giving it
 * back runs the stage again, and — only while it is true — what the tracker shows. `ready`: the
 * tracker no longer names somebody the platform cannot hand the ticket to (`unlinked_assignee` is
 * `null`); `writing_back`: the owner is being assigned there (`owner_writes_back`), and the next
 * read clears `unlinked_assignee` once it has landed; `held`: the tracker still names the other
 * person, which no longer stops the agent (the claim keeps the ticket for the owner, TD-031 item 5).
 */
export interface HeldElsewhereOwned {
  readonly kind: 'ready' | 'writing_back' | 'held';
  readonly words: readonly WaitingPart[];
}

export const heldElsewhereOwnedWords = (input: {
  readonly tracker: string;
  /** The owner's name as the page says it (`ownerName`), somebody's own text. */
  readonly ownerName: string;
  readonly holder: TicketHolder;
  readonly unlinkedAssignee: boolean;
  readonly ownerWritesBack: boolean;
}): HeldElsewhereOwned => {
  const ready =
    'It has an owner now. Give it back to the agent and it runs the stage it stopped at again.';
  if (!input.unlinkedAssignee) {
    return { kind: 'ready', words: [ready] };
  }
  if (input.ownerWritesBack) {
    return {
      kind: 'writing_back',
      words: [
        `${ready} ${input.tracker} is being assigned to `,
        { untrusted: input.ownerName },
        '.',
      ],
    };
  }
  return {
    kind: 'held',
    words: [
      `${ready} ${input.tracker} still shows `,
      input.holder.name === null ? 'someone else' : { untrusted: input.holder.name },
      ', which doesn’t stop the agent.',
    ],
  };
};

/** The words of the ways out that are not the owner control's (`OWNER_WORDS`). */
export const HELD_ELSEWHERE_WORDS = {
  open: (tracker: string): string => `Open in ${tracker}`,
  /** Once an owner is set (the claim keeps the ticket for them): `resume`, the stage it stopped at. */
  handBack: 'Give it back to the agent',
  cancel: 'Cancel task…',
  details: 'Details',
} as const;
