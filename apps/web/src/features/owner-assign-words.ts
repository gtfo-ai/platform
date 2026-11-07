/**
 * **The words of *Assign…*** (S-26.8b's follow-up, the M26 UX spec § 2). A module of their own,
 * imported only by the lazy owner dialogs (`./task-owner-dialogs.tsx`), and deliberately not
 * `ui/humanize.ts`: that module also ships on the remote worker's local page, which never assigns
 * a task (BACKLOG 1299), and these words then stay out of the initial graph too.
 *
 * Every sentence that names a person is built in parts, because a name is text somebody else wrote
 * and the caller renders it through `UntrustedText`:
 *
 * - *Assign DEMO-1 to Petra?* — the question, around the chosen person;
 * - *Vojtěch's machine stops getting it.* — when somebody else owns it now (*Your machine…* when
 *   the reader does);
 * - *This also assigns DEMO-1 in Jira to Petra, replacing Jan Novák.* — only when that candidate's
 *   `writes_back` is true, with *replacing …* when the tracker shows somebody;
 * - *Jira still shows Jan Novák.* — when it is false and the tracker shows somebody, so nobody
 *   reads the platform's owner as the tracker's.
 */
export const ASSIGN_WORDS = {
  ask: {
    before: (ticketKey: string): string => `Assign ${ticketKey} to `,
    end: '?',
  },
  stops: {
    /** After the current owner's name. */
    after: '’s machine stops getting it.',
    you: 'Your machine stops getting it.',
  },
  also: {
    before: (ticketKey: string, tracker: string): string =>
      `This also assigns ${ticketKey} in ${tracker} to `,
    replacing: ', replacing ',
    /** The tracker shows an assignee it sent no name for. */
    nameless: 'its current assignee there',
    end: '.',
  },
  untouched: {
    before: (tracker: string): string => `${tracker} still shows `,
    nameless: 'someone else',
    end: '.',
  },
  /** Why the list is empty: who may own a task is the owner command's rule. */
  empty:
    'Nobody else in this project can own tasks: owning one takes the member role or above here.',
  loading: 'Reading who can own it…',
  unreadable: 'The people who can own it could not be read.',
} as const;
