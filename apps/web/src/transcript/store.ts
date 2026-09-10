/**
 * The per-run transcript store (technical/09 § "Real-time state").
 *
 * Transcripts do not live in TanStack Query: a run emits thousands of entries and the cache would
 * have to be rewritten on each one. They live here, in an event-sourced store fed from two places
 * — `GET /api/runs/:id/messages` for the page that already happened, and `transcript` SSE frames
 * for what happens next — which is why `apply` has to be idempotent and `replace` has to merge
 * rather than overwrite. The two sources overlap by construction: the REST page is fetched at one
 * instant and the stream starts at another.
 *
 * technical/09 names zustand for this. It is a `useSyncExternalStore` source instead — React 19
 * ships the hook, the store is 80 lines, and a dependency whose entire job is what the platform
 * already has is a dependency the bundle budget pays for. Recorded as an assumption, not a
 * silent substitution.
 *
 * `snapshot()` returns a **referentially stable** object: `useSyncExternalStore` re-renders when
 * the reference changes and loops for ever if a fresh object is returned on every call. The blocks
 * are derived once per state change and cached alongside the events for the same reason.
 */
import type { TranscriptEvent } from '@platform/contracts';
import { normaliseEvents, type TranscriptBlock, toBlocks } from './blocks.js';

export interface TranscriptSnapshot {
  readonly events: readonly TranscriptEvent[];
  readonly blocks: readonly TranscriptBlock[];
  /** Highest `seq` held, so a caller can ask the API for what comes after it. */
  readonly lastSeq: number | null;
}

const EMPTY: TranscriptSnapshot = { events: [], blocks: [], lastSeq: null };

interface RunState {
  readonly bySeq: Map<number, TranscriptEvent>;
  snapshot: TranscriptSnapshot;
  readonly listeners: Set<() => void>;
}

export interface TranscriptStore {
  readonly snapshot: (runId: string) => TranscriptSnapshot;
  readonly subscribe: (runId: string, listener: () => void) => () => void;
  /** One live frame. Returns whether anything changed, which is what makes it testable. */
  readonly apply: (event: TranscriptEvent) => boolean;
  /** A fetched page. Merged by `seq`, never overwriting newer entries with an older page. */
  readonly merge: (runId: string, events: readonly TranscriptEvent[]) => void;
  readonly clear: (runId: string) => void;
}

export const createTranscriptStore = (): TranscriptStore => {
  const runs = new Map<string, RunState>();

  const stateFor = (runId: string): RunState => {
    const existing = runs.get(runId);
    if (existing !== undefined) {
      return existing;
    }
    const created: RunState = { bySeq: new Map(), snapshot: EMPTY, listeners: new Set() };
    runs.set(runId, created);
    return created;
  };

  const recompute = (state: RunState): void => {
    const events = normaliseEvents([...state.bySeq.values()]);
    state.snapshot = {
      events,
      blocks: toBlocks(events),
      lastSeq: events.length === 0 ? null : (events[events.length - 1]?.seq ?? null),
    };
    for (const listener of state.listeners) {
      listener();
    }
  };

  return {
    snapshot: (runId) => runs.get(runId)?.snapshot ?? EMPTY,

    subscribe: (runId, listener) => {
      const state = stateFor(runId);
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },

    apply: (event) => {
      const state = stateFor(event.run_id);
      const existing = state.bySeq.get(event.seq);
      if (existing !== undefined) {
        // Same row, delivered twice (replay after a reconnect). Nothing changed, so nothing
        // re-renders: a store that notified here would repaint the run screen on every reconnect.
        return false;
      }
      state.bySeq.set(event.seq, event);
      recompute(state);
      return true;
    },

    merge: (runId, events) => {
      const state = stateFor(runId);
      let changed = false;
      for (const event of events) {
        if (!state.bySeq.has(event.seq)) {
          state.bySeq.set(event.seq, event);
          changed = true;
        }
      }
      if (changed) {
        recompute(state);
      }
    },

    clear: (runId) => {
      const state = runs.get(runId);
      if (state === undefined || state.bySeq.size === 0) {
        return;
      }
      state.bySeq.clear();
      recompute(state);
    },
  };
};
