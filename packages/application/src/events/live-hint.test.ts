import type { Id } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { LIVE_EVENTS_APPENDED_TOPIC } from '../ports/broadcast.js';
import type { StoredEvent } from '../ports/event-store.js';
import { makeEvent, streamId, taskQueued } from '../testing/fixtures.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { liveEventsAppendedHint } from './live-hint.js';

const PROJECT = '00000000-0000-4000-8000-0000000000ff' as Id;

/** An organisation-level event: not a `task.*` or `run.*` type, so not live. */
const notLive = (seq: number) =>
  makeEvent(
    'budget.exhausted',
    { budget_id: PROJECT, scope: 'org', window: 'month', limit_usd: 100, spent_usd: 100 },
    { streamType: 'budget', streamId: PROJECT, streamSeq: seq },
  );

const at = (position: number, event: StoredEvent['event']): StoredEvent => ({
  position,
  causeEventPosition: null,
  event,
});

describe('liveEventsAppendedHint', () => {
  it('names the lowest and highest position of the live events, and only those', () => {
    const task = { streamType: 'task', streamId: streamId(1) } as const;
    expect(
      liveEventsAppendedHint([
        at(3, notLive(1)),
        at(4, taskQueued({ ...task, streamSeq: 1 })),
        at(6, taskQueued({ ...task, streamSeq: 2 })),
        at(7, notLive(2)),
      ]),
    ).toEqual({ topic: LIVE_EVENTS_APPENDED_TOPIC, payload: { from: 4, to: 6 } });
  });

  it('is nothing for a batch with no live event', () => {
    expect(liveEventsAppendedHint([at(3, notLive(1))])).toBeNull();
    expect(liveEventsAppendedHint([])).toBeNull();
  });

  it('is published by the in-memory appender too, after the commit, as the PostgreSQL one does', async () => {
    const memory = new MemoryEventing();
    const hints: unknown[] = [];
    await memory.broadcast.subscribe([LIVE_EVENTS_APPENDED_TOPIC], (message) => {
      hints.push(message.payload);
    });

    const appended = await memory.transaction(async (scope) =>
      scope.events.append([
        taskQueued({ streamType: 'task', streamId: streamId(2), streamSeq: 1 }),
      ]),
    );

    const position = appended[0]?.position ?? -1;
    expect(hints).toEqual([{ from: position, to: position }]);
  });
});
