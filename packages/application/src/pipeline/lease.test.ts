/**
 * The run heartbeat: what it writes, when it stops, and what it never does to the run (WP-47).
 *
 * The schedule is injected rather than waited for, so every case here is a claim about the
 * heartbeat's *decisions* and none of them is a claim about `setInterval`. The three decisions are
 * the whole of the mechanism: renew while the run is live, **stop** when the row refuses (the run
 * ended, or another process owns the lease), and **never** let a failed beat reach the run.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  intervalHeartbeatSchedule,
  leaseExpiryAt,
  RUN_LEASE_RENEW_MS,
  RUN_LEASE_TTL_MS,
  startRunHeartbeat,
} from './lease.js';
import type { PipelineStore } from './store.js';

const RUN = '00000000-0000-4000-8000-0000000000e1' as Id;
const NOW = '2026-09-15T10:00:00.000Z' as IsoDateTime;
const OWNER = 'server-1:0f0f0f0f';

interface Beat {
  readonly runId: Id;
  readonly owner: string;
  readonly expiresAt: IsoDateTime;
}

const harness = (renew: (beat: Beat) => Promise<boolean>) => {
  const beats: Beat[] = [];
  let tick: (() => void) | undefined;
  let cancelled = 0;
  const store = {
    runs: {
      renewLease: async (_tx: unknown, lease: Beat) => {
        beats.push(lease);
        return renew(lease);
      },
    },
  } as unknown as PipelineStore;
  const stop = startRunHeartbeat(
    {
      unitOfWork: { transaction: async (fn) => fn({ tx: { adapter: 'memory' } } as never) },
      store,
      clock: { now: () => NOW },
      lease: {
        owner: OWNER,
        schedule: (_everyMs, beat) => {
          tick = beat;
          return () => {
            cancelled += 1;
          };
        },
      },
    },
    RUN,
  );
  return {
    beats,
    stop,
    beat: async () => {
      tick?.();
      // The beat is fired and forgotten by design — it must not block the run — so "after the
      // beat" is the next macrotask, which drains the whole `then`/`catch`/`finally` chain the
      // heartbeat builds. Counting microtask turns here would be counting an implementation detail.
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
    get cancelled() {
      return cancelled;
    },
  };
};

describe('the run lease heartbeat', () => {
  it('renews with this process’s owner and a fresh expiry every beat', async () => {
    const heartbeat = harness(async () => true);

    await heartbeat.beat();
    await heartbeat.beat();

    expect(heartbeat.beats).toEqual([
      { runId: RUN, owner: OWNER, expiresAt: '2026-09-15T10:05:00.000Z' },
      { runId: RUN, owner: OWNER, expiresAt: '2026-09-15T10:05:00.000Z' },
    ]);
  });

  it('stops beating when the row refuses, because the claim is no longer this process’s', async () => {
    const heartbeat = harness(async () => false);

    await heartbeat.beat();
    await heartbeat.beat();

    // One write, and the timer cancelled: a heartbeat that kept writing would be asserting a lease
    // it does not hold, and the row would refuse it once a second for the life of the process.
    expect(heartbeat.beats).toHaveLength(1);
    expect(heartbeat.cancelled).toBe(1);
  });

  it('keeps beating after a beat throws, and never lets the failure reach the run', async () => {
    let calls = 0;
    const heartbeat = harness(async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('the pool was empty');
      }
      return true;
    });

    // No rejection escapes: the run executing beside this must not fail because a database hiccup
    // cost one lease renewal. The worst a run of failed beats can do is let the lease lapse, and
    // the sweep's answer to that is honest.
    await expect(heartbeat.beat()).resolves.toBeUndefined();
    await heartbeat.beat();

    expect(heartbeat.beats).toHaveLength(2);
    expect(heartbeat.cancelled).toBe(0);
  });

  it('runs one beat at a time, so a slow write cannot queue connection borrows behind itself', async () => {
    let release: (() => void) | undefined;
    const heartbeat = harness(
      async () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            resolve(true);
          };
        }),
    );

    await heartbeat.beat();
    await heartbeat.beat();
    expect(heartbeat.beats).toHaveLength(1);

    release?.();
    await heartbeat.beat();
    await heartbeat.beat();
    expect(heartbeat.beats).toHaveLength(2);
  });

  it('cancels the timer when the caller stops it, and stopping twice is not an error', async () => {
    const heartbeat = harness(async () => true);

    await heartbeat.stop();
    await heartbeat.stop();

    expect(heartbeat.cancelled).toBe(2);
  });

  it('resolves only once the beat in flight has finished, so no borrow outlives the stop', async () => {
    let release: (() => void) | undefined;
    let settled = false;
    const heartbeat = harness(
      async () =>
        new Promise<boolean>((resolve) => {
          release = () => {
            resolve(true);
          };
        }),
    );

    await heartbeat.beat();
    const stopping = heartbeat.stop().then(() => {
      settled = true;
    });
    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    // The write is still open, so the stop has **not** resolved: this is the difference between
    // "the timer is cancelled" and "no connection of mine is out", which is what the stage
    // executor's transaction 2 depends on.
    expect(settled).toBe(false);

    release?.();
    await stopping;
    expect(settled).toBe(true);
  });

  it('accepts a scheduler whose first beat runs synchronously inside schedule', () => {
    // A scheduler that beats inside `schedule` itself is the temporal-dead-zone hazard the nullable
    // `cancel` binding removes: with `const cancel = schedule(...)` the callback would reach the
    // binding it is being assigned from. This case does NOT prove the hazard is closed — `halt()`
    // is only reachable from the beat's `.then`, a microtask after the assignment, so no scheduler
    // expressible here can hit the dead zone, and the pre-fix shape passes it too (measured by a
    // round-2 reviewer on a copy, rule 3). It holds only that a synchronous first beat is accepted;
    // the shape is what removes the hazard, and this sentence is where that is stated.
    expect(() =>
      startRunHeartbeat(
        {
          unitOfWork: { transaction: async (fn) => fn({ tx: { adapter: 'memory' } } as never) },
          store: {
            runs: { renewLease: async () => false },
          } as unknown as PipelineStore,
          clock: { now: () => NOW },
          lease: {
            owner: OWNER,
            schedule: (_everyMs, beat) => {
              beat();
              return () => {};
            },
          },
        },
        RUN,
      ),
    ).not.toThrow();
  });
});

describe('the lease’s two numbers', () => {
  it('renews at a third of the TTL, so two consecutive beats may be lost', () => {
    expect(RUN_LEASE_TTL_MS).toBe(5 * 60_000);
    expect(RUN_LEASE_RENEW_MS * 3).toBe(RUN_LEASE_TTL_MS);
  });

  it('computes the expiry from the caller’s clock rather than from the runtime’s', () => {
    expect(leaseExpiryAt(NOW, 90_000)).toBe('2026-09-15T10:01:30.000Z');
  });

  it('unrefs the default timer, so a pending beat cannot hold a finished process open', () => {
    const unref = vi.fn();
    const timer = { unref } as unknown as NodeJS.Timeout;
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval').mockReturnValue(timer);
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => {});

    const cancel = intervalHeartbeatSchedule(1000, () => {});
    cancel();

    expect(unref).toHaveBeenCalledOnce();
    expect(clearIntervalSpy).toHaveBeenCalledWith(timer);
    setIntervalSpy.mockRestore();
    clearIntervalSpy.mockRestore();
  });
});
