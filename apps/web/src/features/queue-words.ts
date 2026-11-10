/**
 * **Why a queued task has not started, in words** (S-25.16, BD-010) — the read's `queue_wait`
 * (`queueWaitSchema`): **both** limits with their counts (`running`, `pipeline`), the one the
 * scheduler's admission refused on, the task's place in the queue and the tasks holding the places.
 *
 * - **The column note** ({@link queueNote}) is the board's *Queued* column's, once: "Waiting for a
 *   place: this project holds at most 5 tasks in its pipeline, and 5 are in it — 5 of them wait for
 *   you. A place frees when one of them finishes or is cancelled, so decide them or cancel one."
 * - **The long form** ({@link queueSentence}) is the task page's callout: the note, then this
 *   task's place — "AUT-6861 is next in the queue and starts then." or "AUT-6862 is 2nd in the
 *   queue: 1 ticket is ahead of it."
 * - **The short form** ({@link queueShort}) is a card's and the task page's *Now* line: "2nd in
 *   queue · 5 of 5 places taken".
 *
 * **What frees a place is said as the scheduler counts it, against both limits** (review of #124):
 * the scheduler checks both on every event, so the words do too ({@link queueRelief}).
 *  - The pipeline full: only a task that **finishes or is cancelled** leaves it (`countsInPipeline`)
 *    — deciding a stopped task moves it on and frees nothing by itself. When the running tasks are
 *    at their limit as well, only a **running** task finishing or being cancelled frees both.
 *  - Only the running tasks full: one that finishes, stops for a person, is paused or is cancelled.
 *  - *Starts then* is said only when one such event admits the head of the queue — the head, and
 *    each full limit exactly at its count. A task further back is told how many tickets are ahead
 *    of it, never a number of places: the queue after the head is the limits' to decide again.
 *  - `admitted` — the limits have room and the scheduler has not run since — says so, and invents
 *    no wait. No *WIP* on screen: *places*.
 *
 * The holders wait for **you** only for a reader who may decide them (`mayDecide`); anyone else is
 * told they wait for *a person*, with no instruction to decide.
 *
 * The ticket key is the provider's text (BD-022): a sentence that carries one is rendered through
 * `UntrustedText`. Plain functions, no React.
 */
import type { QueueWait } from '@platform/contracts';

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

/** "5 tasks", "1 task". */
const tasks = (n: number): string => (n === 1 ? '1 task' : `${n} tasks`);

/** "1 is", "5 are". */
const are = (n: number): string => (n === 1 ? '1 is' : `${n} are`);

const full = (limit: { readonly count: number; readonly limit: number }): boolean =>
  limit.count >= limit.limit;

/**
 * Which event frees a place the head of the queue can take:
 *  - `running_finishes` — both limits full: a running task finishes or is cancelled;
 *  - `pipeline_finishes` — the pipeline full: any of its tasks finishes or is cancelled;
 *  - `running_stops` — only the running tasks full: one finishes, stops for a person, is paused or
 *    is cancelled.
 */
export type QueueFreedBy =
  | 'running_finishes'
  | 'pipeline_finishes'
  | 'running_stops'
  /** S-28.6: the owner's own limit — one of their tasks finishes, is paused or is handed on. */
  | 'owner_frees';

export interface QueueRelief {
  readonly freedBy: QueueFreedBy;
  /** One such event admits this task: it is the head, and each full limit is exactly at its count. */
  readonly startsNext: boolean;
}

/** What frees a place for a waiting task, against both limits; `null` for `admitted`. */
export const queueRelief = (wait: QueueWait): QueueRelief | null => {
  if (wait.status === 'admitted') {
    return null;
  }
  if (wait.reason === 'max_tasks_per_owner') {
    // Which of the owner's queued tasks starts first is the queue's order across projects: no
    // promise is made for this one.
    return { freedBy: 'owner_frees', startsNext: false };
  }
  const pipelineFull = full(wait.pipeline);
  const runningFull = full(wait.running);
  const freedBy: QueueFreedBy = pipelineFull
    ? runningFull
      ? 'running_finishes'
      : 'pipeline_finishes'
    : 'running_stops';
  const startsNext =
    wait.position === 1 &&
    (!pipelineFull || wait.pipeline.count === wait.pipeline.limit) &&
    (!runningFull || wait.running.count === wait.running.limit);
  return { freedBy, startsNext };
};

/** The short form: "2nd in queue · 5 of 5 places taken". */
export const queueShort = (wait: QueueWait): string => {
  const place = `${ordinal(wait.position)} in queue`;
  if (wait.status === 'admitted') {
    return `${place} · a place is free`;
  }
  if (wait.reason === 'max_tasks_per_owner' && wait.owner !== undefined) {
    return `${place} · ${wait.owner.name} has ${wait.count} of ${wait.limit} in flight`;
  }
  return full(wait.pipeline)
    ? `${place} · ${wait.pipeline.count} of ${wait.pipeline.limit} places taken`
    : `${place} · ${wait.running.count} of ${wait.running.limit} running`;
};

/**
 * The column note: which limits are full, what holds them and what frees a place — the same for
 * every task of the queue. `null` for `admitted`, which has nothing holding it.
 */
export const queueNote = (
  wait: QueueWait,
  mayDecide: boolean,
  /** The reader's user id: their own limit is said as *you* / *your* (S-28.6). */
  readerId: string | null = null,
): string | null => {
  const relief = queueRelief(wait);
  if (wait.status === 'admitted' || relief === null) {
    return null;
  }
  if (relief.freedBy === 'owner_frees') {
    return ownerNote(wait, readerId);
  }
  const { running, pipeline } = wait;
  if (relief.freedBy === 'running_stops') {
    return (
      `Waiting for a place: this project runs at most ${tasks(running.limit)} at once (the ` +
      `project’s limit, not a person’s), and ${are(running.count)} running. A place frees when one ` +
      'of them finishes, stops for a person, is paused or is cancelled.'
    );
  }
  const people = wait.holders.needs_human;
  const whom = mayDecide ? 'you' : 'a person';
  const forWhom =
    people === 0 ? '' : ` — ${people} of them ${people === 1 ? 'waits' : 'wait'} for ${whom}`;
  const held =
    `Waiting for a place: this project holds at most ${tasks(pipeline.limit)} in its pipeline ` +
    `(the project’s limit, not a person’s), and ${are(pipeline.count)} in it${forWhom}`;
  if (relief.freedBy === 'running_finishes') {
    return (
      `${held}; and it runs at most ${running.limit} at once, and ${are(running.count)} running. ` +
      'A place frees when a running task finishes, is paused, is cancelled or needs a person to ' +
      'unblock it.'
    );
  }
  const decide =
    people === 0 || !mayDecide ? '.' : `, so decide ${people === 1 ? 'it' : 'them'} or cancel one.`;
  return (
    `${held}. A place frees when one of them finishes, is paused, is cancelled or needs a person ` +
    `to unblock it${decide}`
  );
};

/**
 * **The owner's own limit** (S-28.6): "Waiting for a place: Jan owns 3 tasks in flight and Jan’s
 * limit is 3. AUT-1, AUT-2, AUT-3 hold the places. …" — *you* / *your* to the owner themself. The
 * counting rule is said in words: paused tasks and tasks waiting for a person to unblock them do
 * not count, tasks waiting for an approval or an answer do.
 */
const ownerNote = (
  wait: Extract<QueueWait, { status: 'waiting' }>,
  readerId: string | null,
): string => {
  const self = wait.owner !== undefined && wait.owner.user_id === readerId;
  const name = wait.owner?.name ?? 'Its owner';
  const who = self ? 'you own' : `${name} owns`;
  const whose = self ? 'your' : `${name}’s`;
  const keys = wait.holders.items.map((holder) => holder.ticket_key);
  const more = wait.holders.total - keys.length;
  const holding =
    keys.length === 0
      ? ''
      : ` ${keys.join(', ')}${more > 0 ? ` and ${more} more` : ''} ${
          wait.holders.total === 1 ? 'holds the place' : 'hold the places'
        }.`;
  return (
    `Waiting for a place: ${who} ${tasks(wait.count)} in flight and ${whose} limit is ${wait.limit}.` +
    `${holding} A place frees when one finishes, is paused, or is handed to someone else. ` +
    'Paused tasks and tasks waiting for a person to unblock them do not count; tasks waiting for ' +
    'an approval or an answer do.'
  );
};

/** The long form, for the task page: the note and this task's place. */
export const queueSentence = (
  wait: QueueWait,
  ticketKey: string,
  mayDecide: boolean,
  readerId: string | null = null,
): string => {
  const relief = queueRelief(wait);
  if (wait.status === 'admitted' || relief === null) {
    return (
      `There is room under this project’s limits: the queue moves on when a task finishes, stops ` +
      `for a person, is paused or is cancelled, and ${ticketKey} is ${ordinal(wait.position)} in it.`
    );
  }
  const ahead = wait.position - 1;
  const place =
    ahead > 0
      ? `${ticketKey} is ${ordinal(wait.position)} in the queue: ${ahead === 1 ? '1 ticket is' : `${ahead} tickets are`} ahead of it.`
      : relief.freedBy === 'owner_frees'
        ? `${ticketKey} is next in the queue and starts once its owner has a free place.`
        : relief.startsNext
          ? `${ticketKey} is next in the queue and starts then.`
          : `${ticketKey} is next in the queue and starts once the project is back under its limits.`;
  return `${queueNote(wait, mayDecide, readerId) ?? ''} ${place}`;
};

/**
 * **Which limit binds** (S-25.21, BACKLOG 1371): when the refusing limit is the organisation's
 * maximum (`organisation_bound`: `resolveWipLimits` lowered what the project asked for), raising the
 * project's own value changes nothing, so the page says whose limit it is. `null` for any other
 * wait, and for `admitted`.
 */
export const organisationLimitSentence = (wait: QueueWait): string | null => {
  if (
    wait.status !== 'waiting' ||
    !wait.organisation_bound ||
    wait.reason === 'max_tasks_per_owner'
  ) {
    return null;
  }
  const allowed =
    wait.reason === 'max_parallel_tasks'
      ? `${wait.limit} parallel ${wait.limit === 1 ? 'task' : 'tasks'} per project`
      : `${tasks(wait.limit)} in a project’s pipeline`;
  return `Your organisation allows at most ${allowed}, so this project’s own limit cannot go higher.`;
};
