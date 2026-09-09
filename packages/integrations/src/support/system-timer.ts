/**
 * The real `IntegrationTimer`: the wall clock and `setTimeout`.
 *
 * It lives in the adapter ring rather than in `@platform/application` because reading the clock
 * and scheduling a wake-up are I/O, and the application ring only names the port (technical/01).
 * The composition root wires this one; every test wires `createVirtualTimer` instead, so no
 * rate-limit or backoff assertion ever waits on real time.
 */
import type { IntegrationTimer } from '@platform/application';

export const systemTimer: IntegrationTimer = {
  now: () => Date.now(),
  sleep: (milliseconds: number) => {
    // Validated *before* the promise is constructed, so a bad duration throws synchronously — the
    // way `createVirtualTimer` does. A real timer that rejected where the fake throws would make
    // the fake kinder than production in exactly the direction that hides a bug.
    if (!Number.isFinite(milliseconds) || milliseconds < 0) {
      throw new TypeError('sleep expects a non-negative number of milliseconds');
    }
    return new Promise<void>((resolve) => {
      const handle = setTimeout(resolve, milliseconds);
      // Do not hold the process open for a backoff wait during shutdown.
      handle.unref?.();
    });
  },
};
