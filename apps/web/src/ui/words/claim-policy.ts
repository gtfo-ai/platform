/**
 * **What a machine takes, and picks on its page** (the M26 UX spec § 1 and § 6, S-26.7).
 *
 * A module of its own, re-exported unchanged by `ui/humanize.ts` (the screens import it from there):
 * the worker's local page imports **this** module and never `humanize.ts`, so its 120 kB entry
 * carries only the words it shows — `worker/import-graph.test.ts` holds that (BACKLOG 1455).
 */
import type { WorkerClaimPolicy } from '@platform/contracts';

/** One option of *Which tasks*: its outcome as the label, and one line of help. */
export interface ClaimPolicyOptionWords {
  readonly label: string;
  readonly help: string;
}

/**
 * Project names in a sentence: up to three ("Autix", "Autix and Fontai", "Autix, Fontai and
 * Kiwi"), then two and the rest counted ("Autix, Fontai +2") — the spec's example, which never shows
 * more than three items. The names are untrusted: the caller renders the result as text.
 */
export const projectListWords = (names: readonly string[]): string =>
  names.length > 3
    ? `${names[0]}, ${names[1]} +${names.length - 2}`
    : names.length > 1
      ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
      : (names[0] ?? '');

/**
 * **What this machine takes** (the M26 UX spec § 1): the card's words, the four options in the
 * spec's order (the default first), and the sentence's pieces. The person-facing word is
 * *machine*, never *claim*, *offer* or *seat*. A function's argument is untrusted text (project
 * names): its result is rendered through `UntrustedText`.
 */
export const MACHINE_TAKES_WORDS = {
  title: 'What this machine takes',
  change: 'Change',
  cancel: 'Cancel',
  save: 'Save',
  saved: 'Saved · applies to the next run',
  /** A refused save's title, the page's own words for a refusal. */
  refused: 'That did not work',
  whichTasks: 'Which tasks',
  whichProjects: 'In which projects',
  projectsAll: 'All projects you can see',
  projectsSome: 'Only these:',
  noneChosen: 'Choose at least one project.',
  noProjects: 'Ask an administrator to add you to a project.',
  /** In the spec's order: the default first. */
  options: {
    mine_and_unassigned: {
      label: 'My tasks and unassigned ones',
      help: 'Runs tasks assigned to you, and tasks nobody owns yet.',
    },
    mine: {
      label: 'Only my tasks',
      help: 'Runs only tasks assigned to you. Unassigned tasks wait for another machine or the server.',
    },
    everything: {
      label: 'Everything',
      help: 'Runs any task in the projects below, including tasks assigned to someone else.',
    },
    pick_only: {
      label: 'Only what I pick',
      help: 'Takes nothing by itself. You choose each run on this page, and choosing one assigns the task to you.',
    },
  } satisfies Readonly<Record<WorkerClaimPolicy, ClaimPolicyOptionWords>>,
  /** The sentence's emphasised half: what the machine takes. */
  what: {
    mine_and_unassigned: 'your tasks and unassigned ones',
    mine: 'only your tasks',
    everything: 'every task',
    pick_only: 'nothing by itself',
  } satisfies Readonly<Record<WorkerClaimPolicy, string>>,
  /** "This machine takes **…**, in **…**." */
  start: 'This machine takes ',
  in: ', in ',
  allProjects: 'all your projects',
  end: '.',
  /** *Only what I pick*: "… **nothing by itself**. You pick runs on its page (**Autix** only)." */
  pick: '. You pick runs on its page',
  pickIn: ' (',
  pickOnly: ' only)',
  /** A stored project the person can no longer see. */
  projectLeft: 'a project you left',
  /** The consequence line. */
  nowhere: (projects: string): string => `Unassigned tasks in ${projects} have nowhere to run.`,
} as const;

/**
 * **Picking on the machine's page** (the M26 UX spec § 6). A pick of a task nobody owns assigns it
 * to the reader; a task somebody else owns is not offered; the core's two refusals
 * (`task_taken_by_another`, `task_owned_by_another`) name the owner. A function's arguments are
 * untrusted text (a person's name, a ticket key): its result is rendered through `UntrustedText`.
 */
export const PICK_WORDS = {
  heading: 'Runs waiting for a machine',
  take: 'Take this one',
  runHere: 'Run it here',
  assigns: (ticket: string): string => `Assigns ${ticket} to you.`,
  takenAssigned: 'Assigned to you · starting on this machine…',
  taken: 'Starting on this machine…',
  /** "Vojtěch’s task": nothing to press. */
  someones: (name: string): string => `${name}’s task`,
  /** An ask this machine's person asked (BACKLOG 1432: an ask is labelled by its asker). */
  yourQuestion: ' · Your question',
  automatic: ' · this machine would take it by itself',
  takenByAnother: (name: string, ticket: string): string =>
    `${name} took ${ticket} a moment ago. Pick another.`,
  ownedByAnother: (name: string, ticket: string): string =>
    `${ticket} is ${name}’s. A maintainer can reassign it on the task page.`,
  /** The refusal named nobody (a person with no name, or an answer without its owner). */
  namelessStart: 'Another person',
  nameless: 'another person',
  thisTask: 'this task',
  noLonger: 'That run is no longer this machine’s to take.',
} as const;
