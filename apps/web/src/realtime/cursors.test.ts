import { describe, expect, it } from 'vitest';
import { parseFrameId, serialiseCursors } from './cursors.js';

/**
 * The two halves of the `id: <topic>:<seq>` wire format, held to the strings the server emits.
 *
 * `apps/server/src/sse/hub.ts` builds an id as `` `${frame.topic}:${frame.seq}` `` and splits a
 * cursor on the **last** colon; the inputs below are those exact strings. Splitting on the first
 * colon instead would fail in the *kind* direction — the topic would come out as `task` and the
 * server would answer `reset` — which looks like a slow reconnect rather than a bug.
 */
const UUID = '11111111-1111-4111-8111-111111111111';

describe('parseFrameId', () => {
  it.each([
    ['org:0', 'org', 0],
    [`project:${UUID}:41`, `project:${UUID}`, 41],
    [`task:${UUID}:7`, `task:${UUID}`, 7],
    [`run:${UUID}:1024`, `run:${UUID}`, 1024],
  ])('splits %j on the last colon', (entry, topic, seq) => {
    expect(parseFrameId(entry)).toEqual({ topic, seq });
  });

  it.each([
    '',
    'org',
    ':7',
    'org:',
    'org:-1',
    'org:1.5',
    'org:abc',
    `unknown:${UUID}:3`,
    'task:not-a-uuid:3',
  ])('refuses %j', (entry) => {
    expect(parseFrameId(entry)).toBeNull();
  });
});

describe('serialiseCursors', () => {
  it('joins every held position, which is what a multiplexed reconnect has to send', () => {
    expect(
      serialiseCursors(
        new Map([
          ['org', 3],
          [`run:${UUID}`, 12],
        ]),
      ),
    ).toBe(`org:3,run:${UUID}:12`);
  });

  it('is empty when nothing is held, so the query parameter is omitted', () => {
    expect(serialiseCursors(new Map())).toBe('');
  });

  it('round-trips through parseFrameId', () => {
    const cursors = new Map([
      ['org', 1],
      [`task:${UUID}`, 99],
    ]);
    const parsed = serialiseCursors(cursors)
      .split(',')
      .map((entry) => parseFrameId(entry));
    expect(parsed).toEqual([
      { topic: 'org', seq: 1 },
      { topic: `task:${UUID}`, seq: 99 },
    ]);
  });
});
