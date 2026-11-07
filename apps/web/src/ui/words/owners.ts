/**
 * **A task's owner, and the tracker that may hold its ticket** (S-26.8b, S-26.8a) — the board,
 * the task page and the ticket lifecycle setting.
 *
 * A module of its own since S-25.13: only lazy screens show these words, and `ui/humanize.ts` —
 * which the SPA's first paint imports — does **not** re-export them, because a re-export would put
 * them back in the initial graph (TD-013's budget, `bundle:check`). Screens import this module.
 */

// A tracker's name (`trackerName`) is `./trackers.ts`' since S-25.15 part B: Home's first paint
// draws it, and this module is a lazy screen's.
import { TRACKER_NAME } from './trackers.js';

export { trackerName } from './trackers.js';

// ── A task's owner (S-26.8b, the M26 UX spec §§ 2–3) ─────────────────────────

/** The board's owner filter (`?owner=`): *Everyone* is the absence of one. */
export type BoardOwnerFilter = 'all' | 'me' | 'none';

/**
 * **The owner's words** (the M26 UX spec § 2, S-26.8b's keys). The person-facing word is
 * *machine*, never *claim*, *offer* or *seat* (§ 4). A name is passed in already sanitised by the
 * caller where it lands in an attribute or a dialog title; where it is rendered as a node, the
 * caller renders the parts around an `UntrustedText` (`assigned_in_tracker_unlinked`).
 */
export const OWNER_WORDS = {
  'owner.unassigned': 'Unassigned',
  /** "Assigned in Jira to *Jan Novák* (not linked to a platform account)", around the name. */
  'owner.assigned_in_tracker_unlinked': {
    before: (tracker: string): string => `Assigned in ${tracker} to `,
    /** The tracker sent no display name. */
    nameless: 'someone',
    after: ' (not linked to a platform account)',
  },
  'owner.took': 'Assigned to you. Your machine picks it up at the next stage.',
  'owner.assigned': (name: string): string =>
    `Assigned to ${name}. Their machine picks it up at the next stage.`,
  /** The title of a refused owner change, wherever it is shown. */
  'owner.refused': 'The owner was not changed.',
  /**
   * After *Unassign*. Unassigning **never** writes to the tracker (TD-031's amendment item 4), so
   * the words never claim a tracker change; where the project writes assignments back
   * (`owner_writes_back`), they say the ticket keeps its assignee there.
   */
  'owner.unassigned_done': (trackerKeeps: string | null): string =>
    trackerKeeps === null
      ? 'Unassigned. A machine that takes unassigned tasks picks it up at the next stage.'
      : `Unassigned. The ticket stays assigned in ${trackerKeeps}. A machine that takes unassigned tasks picks it up at the next stage.`,
  /** The header's line: "Owner: Vojtěch". */
  'owner.label': (name: string): string => `Owner: ${name}`,
  /** The owner is the reader. */
  'owner.you': ' (you)',
  /** An owner whose account has no name. */
  'owner.nameless': 'a person with no name',
  /**
   * *Take it* on a task somebody else owns (§ 2): the confirmation names them. Its sentence is
   * built in parts, because a tracker assignee it replaces is provider text the caller renders
   * through `UntrustedText`: *Their machine stops getting it*, then — when the project writes the
   * assignment back — *, and this also assigns DEMO-1 in Jira*, then *, replacing Jan Novák* when
   * the tracker shows somebody the platform cannot link, then the full stop.
   */
  'owner.take_from': {
    title: (ticketKey: string, owner: string): string => `Take ${ticketKey} from ${owner}?`,
    stops: 'Their machine stops getting it',
    also: (ticketKey: string, tracker: string): string =>
      `, and this also assigns ${ticketKey} in ${tracker}`,
    replacing: ', replacing ',
    end: '.',
    confirm: (owner: string): string => `Take it from ${owner}`,
    keep: 'Cancel',
  },
  /**
   * *Take it* on a task nobody owns that the tracker assigns to a person the platform cannot link,
   * when the project writes the assignment back (S-26.3): taking it reassigns the ticket there.
   * "Take DEMO-2? This also assigns DEMO-2 in Jira to you, replacing *Jan Novák*."
   */
  'owner.take_held': {
    title: (ticketKey: string): string => `Take ${ticketKey}?`,
    before: (ticketKey: string, tracker: string): string =>
      `This also assigns ${ticketKey} in ${tracker} to you, replacing `,
    /** The tracker sent no display name. */
    nameless: 'its current assignee there',
    end: '.',
    confirm: (tracker: string): string => `Take it and assign in ${tracker}`,
  },
  'owner.action.take': 'Take it',
  'owner.action.assign': 'Assign…',
  'owner.action.unassign': 'Unassign',
  'owner.action.link': 'Link account…',
  /**
   * The person picker (§ 2's *Assign…*). Its other words — what choosing a person does, the empty
   * list, the read — are `features/owner-assign-words.ts`, which only the SPA's lazy owner dialogs
   * import, so the picker's words stay out of the initial graph.
   */
  'owner.picker': {
    title: (ticketKey: string): string => `Assign ${ticketKey}`,
    description: 'Their machine picks it up at the next stage.',
    label: 'Person',
    confirm: 'Assign',
    current: ' (owner now)',
  },
  /** The board's segmented control (§ 3), and what an empty filtered board says. */
  'owner.filter': {
    label: 'Whose tasks',
    all: 'Everyone',
    me: 'Mine',
    none: 'Unassigned',
    empty_me: 'No task here is assigned to you.',
    empty_none: 'Every task here has an owner.',
  },
  /** The card's avatar: its accessible name and its tooltip. */
  'owner.card': (name: string): string => `Owner: ${name}`,
} as const;

/**
 * **Assign the owner in the tracker** (S-26.8a, product/06's M26 amendment): the ticket lifecycle's
 * third switch, the write-back S-26.3 performs. `help` takes the tracker binding's `provider` id and
 * names the tracker as {@link trackerName} does — *the tracker* for one this build does not name.
 */
export const ASSIGN_OWNER_WORDS = {
  label: 'Assign the owner in the tracker',
  help: (provider: string): string => {
    const name = Object.hasOwn(TRACKER_NAME, provider) ? TRACKER_NAME[provider] : undefined;
    return name === undefined
      ? 'When someone takes or is assigned a task here, also assign the ticket to them in the tracker. Only people who linked their tracker account are assigned there.'
      : `When someone takes or is assigned a task here, also assign the ticket to them in ${name}. Only people who linked their ${name} account are assigned there.`;
  },
} as const;
