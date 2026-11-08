/**
 * **Why a queued task has not started, in words** (S-25.16, BD-010) — the read's `queue_wait`
 * (`queueWaitSchema`): the limit the scheduler's admission refused on, the count it compared, the
 * task's place in the queue and the tasks holding the places.
 *
 * - **The column note** ({@link queueNote}) is the board's *Queued* column's, once: "Waiting for a
 *   place: this project runs at most 5 tasks at once, and 5 are in the pipeline — 5 of them wait
 *   for you. A place frees when one of them finishes or is cancelled, so decide them or cancel one."
 * - **The long form** ({@link queueSentence}) is the task page's callout: the note, then this
 *   task's place — "AUT-6862 is 2nd in the queue and starts once 2 places are free."
 * - **The short form** ({@link queueShort}) is a card's and the task page's *Now* line: "2nd in
 *   queue · 5 of 5 places taken".
 *
 * **What frees a place is said as the scheduler counts it, not as hoped**: a stopped task holds a
 * pipeline place until it **finishes or is cancelled** (`countsInPipeline`), so deciding one moves
 * it on but frees nothing by itself — the sentence says *finishes or is cancelled*, and that a
 * decision is how a stopped task gets there. A task 2nd in the queue starts after **two** places
 * free ({@link placesToFree}), never after one. `admitted` — the limits have room and the scheduler
 * has not run since — says so, and invents no wait. No *WIP* on screen: *places*.
 *
 * The ticket key is the provider's text (BD-022): a sentence that carries one is rendered through
 * `UntrustedText`. Plain functions, no React.
 */
import type { QueueWait } from '@platform/contracts';

type Waiting = Extract<QueueWait, { readonly status: 'waiting' }>;

/** The board's *Queued* column's anchor, which Home's held-queue line links to. */
export const QUEUED_COLUMN_ANCHOR = 'queued-tasks';

/** 1st, 2nd, 3rd, 4th … 11th, 12th, 13th … 21st. */
export const ordinal = (n: number): string => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) {
    return `${n}th`;
  }
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
};

/**
 * How many places must free before this task starts: the places taken past the limit (a limit
 * lowered under the tasks already in) plus its own place in the queue — the scheduler starts one
 * queued task per freed place, the head first.
 */
export const placesToFree = (wait: Waiting): number =>
  Math.max(1, wait.count - wait.limit + wait.position);

/** "5 tasks", "1 task". */
const tasks = (n: number): string => (n === 1 ? '1 task' : `${n} tasks`);

/** "1 is", "5 are". */
const are = (n: number): string => (n === 1 ? '1 is' : `${n} are`);

/** The short form: "2nd in queue · 5 of 5 places taken". */
export const queueShort = (wait: QueueWait): string => {
  const place = `${ordinal(wait.position)} in queue`;
  if (wait.status === 'admitted') {
    return `${place} · a place is free`;
  }
  return wait.reason === 'max_tasks_in_pipeline'
    ? `${place} · ${wait.count} of ${wait.limit} places taken`
    : `${place} · ${wait.count} of ${wait.limit} running`;
};

/**
 * The column note: which limit, what holds it and what frees a place — the same for every task of
 * the queue. `null` for `admitted`, which has nothing holding it.
 */
export const queueNote = (wait: QueueWait): string | null => {
  if (wait.status === 'admitted') {
    return null;
  }
  if (wait.reason === 'max_parallel_tasks') {
    return (
      `Waiting for a place: this project runs at most ${tasks(wait.limit)} at once, and ` +
      `${are(wait.count)} running. A place frees when one of them finishes, stops for a person or ` +
      'is paused.'
    );
  }
  const people = wait.holders.needs_human;
  const forYou =
    people === 0 ? '' : ` — ${people} of them ${people === 1 ? 'waits' : 'wait'} for you`;
  return (
    `Waiting for a place: this project runs at most ${tasks(wait.limit)} at once, and ` +
    `${are(wait.count)} in the pipeline${forYou}. A place frees when one of them finishes or is ` +
    `cancelled${people === 0 ? '.' : `, so decide ${people === 1 ? 'it' : 'them'} or cancel one.`}`
  );
};

/** The long form, for the task page: the note and this task's place. */
export const queueSentence = (wait: QueueWait, ticketKey: string): string => {
  if (wait.status === 'admitted') {
    return (
      `There is room under this project’s limits: the queue moves on when a task finishes, stops ` +
      `for a person, is paused or is cancelled, and ${ticketKey} is ${ordinal(wait.position)} in it.`
    );
  }
  const needed = placesToFree(wait);
  const place =
    needed === 1
      ? `${ticketKey} is next in the queue and starts then.`
      : `${ticketKey} is ${ordinal(wait.position)} in the queue and starts once ${needed} places are free.`;
  return `${queueNote(wait) ?? ''} ${place}`;
};
