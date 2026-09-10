import type { TranscriptEvent } from '@platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import { createTranscriptStore } from './store.js';

const RUN = '11111111-1111-4111-8111-111111111111';
const OTHER_RUN = '22222222-2222-4222-8222-222222222222';

const event = (seq: number, text: string, runId = RUN): TranscriptEvent =>
  ({
    kind: 'assistant',
    run_id: runId,
    seq,
    created_at: '2026-09-10T09:00:00.000Z',
    redaction_count: 0,
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
  }) as TranscriptEvent;

describe('the transcript store', () => {
  it('returns a stable empty snapshot for a run it has never seen', () => {
    const store = createTranscriptStore();
    // `useSyncExternalStore` loops for ever if the snapshot reference changes on every call.
    expect(store.snapshot(RUN)).toBe(store.snapshot(RUN));
    expect(store.snapshot(RUN).blocks).toHaveLength(0);
  });

  it('applies a live frame and notifies its subscribers', () => {
    const store = createTranscriptStore();
    const listener = vi.fn();
    store.subscribe(RUN, listener);

    expect(store.apply(event(1, 'hello'))).toBe(true);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.snapshot(RUN).blocks).toHaveLength(1);
    expect(store.snapshot(RUN).lastSeq).toBe(1);
  });

  it('ignores a seq it already holds and does not re-render for it', () => {
    const store = createTranscriptStore();
    const listener = vi.fn();
    store.subscribe(RUN, listener);
    store.apply(event(1, 'hello'));
    listener.mockClear();

    expect(store.apply(event(1, 'hello'))).toBe(false);

    expect(listener).not.toHaveBeenCalled();
    expect(store.snapshot(RUN).events).toHaveLength(1);
  });

  it('merges a fetched page without losing a newer live frame', () => {
    const store = createTranscriptStore();
    store.apply(event(5, 'live'));
    store.merge(RUN, [event(1, 'old'), event(5, 'a stale copy of five')]);

    const { events, blocks } = store.snapshot(RUN);
    expect(events.map((item) => item.seq)).toEqual([1, 5]);
    // The live frame won: `merge` never overwrites a seq the store already holds.
    expect(blocks[1]).toMatchObject({ text: 'live' });
  });

  it('keeps runs apart', () => {
    const store = createTranscriptStore();
    store.apply(event(1, 'first run'));
    store.apply(event(1, 'second run', OTHER_RUN));

    expect(store.snapshot(RUN).blocks).toHaveLength(1);
    expect(store.snapshot(OTHER_RUN).blocks[0]).toMatchObject({ text: 'second run' });
  });

  it('stops notifying after unsubscribe', () => {
    const store = createTranscriptStore();
    const listener = vi.fn();
    const unsubscribe = store.subscribe(RUN, listener);
    unsubscribe();

    store.apply(event(1, 'hello'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('clears a run and notifies once', () => {
    const store = createTranscriptStore();
    const listener = vi.fn();
    store.subscribe(RUN, listener);
    store.apply(event(1, 'hello'));
    listener.mockClear();

    store.clear(RUN);
    expect(listener).toHaveBeenCalledTimes(1);
    expect(store.snapshot(RUN).events).toHaveLength(0);

    store.clear(RUN);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
