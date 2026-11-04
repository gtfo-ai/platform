/**
 * The run heartbeat: what it writes, when it stops, and what it never does to the run (WP-47).
 *
 * The schedule is injected rather than waited for, so every case here is a claim about the
 * heartbeat's *decisions* and none of them is a claim about `setInterval`. The three decisions are
 * the whole of the mechanism: renew while the run is live, **stop** when the row refuses (the run
 * ended, or another process owns the lease), and **never** let a failed beat reach the run.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { offerAndClaimForTest } from '../testing/run-offers.js';
import {
  DEFAULT_LEASE_SKEW_GRACE_MS,
  intervalHeartbeatSchedule,
  leaseConstantsHold,
  leaseExpiryAt,
  REMOTE_RUN_LEASE_RENEW_MS,
  REMOTE_RUN_LEASE_TTL_MS,
  RUN_LEASE_RENEW_MS,
  RUN_LEASE_TTL_MS,
  type RunHeartbeatDependencies,
  renewRunLease,
  selfStopAfterMs,
  startRunHeartbeat,
} from './lease.js';
import { LeaseLostError, type PipelineStore } from './store.js';

const RUN = '00000000-0000-4000-8000-0000000000e1' as Id;
const NOW = '2026-09-15T10:00:00.000Z' as IsoDateTime;
const OWNER = 'server:server-1:0f0f0f0f';
/** The epoch of this process's claim (WP-274): every beat carries it. */
const EPOCH = 3;

interface Beat {
  readonly runId: Id;
  readonly owner: string;
  readonly epoch: number;
  readonly expiresAt: IsoDateTime;
}

const harness = (
  renew: (beat: Beat) => Promise<boolean>,
  onRenewed?: (runId: Id) => Promise<void>,
) => {
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
        ...(onRenewed === undefined ? {} : { onRenewed }),
      },
    },
    RUN,
    EPOCH,
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
      { runId: RUN, owner: OWNER, epoch: EPOCH, expiresAt: '2026-09-15T10:05:00.000Z' },
      { runId: RUN, owner: OWNER, epoch: EPOCH, expiresAt: '2026-09-15T10:05:00.000Z' },
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

  it('polls the run’s pending commands after a beat that renewed, and not after one that did not (WP-85)', async () => {
    const renewed: Id[] = [];
    const answers = [true, false];
    const heartbeat = harness(
      async () => answers.shift() ?? false,
      async (runId) => {
        renewed.push(runId);
      },
    );

    await heartbeat.beat();
    await heartbeat.beat();

    // The first beat renewed and polled; the second found the lease gone, polled nothing and
    // stopped — a command for a run this process no longer holds is closed by the run's ending.
    expect(renewed).toEqual([RUN]);
    expect(heartbeat.cancelled).toBe(1);
  });

  it('keeps beating when the poll throws, like a failed beat', async () => {
    let polls = 0;
    const heartbeat = harness(
      async () => true,
      async () => {
        polls += 1;
        throw new Error('the pool was empty');
      },
    );

    await heartbeat.beat();
    await heartbeat.beat();

    expect(polls).toBe(2);
    expect(heartbeat.cancelled).toBe(0);
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
        EPOCH,
      ),
    ).not.toThrow();
  });
});

/**
 * WP-274 (TD-031 §2): the renewal is fenced on the claim. These cases run over the **memory store**
 * through the real claim (`offerAndClaimInJob`), so the epoch a beat carries is one a claim granted.
 */
describe('renewRunLease is conditional on (lease_epoch, lease_owner)', () => {
  const TASK = '00000000-0000-4000-8000-0000000000e2' as Id;
  const OFFER = '00000000-0000-4000-8000-0000000000e3' as Id;
  const tx = { adapter: 'memory' } as never;

  /** One `running` run in the memory store, taken by the offer's one claim (`../testing/run-offers.ts`). */
  const claimedRun = async () => {
    const store = createMemoryPipelineStore();
    await store.runs.insert(tx, {
      id: RUN,
      taskId: TASK,
      projectId: '00000000-0000-4000-8000-0000000000e4' as Id,
      stage: null,
      role: 'developer',
      mode: 'normal',
      attempt: 1,
      model: 'claude-opus-5',
      effort: 'high',
      promptVersion: 'test@1',
      systemPrompt: null,
      userPrompt: null,
      redactionCount: 0,
      contextPack: null,
      settings: null,
      reserveUsd: null,
      promptsWithheld: null,
      providerMode: 'api',
      status: 'running',
      terminalReason: null,
      sessionId: null,
      numTurns: 0,
      usage: null,
      cost: null,
      wallMs: 0,
      createdAt: NOW,
      startedAt: NOW,
    });
    const fence = await offerAndClaimForTest(store, tx, {
      offerId: OFFER,
      runId: RUN,
      taskId: TASK,
      projectId: '00000000-0000-4000-8000-0000000000e4' as Id,
      owner: OWNER,
      expiresAt: NOW,
      now: NOW,
    });
    const depsFor = (owner: string): RunHeartbeatDependencies => ({
      unitOfWork: { transaction: async (fn) => fn({ tx } as never) },
      store,
      clock: { now: () => NOW },
      lease: { owner },
    });
    return { store, fence, depsFor };
  };

  it('renews under the epoch and owner the claim granted', async () => {
    const { store, fence, depsFor } = await claimedRun();
    expect(fence).toEqual({ epoch: 1, owner: OWNER });
    expect(await renewRunLease(depsFor(OWNER), RUN, fence.epoch)).toBe('renewed');
    expect(store.leaseOf(RUN)).toEqual({ owner: OWNER, expiresAt: '2026-09-15T10:05:00.000Z' });
  });

  it('answers lease_lost under another epoch, and writes nothing', async () => {
    const { store, depsFor } = await claimedRun();
    expect(await renewRunLease(depsFor(OWNER), RUN, 2)).toBe('lease_lost');
    expect(await renewRunLease(depsFor(OWNER), RUN, 0)).toBe('lease_lost');
    expect(store.leaseOf(RUN)).toEqual({ owner: OWNER, expiresAt: NOW });
  });

  it('answers lease_lost under another owner, and writes nothing', async () => {
    const { store, depsFor } = await claimedRun();
    expect(await renewRunLease(depsFor('server:other:00000000'), RUN, 1)).toBe('lease_lost');
    expect(store.leaseOf(RUN)).toEqual({ owner: OWNER, expiresAt: NOW });
  });

  it('answers lease_lost once the run has ended, even under its own fence', async () => {
    const { store, fence, depsFor } = await claimedRun();
    expect(await store.runs.finish(tx, { ...ENDED, lease: fence })).toBe(true);
    expect(await renewRunLease(depsFor(OWNER), RUN, fence.epoch)).toBe('lease_lost');
  });

  it('a fenced finish under another epoch throws LeaseLostError and leaves the run live', async () => {
    const { store, fence } = await claimedRun();
    const stale = { epoch: fence.epoch + 1, owner: OWNER };
    await expect(store.runs.finish(tx, { ...ENDED, lease: stale })).rejects.toBeInstanceOf(
      LeaseLostError,
    );
    await expect(
      store.runs.finish(tx, { ...ENDED, lease: { epoch: fence.epoch, owner: 'server:x' } }),
    ).rejects.toMatchObject({ code: 'lease_lost' });
    expect((await store.runs.load(tx, RUN))?.status).toBe('running');
    expect(store.offerRows()[0]?.state).toBe('claimed');
  });

  it('a fenced finish under its own claim wins the row and settles the offer', async () => {
    const { store, fence } = await claimedRun();
    expect(await store.runs.finish(tx, { ...ENDED, lease: fence })).toBe(true);
    expect(store.offerRows()[0]).toMatchObject({ state: 'settled', leaseEpoch: 1 });
  });

  it('a finish by a writer that is not the claimant (no fence) ends the row whoever holds it', async () => {
    const { store } = await claimedRun();
    expect(await store.runs.finish(tx, ENDED)).toBe(true);
    expect(store.offerRows()[0]?.state).toBe('settled');
  });

  const ENDED = {
    runId: RUN,
    status: 'completed' as const,
    terminalReason: 'success' as const,
    sessionId: null,
    numTurns: 1,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_write_5m_tokens: 0,
      cache_write_1h_tokens: 0,
      cache_read_tokens: 0,
    },
    cost: { usd: 0, is_estimate: false, price_list_id: null },
    wallMs: 1,
  };
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

/**
 * **WP-276 (TD-031 §2): a lost lease interrupts.** An answered `lease_lost` is reported at once; one
 * or two failed beats are not; and a claimant that has gone `TTL − ½·renew` on its monotonic clock
 * without a successful renewal stops itself. A fake monotonic clock and a fake one-shot timer stand
 * in for `performance.now` and `setTimeout`, so every case is about the decision, not the timer.
 */
describe('self-termination and an answered lease_lost (WP-276)', () => {
  const lossHarness = (answers: readonly ('renewed' | 'lost' | 'throws')[]) => {
    let now = 0;
    let tick: (() => void) | undefined;
    const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
    const losses: string[] = [];
    let call = 0;
    const store = {
      runs: {
        renewLease: async () => {
          const answer = answers[call] ?? 'renewed';
          call += 1;
          if (answer === 'throws') throw new Error('the database is unreachable');
          return answer === 'renewed';
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
            return () => {};
          },
          monotonicNow: () => now,
          timer: (afterMs, fire) => {
            const entry = { at: now + afterMs, fire, cancelled: false };
            timers.push(entry);
            return () => {
              entry.cancelled = true;
            };
          },
        },
        claimedAt: 0,
        onLost: (loss) => {
          losses.push(loss);
        },
      },
      RUN,
      EPOCH,
    );
    /** Moves the monotonic clock, fires every due timer, and beats once if `beat`. */
    const advance = async (toMs: number, beat: boolean) => {
      now = toMs;
      for (const timer of timers) {
        if (!timer.cancelled && timer.at <= now) {
          timer.cancelled = true;
          timer.fire();
        }
      }
      if (beat) tick?.();
      await new Promise((resolve) => setImmediate(resolve));
    };
    return { losses, stop, advance };
  };

  it('interrupts at once on an answered lease_lost', async () => {
    const { losses, advance } = lossHarness(['lost']);
    await advance(RUN_LEASE_RENEW_MS, true);
    expect(losses).toEqual(['lease_lost']);
  });

  it('lets one and two failed beats interrupt nothing, and a later success re-arms the self-stop', async () => {
    const { losses, advance } = lossHarness(['throws', 'throws', 'renewed']);
    await advance(RUN_LEASE_RENEW_MS, true);
    await advance(2 * RUN_LEASE_RENEW_MS, true);
    expect(losses).toEqual([]);
    await advance(2.4 * RUN_LEASE_RENEW_MS, true); // the third beat succeeds, sent at 240 s
    await advance(
      2.4 * RUN_LEASE_RENEW_MS + selfStopAfterMs(RUN_LEASE_TTL_MS, RUN_LEASE_RENEW_MS) - 1,
      false,
    );
    expect(losses).toEqual([]);
  });

  it('stops itself TTL − ½·renew after the last successful send, and not a millisecond before', async () => {
    const { losses, advance } = lossHarness(['throws', 'throws', 'throws']);
    const giveUp = selfStopAfterMs(RUN_LEASE_TTL_MS, RUN_LEASE_RENEW_MS);
    expect(giveUp).toBe(250_000);
    await advance(RUN_LEASE_RENEW_MS, true);
    await advance(2 * RUN_LEASE_RENEW_MS, true);
    await advance(giveUp - 1, false);
    expect(losses).toEqual([]);
    await advance(giveUp, false);
    expect(losses).toEqual(['self_terminated']);
  });

  it('counts the self-stop from the send of the last successful renewal, not from its answer', async () => {
    let now = 0;
    let tick: (() => void) | undefined;
    const timers: { at: number; fire: () => void; cancelled: boolean }[] = [];
    const losses: string[] = [];
    let answer: (renewed: boolean) => void = () => {};
    const store = {
      runs: {
        renewLease: async () =>
          new Promise<boolean>((resolve) => {
            answer = resolve;
          }),
      },
    } as unknown as PipelineStore;
    startRunHeartbeat(
      {
        unitOfWork: { transaction: async (fn) => fn({ tx: { adapter: 'memory' } } as never) },
        store,
        clock: { now: () => NOW },
        lease: {
          owner: OWNER,
          schedule: (_everyMs, beat) => {
            tick = beat;
            return () => {};
          },
          monotonicNow: () => now,
          timer: (afterMs, fire) => {
            const entry = { at: now + afterMs, fire, cancelled: false };
            timers.push(entry);
            return () => {
              entry.cancelled = true;
            };
          },
        },
        claimedAt: 0,
        onLost: (loss) => {
          losses.push(loss);
        },
      },
      RUN,
      EPOCH,
    );
    // Sent at 100 s; answered `renewed` only at 200 s.
    now = 100_000;
    tick?.();
    now = 200_000;
    answer(true);
    await new Promise((resolve) => setImmediate(resolve));
    const armed = timers.filter((timer) => !timer.cancelled).at(-1);
    // Due 250 s after the **send** (350 s), never 250 s after the answer (450 s).
    expect(armed?.at).toBe(100_000 + selfStopAfterMs(RUN_LEASE_TTL_MS, RUN_LEASE_RENEW_MS));
    expect(losses).toEqual([]);
  });

  it('reports nothing once the caller has stopped the heartbeat', async () => {
    const { losses, stop, advance } = lossHarness(['throws']);
    await stop();
    await advance(10 * RUN_LEASE_TTL_MS, true);
    expect(losses).toEqual([]);
  });
});

describe('the self-stop constants (TD-031 §2)', () => {
  it('holds both constant sets to TTL − ½·renew ≥ 2 × renew, and names their give-up instants', () => {
    expect(leaseConstantsHold(RUN_LEASE_TTL_MS, RUN_LEASE_RENEW_MS)).toBe(true);
    expect(leaseConstantsHold(REMOTE_RUN_LEASE_TTL_MS, REMOTE_RUN_LEASE_RENEW_MS)).toBe(true);
    expect(selfStopAfterMs(RUN_LEASE_TTL_MS, RUN_LEASE_RENEW_MS)).toBe(250_000);
    expect(selfStopAfterMs(REMOTE_RUN_LEASE_TTL_MS, REMOTE_RUN_LEASE_RENEW_MS)).toBe(585_000);
    // The check refuses a set that would interrupt on the second missed beat.
    expect(leaseConstantsHold(300_000, 140_000)).toBe(false);
  });

  /**
   * The property: the claimant's give-up instant precedes the sweep's earliest act by at least
   * `½·renew + grace`, whatever the request's latency up to the grace. The claimant counts from the
   * **send** of its last successful renewal; the core writes `lease_expires_at = write + TTL` at some
   * instant between the send and the answer; the sweep acts no earlier than `expires + grace`.
   */
  it('gives up at least ½·renew + grace before the sweep may act, for any latency ≤ the grace', () => {
    for (const [ttl, renew] of [
      [RUN_LEASE_TTL_MS, RUN_LEASE_RENEW_MS],
      [REMOTE_RUN_LEASE_TTL_MS, REMOTE_RUN_LEASE_RENEW_MS],
    ] as const) {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10 ** 9 }),
          fc.integer({ min: 0, max: DEFAULT_LEASE_SKEW_GRACE_MS }),
          fc.double({ min: 0, max: 1, noNaN: true }),
          (sentAt, latency, writeFraction) => {
            const coreWrite = sentAt + latency * writeFraction;
            const sweepEarliest = coreWrite + ttl + DEFAULT_LEASE_SKEW_GRACE_MS;
            const giveUp = sentAt + selfStopAfterMs(ttl, renew);
            return sweepEarliest - giveUp >= renew / 2 + DEFAULT_LEASE_SKEW_GRACE_MS;
          },
        ),
      );
    }
  });
});
