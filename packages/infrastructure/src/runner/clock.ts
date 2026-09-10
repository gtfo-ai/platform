/**
 * The two {@link RunnerClock} implementations: the real one, and the one every test uses.
 *
 * Standing rule, earned at WP-06a: *a wall-clock assertion is a hardware assertion, not a
 * correctness one.* The runner has three deadlines — the stall detector, the wall-clock timeout and
 * the question deadline — and all three are minutes long. A test that proves any of them by waiting
 * proves that the two-core CI runner was not busy; a test that advances {@link manualClock} proves
 * the guard.
 */
import type { CancelTimer, RunnerClock } from '@platform/application';

/** `Date.now()` and `setTimeout`, with the handle unref'd so a pending timer never holds the process. */
export const systemClock: RunnerClock = {
  now: () => Date.now(),
  setTimer: (delayMs, callback) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref?.();
    return () => clearTimeout(handle);
  },
};

export interface ManualClock extends RunnerClock {
  /** Moves time forward, firing every timer whose deadline the move passes, in deadline order. */
  advance(ms: number): void;
  /** Timers armed and not yet fired or cancelled. */
  readonly pending: number;
}

/**
 * A clock that only moves when a test moves it.
 *
 * Firing in deadline order matters: the runner arms the stall timer and the wall-clock timer at the
 * same moment, and a single `advance` past both must fire the *stall* first, because that is what
 * happens on a real clock and it is the reason the two produce different terminal states.
 *
 * A callback that arms another timer during `advance` is handled: the loop re-reads the queue after
 * every callback, so a re-armed stall timer inside the same advance is not skipped and does not
 * silently fire twice.
 */
export const manualClock = (start = 0): ManualClock => {
  let current = start;
  let nextId = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();

  const advance = (ms: number): void => {
    const target = current + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) {
        break;
      }
      const [id, timer] = due;
      timers.delete(id);
      current = timer.at;
      timer.callback();
    }
    current = target;
  };

  return {
    advance,
    now: () => current,
    get pending() {
      return timers.size;
    },
    setTimer: (delayMs, callback): CancelTimer => {
      const id = nextId++;
      timers.set(id, { at: current + delayMs, callback });
      return () => {
        timers.delete(id);
      };
    },
  };
};
