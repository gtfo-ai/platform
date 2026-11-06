/**
 * A task's state in the one status vocabulary, and whether it waits on a person — one definition
 * for every screen that draws a task (S-23.9b's review: the board's card and the task page answered
 * "does it need me" separately, and two answers drift).
 *
 * **One rule, three readers** (S-25.4, product/10's 2026-11-06 Board amendment): the board's
 * *Needs you* column (`features/board.tsx`' `boardColumnOf`), the card's ◆ and the task header's
 * state label all ask {@link needsYou}, and the word they print is {@link taskStateLabel}. Before
 * it, the column read the state alone, so a task with an open question sat under *Active* while its
 * card said "Needs you 2" and its header said "Active".
 *
 * Types only from the contracts, and the words from `humanize.ts` (which has no runtime dependency
 * either), so any surface can import it.
 */
import type { TaskRecord, TaskState } from '@platform/contracts';
import { TASK_STATE_LABEL } from './humanize.js';
import type { Status } from './status.js';

/** A task's state as `StatusIcon`/`StateLabel` draw it (icon + colour + word). */
export const TASK_STATE_STATUS: Readonly<Record<TaskState, Status>> = {
  queued: 'queued',
  active: 'running',
  returned: 'running',
  waiting_answers: 'needs_you',
  waiting_approval: 'needs_you',
  paused: 'paused',
  needs_human: 'needs_you',
  ready_for_merge: 'waiting',
  merged: 'success',
  retro: 'running',
  done: 'success',
  cancelled: 'cancelled',
};

/** The states in which the pipeline is waiting on a person. */
const WAITING_ON_A_PERSON: ReadonlySet<TaskState> = new Set<TaskState>([
  'waiting_answers',
  'waiting_approval',
  'needs_human',
]);

/** What `needsYou` reads: the board's list item and the task page's record both carry it. */
export interface NeedsYouInput {
  readonly state: TaskState;
  readonly paused_reason: TaskRecord['paused_reason'];
  /** Open questions plus pending approvals. */
  readonly open_asks: number;
  /** A take-over is in force (the task page knows it beside the state). */
  readonly taken_over?: boolean;
}

/**
 * Whether the task waits on a person: a waiting state, anything open in its inbox, a take-over in
 * force, or a pause only a person ends — a budget pause (somebody raises the cap) or a take-over
 * (the person hands it back). A manual pause is somebody's choice and waits on nobody.
 */
export const needsYou = (task: NeedsYouInput): boolean =>
  WAITING_ON_A_PERSON.has(task.state) ||
  task.open_asks > 0 ||
  task.taken_over === true ||
  (task.state === 'paused' &&
    (task.paused_reason === 'budget' || task.paused_reason === 'taken_over'));

/** The status a task is drawn with: `needs_you` whenever it waits on a person, its state's otherwise. */
export const taskStatus = (task: NeedsYouInput): Status =>
  needsYou(task) ? 'needs_you' : TASK_STATE_STATUS[task.state];

/** The word for "waits on a person" when the state's own word does not say it. */
export const NEEDS_YOU_LABEL = 'Needs you';

/**
 * The word a task's state is printed with beside {@link taskStatus}'s icon: the state's own word
 * when that already says what waits (*Waiting for answers*, *Paused*), and *Needs you* when the
 * task waits on a person while its state is a stage's (an *Active* task with an open question), so
 * the word never contradicts the icon.
 */
export const taskStateLabel = (task: NeedsYouInput): string =>
  needsYou(task) && !WAITING_ON_A_PERSON.has(task.state) && task.state !== 'paused'
    ? NEEDS_YOU_LABEL
    : TASK_STATE_LABEL[task.state];
