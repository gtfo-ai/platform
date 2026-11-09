/**
 * The queue's words (S-25.16): the column note, the task page's sentence and the card's short form
 * over each shape of `queue_wait`, read against **both** limits (review of #124) — and a property
 * that whatever the words promise ("starts then") is what the scheduler's admission does after the
 * event the words name.
 */
import type { IsoDateTime, QueueWait, TaskState } from '@platform/contracts';
import { taskStateSchema } from '@platform/contracts';
import {
  countsInPipeline,
  evaluateTaskAdmission,
  type QueueLiveTask,
  queueWaitsOver,
  type WipLimits,
  wipCountsOf,
} from '@platform/domain';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  ordinal,
  type QueueFreedBy,
  queueNote,
  queueRelief,
  queueSentence,
  queueShort,
} from './queue-words.js';

const LIMITS: WipLimits = { maxParallelTasks: 2, maxTasksInPipeline: 5, maxParallelRuns: 4 };

/**
 * The read's `queue_wait` for the task at `position`, built through **the server's own function**
 * (the domain's `queueWaitsOver`, which `apps/server/src/queries/queue-wait.ts` calls — the S-25.16
 * review: a copy here could agree with the words and disagree with the server). `position` queued
 * tickets are added behind the live `states`, oldest first, and the last of them is asked about.
 */
const waitFor = (states: readonly TaskState[], limits: WipLimits, position = 1): QueueWait => {
  const at = (n: number): IsoDateTime =>
    new Date(Date.UTC(2026, 10, 9, 8, 0, n)).toISOString() as IsoDateTime;
  const live: QueueLiveTask[] = [
    ...states.map((state, n) => ({
      id: `00000000-0000-4000-8000-${(n + 1).toString(16).padStart(12, '0')}`,
      state,
      ticketKey: `AUT-${100 + n}`,
      priorityRank: 2,
      createdAt: at(n),
    })),
    ...Array.from({ length: position }, (_, n) => ({
      id: `00000000-0000-4000-9000-${(n + 1).toString(16).padStart(12, '0')}`,
      state: 'queued' as const,
      ticketKey: `AUT-${900 + n}`,
      priorityRank: 2,
      createdAt: at(100 + n),
    })),
  ];
  const asked = live.at(-1)?.id ?? '';
  const wait = queueWaitsOver(live, [asked], limits, []).get(asked);
  if (wait === undefined) {
    throw new Error('the queued task has no queue_wait');
  }
  return wait;
};

const repeat = (state: TaskState, n: number): TaskState[] => Array.from({ length: n }, () => state);

describe('ordinal', () => {
  it.each([
    [1, '1st'],
    [2, '2nd'],
    [3, '3rd'],
    [4, '4th'],
    [11, '11th'],
    [12, '12th'],
    [13, '13th'],
    [21, '21st'],
    [22, '22nd'],
    [101, '101st'],
    [111, '111th'],
  ])('%i is %s', (n, word) => {
    expect(ordinal(n)).toBe(word);
  });
});

describe('the queue’s words', () => {
  it('says the Autix case: the pipeline full of stopped tasks, what frees it, this task’s place', () => {
    const autix = waitFor(repeat('needs_human', 5), LIMITS, 2);
    expect(queueSentence(autix, 'AUT-6862', true)).toBe(
      'Waiting for a place: this project holds at most 5 tasks in its pipeline, and 5 are in it — ' +
        '5 of them wait for you. A place frees when one of them finishes or is cancelled, so decide ' +
        'them or cancel one. AUT-6862 is 2nd in the queue: 1 ticket is ahead of it.',
    );
    expect(queueShort(autix)).toBe('2nd in queue · 5 of 5 places taken');
    expect(queueSentence(waitFor(repeat('needs_human', 5), LIMITS, 1), 'AUT-6861', true)).toMatch(
      /AUT-6861 is next in the queue and starts then\.$/,
    );
  });

  it('review case (a): 2 running + 3 stopped — only a running task finishing frees a place', () => {
    const wait = waitFor([...repeat('active', 2), ...repeat('needs_human', 3)], LIMITS);
    expect(wait).toMatchObject({ status: 'waiting', reason: 'max_parallel_tasks' });
    expect(queueRelief(wait)).toEqual({ freedBy: 'running_finishes', startsNext: true });
    const sentence = queueSentence(wait, 'AUT-1', true);
    expect(sentence).toBe(
      'Waiting for a place: this project holds at most 5 tasks in its pipeline, and 5 are in it — ' +
        '3 of them wait for you; and it runs at most 2 at once, and 2 are running. A place frees ' +
        'when a running task finishes or is cancelled. AUT-1 is next in the queue and starts then.',
    );
    // Never the parallel-only promise the review found: stopping or pausing frees nothing here.
    expect(sentence).not.toMatch(/stops for a person|is paused/);
  });

  it('review case (b): 1 running + 4 stopped — the 2nd is told who is ahead, not a number of places', () => {
    const wait = waitFor([...repeat('active', 1), ...repeat('needs_human', 4)], LIMITS, 2);
    expect(wait).toMatchObject({ reason: 'max_tasks_in_pipeline' });
    expect(queueRelief(wait)).toEqual({ freedBy: 'pipeline_finishes', startsNext: false });
    const sentence = queueSentence(wait, 'AUT-2', true);
    expect(sentence).toMatch(/AUT-2 is 2nd in the queue: 1 ticket is ahead of it\.$/);
    expect(sentence).not.toMatch(/starts once|places are free/);
  });

  it('promises no start past a lowered limit', () => {
    const wait = waitFor(repeat('needs_human', 7), LIMITS, 1);
    expect(queueRelief(wait)?.startsNext).toBe(false);
    expect(queueSentence(wait, 'AUT-1', true)).toMatch(
      /AUT-1 is next in the queue and starts once the project is back under its limits\.$/,
    );
  });

  it('says “a person” and asks nobody to decide, for a reader who may not decide them', () => {
    const note = queueNote(waitFor(repeat('needs_human', 5), LIMITS), false);
    expect(note).toBe(
      'Waiting for a place: this project holds at most 5 tasks in its pipeline, and 5 are in it — ' +
        '5 of them wait for a person. A place frees when one of them finishes or is cancelled.',
    );
  });

  it('asks nobody to decide when no holder waits for a person', () => {
    const note = queueNote(waitFor([...repeat('active', 1), ...repeat('paused', 4)], LIMITS), true);
    expect(note).toBe(
      'Waiting for a place: this project holds at most 5 tasks in its pipeline, and 5 are in it. ' +
        'A place frees when one of them finishes or is cancelled.',
    );
  });

  it('says one of them waits for you, in the singular', () => {
    const limits = { ...LIMITS, maxParallelTasks: 1, maxTasksInPipeline: 1 };
    const note = queueNote(waitFor(['needs_human'], limits), true);
    expect(note).toContain('at most 1 task in its pipeline, and 1 is in it — 1 of them waits');
    expect(note).toContain('so decide it or cancel one.');
  });

  it('names the running tasks, cancelling included, when only they are full', () => {
    const wait = waitFor(repeat('active', 2), LIMITS);
    expect(queueNote(wait, true)).toBe(
      'Waiting for a place: this project runs at most 2 tasks at once, and 2 are running. A place ' +
        'frees when one of them finishes, stops for a person, is paused or is cancelled.',
    );
    expect(queueShort(wait)).toBe('1st in queue · 2 of 2 running');
  });

  it('names the pipeline when its limit is below the running limit (S-25.16 review)', () => {
    // 3 at once, 2 in the pipeline: two running tasks fill the pipeline and not the running places.
    const limits = { ...LIMITS, maxParallelTasks: 3, maxTasksInPipeline: 2 };
    const wait = waitFor(repeat('active', 2), limits);
    expect(wait).toMatchObject({ status: 'waiting', reason: 'max_tasks_in_pipeline' });
    expect(queueRelief(wait)).toEqual({ freedBy: 'pipeline_finishes', startsNext: true });
    expect(queueNote(wait, true)).toBe(
      'Waiting for a place: this project holds at most 2 tasks in its pipeline, and 2 are in it. ' +
        'A place frees when one of them finishes or is cancelled.',
    );
    expect(evaluateTaskAdmission(wipCountsOf(['active', 'done']), limits).admitted).toBe(true);
  });

  it('says there is room, and invents no wait, for an admitted task', () => {
    const admitted = waitFor(['active'], LIMITS, 3);
    expect(admitted.status).toBe('admitted');
    expect(queueNote(admitted, true)).toBeNull();
    expect(queueShort(admitted)).toBe('3rd in queue · a place is free');
    expect(queueSentence(admitted, 'AUT-9', true)).toBe(
      'There is room under this project’s limits: the queue moves on when a task finishes, stops ' +
        'for a person, is paused or is cancelled, and AUT-9 is 3rd in it.',
    );
  });

  it('never says WIP on screen', () => {
    const wait = waitFor(repeat('needs_human', 5), LIMITS, 2);
    for (const text of [queueSentence(wait, 'AUT-1', true), queueShort(wait)]) {
      expect(text).not.toMatch(/\bWIP\b|max_/);
    }
  });
});

/** The states a task can leave by the event `freedBy` names, and the states it can move to. */
const EVENTS: Readonly<
  Record<QueueFreedBy, { readonly from: (state: TaskState) => boolean; readonly to: TaskState[] }>
> = {
  running_finishes: {
    from: (state) => state === 'active' || state === 'returned',
    to: ['done', 'cancelled'],
  },
  pipeline_finishes: { from: countsInPipeline, to: ['done', 'cancelled'] },
  running_stops: {
    from: (state) => state === 'active' || state === 'returned',
    to: ['needs_human', 'paused', 'done', 'cancelled'],
  },
};

describe('what the words promise is what the scheduler does (review of #124)', () => {
  const others = taskStateSchema.options.filter((state) => state !== 'queued');
  it('starts the head after any one event the words name, whenever they say “starts then”', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom(...others), { maxLength: 14 }),
        fc.integer({ min: 1, max: 4 }),
        // Independent of the running limit (the S-25.16 review): a pipeline limit at or below it
        // is a configuration the scheduler accepts, and the words must hold for it too.
        fc.integer({ min: 1, max: 8 }),
        (states, parallel, inPipeline) => {
          const limits = {
            ...LIMITS,
            maxParallelTasks: parallel,
            maxTasksInPipeline: inPipeline,
          };
          const wait = waitFor(states, limits);
          const relief = queueRelief(wait);
          if (relief === null) {
            // The words say there is room: so does the scheduler.
            expect(evaluateTaskAdmission(wipCountsOf(states), limits).admitted).toBe(true);
            return;
          }
          const sentence = queueSentence(wait, 'K-1', true);
          expect(sentence.includes('starts then')).toBe(relief.startsNext);
          if (!relief.startsNext) {
            return;
          }
          const event = EVENTS[relief.freedBy];
          for (const [index, state] of states.entries()) {
            if (!event.from(state)) {
              continue;
            }
            for (const to of event.to) {
              const after = states.map((each, at) => (at === index ? to : each));
              expect(
                evaluateTaskAdmission(wipCountsOf(after), limits).admitted,
                `${state} → ${to} over ${states.join(',')}`,
              ).toBe(true);
            }
          }
        },
      ),
    );
  });
});
