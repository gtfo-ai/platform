/**
 * **Why a task waits, in words** (S-26.8b part 2, the M26 UX spec § 4): the `waiting` field the
 * task read, every board item and every `/api/org/agents` row carry (S-26.5's `offerWaitingSchema`),
 * worded as the sub-label of the `waiting` activity.
 *
 * - **The long form** ({@link waitingLong}) is the task page's: its header's *Now* line and its
 *   callout. "Waiting for Vojtěch’s machine. It’s offline (last seen 2 h ago)."
 * - **The short form** ({@link waitingShort}) is a board card's and an Agents or Home row's:
 *   "Waiting · Vojtěch’s machine is offline". {@link waitingTail} is the same without its
 *   "Waiting · " lead, for a place that already says *waiting* (the activity's sub-label).
 * - `reason: null` means somebody can take it now, and `waiting: null` that nothing waits: both
 *   say nothing ({@link waitingReason} is `null`), so no surface invents a reason.
 * - **The reader is the person the reason is about** (`waiting.user`): *your machine*, *you*.
 * - `owner_worker_cannot_take` names the **first** blocker only (the server sorts them
 *   most-fundamental-first); the six the claim can raise there have words of their own
 *   ({@link CANNOT_TAKE_KIND}), and any other key falls to the Workers screen's own vocabulary
 *   (`WORKER_CLAIM_BLOCKER_WORDS`, a `Record` over every key), so the type system covers it.
 *
 * Every name — the owner's, the tracker assignee's, the project's — is somebody's own text: a part
 * of the sentence is either platform text (a `string`) or `{ untrusted }`, which
 * {@link WaitingWords} renders through `UntrustedText` and {@link waitingPlain} sanitises for a
 * place that takes a string (a `PhaseTrack` sub-label, an accessible name). The person-facing word
 * is *machine*; never *claim*, *offer* or *seat*.
 *
 * A module of the SPA's: the worker's local page never imports it (`ui/words/*` is that page's).
 */
import type { OfferWaiting, WorkerClaimBlocker } from '@platform/contracts';
import { Fragment, type ReactElement } from 'react';
import { WORKSPACE_CAUSE_SHORT, wordInSentence } from '../ui/humanize.js';
import { formatAgo } from '../ui/relative-time.js';
import { UntrustedText } from '../ui/untrusted.js';
import { sanitiseUntrusted } from '../ui/untrusted-text.js';
import { WORKER_CLAIM_BLOCKER_WORDS } from '../ui/words/worker-blockers.js';

/** A piece of a waiting sentence: the platform's words, or somebody's own text. */
export type WaitingPart = string | { readonly untrusted: string };

export type WaitingReason = NonNullable<OfferWaiting['reason']>;

/** The reason to word, or `null` when there is none: no open offer, or somebody can take it now. */
export const waitingReason = (waiting: OfferWaiting | null | undefined): WaitingReason | null =>
  waiting?.reason ?? null;

/** What the sentences need besides the field: who reads them, the clock, where the task is. */
export interface WaitingContext {
  /** The signed-in person's user id: *your machine* when the reason is about them. */
  readonly viewerId: string | null;
  /** Epoch milliseconds, for "last seen 2 h ago". */
  readonly nowMs: number;
  /** The project's name for `no_taker` ("in Autix"); `null` says *this project*. */
  readonly project?: string | null;
  /** The tracker's name for `assignee_not_linked` ("assigned in Jira"). */
  readonly tracker?: string;
}

/** What an `owner_worker_cannot_take` sentence says, by its first blocker. */
export type CannotTakeKind =
  | 'update'
  | 'setting_up'
  | 'finishing'
  | 'usage_limit'
  | 'platform'
  | 'other'
  | 'none';

/** The blockers the claim raises for a connected machine that would take the task. */
export const CANNOT_TAKE_KIND: Readonly<Partial<Record<WorkerClaimBlocker, CannotTakeKind>>> = {
  images_outdated: 'update',
  protocol_outdated: 'update',
  images_missing: 'setting_up',
  // Set by an update **or** by the owner's own Drain, so its words never say "update".
  draining: 'finishing',
  usage_limited: 'usage_limit',
  platform_images_unresolved: 'platform',
};

/** The first blocker's kind; `none` when the refusal is the offer's or the project's. */
export const cannotTakeKind = (blockers: readonly WorkerClaimBlocker[]): CannotTakeKind => {
  const [first] = blockers;
  return first === undefined ? 'none' : (CANNOT_TAKE_KIND[first] ?? 'other');
};

/** Whether the reason is about the reader. */
export const aboutReader = (waiting: OfferWaiting, viewerId: string | null): boolean =>
  waiting.user !== null && viewerId !== null && waiting.user.user_id === viewerId;

/**
 * The person, as a part: their name — or *its owner* when the read names nobody or the account has
 * no name, so a sentence never reads "Waiting for ’s machine".
 */
const person = (waiting: OfferWaiting): WaitingPart =>
  waiting.user === null || waiting.user.name.trim() === ''
    ? 'its owner'
    : { untrusted: waiting.user.name };

/** "Vojtěch’s machine", "your machine". */
const machine = (waiting: OfferWaiting, viewerId: string | null): readonly WaitingPart[] =>
  aboutReader(waiting, viewerId) ? ['your machine'] : [person(waiting), '’s machine'];

const CANNOT_TAKE_LONG: Readonly<Record<Exclude<CannotTakeKind, 'other'>, string>> = {
  update: 'It’s online but needs an update before it can take this task.',
  setting_up: 'It’s online but is still getting its run images.',
  finishing: 'It’s finishing its current run and taking nothing new.',
  usage_limit: 'It has reached its Claude usage limit and resumes when the limit resets.',
  platform: 'It can’t take this task until the platform’s run images are fixed.',
  none: 'It’s online but can’t take this task now.',
};

const CANNOT_TAKE_SHORT: Readonly<Record<CannotTakeKind, string>> = {
  update: ' needs an update',
  setting_up: ' is still setting up',
  finishing: ' is finishing a run',
  usage_limit: ' is at its usage limit',
  platform: ' waits on the platform',
  other: ' can’t take it',
  none: ' can’t take it now',
};

/** "It’s offline (last seen 2 h ago)." — or that it never connected. */
const offline = (lastSeen: string | null, nowMs: number): string => {
  if (lastSeen === null) {
    return 'It’s offline and has never connected.';
  }
  const ago = formatAgo(lastSeen, nowMs);
  return ago === null ? 'It’s offline.' : `It’s offline (last seen ${ago}).`;
};

/** The task page's sentence, or `null` when nothing is to be said. */
export const waitingLong = (
  waiting: OfferWaiting | null | undefined,
  context: WaitingContext,
): readonly WaitingPart[] | null => {
  const reason = waitingReason(waiting);
  if (waiting === null || waiting === undefined || reason === null) {
    return null;
  }
  const you = aboutReader(waiting, context.viewerId);
  const forMachine = ['Waiting for ', ...machine(waiting, context.viewerId), '. '];
  switch (reason) {
    case 'owner_worker_offline':
      return [...forMachine, offline(waiting.last_seen_at, context.nowMs)];
    case 'owner_worker_paused':
      return [...forMachine, 'It’s paused.'];
    case 'owner_no_worker':
      return you
        ? ['Waiting for you. You have no machine that takes this project.']
        : ['Waiting for ', person(waiting), '. They have no machine that takes this project.'];
    case 'owner_pick_only':
      return you
        ? ['Waiting for you to pick it on your machine.']
        : ['Waiting for ', person(waiting), ' to pick it on their machine.'];
    case 'no_taker':
      return [
        'Waiting: no machine takes unassigned tasks in ',
        context.project === null || context.project === undefined
          ? 'this project'
          : { untrusted: context.project },
        '.',
      ];
    case 'assignee_not_linked':
      return [
        `Waiting for a machine that takes everyone’s tasks. It’s assigned in ${context.tracker ?? 'the tracker'} to `,
        waiting.assignee_name === null ? 'someone' : { untrusted: waiting.assignee_name },
        ', who isn’t linked to a platform account.',
      ];
    case 'owner_worker_cannot_take': {
      const kind = cannotTakeKind(waiting.blockers);
      const [first] = waiting.blockers;
      if (first === 'workspace_unavailable' && waiting.workspace_cause !== undefined) {
        // S-28.12: which machine, and why it cannot start runs.
        return [
          ...forMachine,
          `It can’t start runs: ${WORKSPACE_CAUSE_SHORT[waiting.workspace_cause]}. It tries again by itself; its owner can press Try again on its page once it is fixed.`,
        ];
      }
      return [
        ...forMachine,
        kind === 'other' && first !== undefined
          ? `It’s online but can’t take this task (${wordInSentence(WORKER_CLAIM_BLOCKER_WORDS[first].word)}).`
          : CANNOT_TAKE_LONG[kind === 'other' ? 'none' : kind],
      ];
    }
  }
};

/**
 * The short form without its "Waiting · " lead — the `waiting` activity's sub-label ("Vojtěch’s
 * machine is offline"), where the activity's own word already says *waiting*.
 */
export const waitingTail = (
  waiting: OfferWaiting | null | undefined,
  viewerId: string | null,
): readonly WaitingPart[] | null => {
  const reason = waitingReason(waiting);
  if (waiting === null || waiting === undefined || reason === null) {
    return null;
  }
  const you = aboutReader(waiting, viewerId);
  const owned = machine(waiting, viewerId);
  switch (reason) {
    case 'owner_worker_offline':
      return [...owned, ' is offline'];
    case 'owner_worker_paused':
      return [...owned, ' is paused'];
    case 'owner_no_worker':
      return you ? ['you have no machine for it'] : [person(waiting), ' has no machine for it'];
    case 'owner_pick_only':
      return you
        ? ['your machine takes only what you pick']
        : [...owned, ' takes only what they pick'];
    case 'no_taker':
      return ['no machine takes it'];
    case 'assignee_not_linked':
      return [
        'assigned to ',
        waiting.assignee_name === null ? 'someone' : { untrusted: waiting.assignee_name },
        ' (not linked)',
      ];
    case 'owner_worker_cannot_take':
      return [...owned, CANNOT_TAKE_SHORT[cannotTakeKind(waiting.blockers)]];
  }
};

/** A card's and a row's line: "Waiting · Vojtěch’s machine is offline". */
export const waitingShort = (
  waiting: OfferWaiting | null | undefined,
  viewerId: string | null,
): readonly WaitingPart[] | null => {
  const tail = waitingTail(waiting, viewerId);
  return tail === null ? null : ['Waiting · ', ...tail];
};

/** A sentence as one string, every name sanitised — for a prop that takes text, not nodes. */
export const waitingPlain = (parts: readonly WaitingPart[]): string =>
  parts
    .map((part) => (typeof part === 'string' ? part : sanitiseUntrusted(part.untrusted)))
    .join('');

/** A sentence as nodes: the platform's words as text, every name through `UntrustedText`. */
export const WaitingWords = ({
  parts,
}: {
  readonly parts: readonly WaitingPart[];
}): ReactElement => (
  <>
    {parts.map((part, index) => (
      // biome-ignore lint/suspicious/noArrayIndexKey: the parts are positional and never reordered.
      <Fragment key={index}>
        {typeof part === 'string' ? part : <UntrustedText value={part.untrusted} />}
      </Fragment>
    ))}
  </>
);

/**
 * Which next steps the reason calls for, beside *Take it* / *Assign…* (those are the read's own
 * `can_take` / `can_assign`, the owner control's):
 *
 * - `workers` — *Open Workers*, for **the machine's owner** only, on a machine-side reason: the
 *   machine is offline or paused, they have none for the project or it takes only what they pick,
 *   or it can't take this task for a reason on the machine (an update, its images, another
 *   blocker). Never for a machine that is finishing a run or at its usage limit (nothing to do) or
 *   one that waits on the platform;
 * - `update` — with it, "Update it from its page." for a machine that needs an update;
 * - `instance` — *Open Instance*, for an **administrator**, when the platform's run images are what
 *   it waits on;
 * - `link` — *Link account…*, for an **administrator** (Linked accounts is theirs), when the
 *   tracker assignee is not linked.
 */
export interface WaitingSteps {
  readonly workers: boolean;
  readonly update: boolean;
  readonly instance: boolean;
  readonly link: boolean;
}

const NO_STEPS: WaitingSteps = { workers: false, update: false, instance: false, link: false };

const MACHINE_SIDE: ReadonlySet<WaitingReason> = new Set<WaitingReason>([
  'owner_worker_offline',
  'owner_worker_paused',
  'owner_no_worker',
  'owner_pick_only',
]);

const MACHINE_SIDE_CANNOT_TAKE: ReadonlySet<CannotTakeKind> = new Set<CannotTakeKind>([
  'update',
  'setting_up',
  'other',
]);

export const waitingSteps = (
  waiting: OfferWaiting | null | undefined,
  viewerId: string | null,
  /** The reader may open the administrator's screens (Linked accounts, Instance). */
  admin: boolean,
): WaitingSteps => {
  const reason = waitingReason(waiting);
  if (waiting === null || waiting === undefined || reason === null) {
    return NO_STEPS;
  }
  const owner = aboutReader(waiting, viewerId);
  const kind = reason === 'owner_worker_cannot_take' ? cannotTakeKind(waiting.blockers) : null;
  return {
    workers:
      owner && (MACHINE_SIDE.has(reason) || (kind !== null && MACHINE_SIDE_CANNOT_TAKE.has(kind))),
    update: owner && kind === 'update',
    instance: admin && kind === 'platform',
    link: admin && reason === 'assignee_not_linked',
  };
};
