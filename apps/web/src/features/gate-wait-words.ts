/**
 * The held manual job in a person's words (S-25.12), in a module of its own so Home — in the
 * initial graph — and the Inbox can say it without `./gate-wait.tsx`, the task page's.
 *
 * The job's name is provider text (BD-022): the caller renders the sentence as a text node.
 */

/** "CI waits for someone to start the manual job X" — the header's *Now* line and a row's title. */
export const ciHeldSentence = (heldJob: string | null): string =>
  heldJob === null
    ? 'CI waits for someone to start a manual job'
    : `CI waits for someone to start the manual job ${heldJob}`;

/**
 * A board card's short form of a held manual job (S-26.8b part 2, BACKLOG 1300): the card has no
 * room for the job's name, and the task page links it.
 */
export const CI_HELD_SHORT = 'CI held · start the job';
