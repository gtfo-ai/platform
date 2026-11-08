/**
 * The queue's words (S-25.16): the column note, the task page's sentence and the card's short form
 * over each shape of `queue_wait` — the pipeline limit with people holding it, without, the
 * parallel limit, a limit lowered under the tasks already in, and the honest `admitted`.
 */
import type { QueueWait } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { ordinal, placesToFree, queueNote, queueSentence, queueShort } from './queue-words.js';

const holder = (n: number, state: 'needs_human' | 'paused' | 'active' = 'needs_human') => ({
  task_id: `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`,
  ticket_key: `AUT-66${n}`,
  state,
});

const pipelineWait = (over: Partial<Extract<QueueWait, { status: 'waiting' }>> = {}) =>
  ({
    status: 'waiting',
    reason: 'max_tasks_in_pipeline',
    count: 5,
    limit: 5,
    position: 2,
    queued: 5,
    holders: { total: 5, needs_human: 5, items: [1, 2, 3, 4, 5].map((n) => holder(n)) },
    ...over,
  }) satisfies QueueWait;

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
  it('says the Autix case: the limit, who holds it, what frees it and this task’s place', () => {
    expect(queueSentence(pipelineWait(), 'AUT-6862')).toBe(
      'Waiting for a place: this project runs at most 5 tasks at once, and 5 are in the pipeline — ' +
        '5 of them wait for you. A place frees when one of them finishes or is cancelled, so decide ' +
        'them or cancel one. AUT-6862 is 2nd in the queue and starts once 2 places are free.',
    );
    expect(queueShort(pipelineWait())).toBe('2nd in queue · 5 of 5 places taken');
  });

  it('says the head of the queue starts when one place frees', () => {
    expect(queueSentence(pipelineWait({ position: 1 }), 'AUT-6861')).toMatch(
      /AUT-6861 is next in the queue and starts then\.$/,
    );
  });

  it('counts the places taken past a lowered limit', () => {
    const over = pipelineWait({ count: 7, limit: 5, position: 1 });
    expect(placesToFree(over)).toBe(3);
    expect(queueSentence(over, 'AUT-1')).toMatch(/1st in the queue and starts once 3 places/);
  });

  it('asks nobody to decide when no holder waits for a person', () => {
    const note = queueNote(
      pipelineWait({
        holders: { total: 5, needs_human: 0, items: [1, 2].map((n) => holder(n, 'active')) },
      }),
    );
    expect(note).toBe(
      'Waiting for a place: this project runs at most 5 tasks at once, and 5 are in the pipeline. ' +
        'A place frees when one of them finishes or is cancelled.',
    );
    expect(note).not.toMatch(/decide|for you/);
  });

  it('says one of them waits for you, in the singular', () => {
    const note = queueNote(
      pipelineWait({
        count: 1,
        limit: 1,
        holders: { total: 1, needs_human: 1, items: [holder(1)] },
      }),
    );
    expect(note).toContain('at most 1 task at once, and 1 is in the pipeline — 1 of them waits');
    expect(note).toContain('so decide it or cancel one.');
  });

  it('names the running tasks for the parallel limit', () => {
    const wait = pipelineWait({
      reason: 'max_parallel_tasks',
      count: 2,
      limit: 2,
      position: 1,
      holders: { total: 2, needs_human: 0, items: [holder(1, 'active'), holder(2, 'active')] },
    });
    expect(queueNote(wait)).toBe(
      'Waiting for a place: this project runs at most 2 tasks at once, and 2 are running. A place ' +
        'frees when one of them finishes, stops for a person or is paused.',
    );
    expect(queueShort(wait)).toBe('1st in queue · 2 of 2 running');
  });

  it('says there is room, and invents no wait, for an admitted task', () => {
    const admitted: QueueWait = { status: 'admitted', position: 3, queued: 4 };
    expect(queueNote(admitted)).toBeNull();
    expect(queueShort(admitted)).toBe('3rd in queue · a place is free');
    expect(queueSentence(admitted, 'AUT-9')).toBe(
      'There is room under this project’s limits: the queue moves on when a task finishes, stops ' +
        'for a person, is paused or is cancelled, and AUT-9 is 3rd in it.',
    );
  });

  it('never says WIP on screen', () => {
    for (const text of [
      queueSentence(pipelineWait(), 'AUT-1'),
      queueShort(pipelineWait()),
      queueNote(pipelineWait()) ?? '',
    ]) {
      expect(text).not.toMatch(/\bWIP\b|max_/);
    }
  });
});
