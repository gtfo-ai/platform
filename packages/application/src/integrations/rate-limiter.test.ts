/**
 * The token bucket and the concurrency gate (technical/06 § "Outbound: actions").
 *
 * Time is virtual throughout: every assertion is on the *duration the limiter asked to wait*,
 * never on elapsed wall-clock time, so the verdict is about the algorithm rather than about how
 * busy the CI runner is.
 */
import { describe, expect, it } from 'vitest';
import { createVirtualTimer } from '../testing/memory-integrations.js';
import { createRateLimiter, DEFAULT_RATE_LIMIT_POLICY } from './rate-limiter.js';

const flushMicrotasks = async (turns = 20): Promise<void> => {
  for (let turn = 0; turn < turns; turn += 1) {
    await Promise.resolve();
  }
};

describe('createRateLimiter', () => {
  it('rejects a policy that could never let anything through', () => {
    const timer = createVirtualTimer();
    expect(() => createRateLimiter({ ...DEFAULT_RATE_LIMIT_POLICY, capacity: 0 }, timer)).toThrow(
      /capacity/,
    );
    expect(() =>
      createRateLimiter({ ...DEFAULT_RATE_LIMIT_POLICY, refillPerSecond: 0 }, timer),
    ).toThrow(/refillPerSecond/);
    expect(() =>
      createRateLimiter({ ...DEFAULT_RATE_LIMIT_POLICY, maxConcurrent: 0 }, timer),
    ).toThrow(/maxConcurrent/);
  });

  it('spends the burst without waiting and then waits for a refill', async () => {
    const timer = createVirtualTimer({ autoAdvance: true });
    const limiter = createRateLimiter({ capacity: 2, refillPerSecond: 2, maxConcurrent: 4 }, timer);

    (await limiter.acquire()).release();
    (await limiter.acquire()).release();
    expect(timer.sleeps).toEqual([]);

    (await limiter.acquire()).release();
    expect(timer.sleeps).toEqual([500]);
  });

  it('honours a penalty for the whole limiter, not for one caller', async () => {
    const timer = createVirtualTimer({ autoAdvance: true });
    const limiter = createRateLimiter(
      { capacity: 10, refillPerSecond: 10, maxConcurrent: 4 },
      timer,
    );

    limiter.penalise(3000);
    expect(limiter.snapshot().blockedForMs).toBe(3000);

    (await limiter.acquire()).release();
    expect(timer.sleeps).toEqual([3000]);

    // The penalty is spent, not sticky.
    (await limiter.acquire()).release();
    expect(timer.sleeps).toEqual([3000]);
  });

  it('keeps the longer of two penalties', () => {
    const timer = createVirtualTimer();
    const limiter = createRateLimiter(DEFAULT_RATE_LIMIT_POLICY, timer);
    limiter.penalise(5000);
    limiter.penalise(1000);
    expect(limiter.snapshot().blockedForMs).toBe(5000);
    expect(() => limiter.penalise(-1)).toThrow(TypeError);
  });

  it('hands out at most `maxConcurrent` slots at a time', async () => {
    const timer = createVirtualTimer({ autoAdvance: true });
    const limiter = createRateLimiter(
      { capacity: 100, refillPerSecond: 100, maxConcurrent: 2 },
      timer,
    );

    const first = await limiter.acquire();
    const second = await limiter.acquire();
    let thirdAcquired = false;
    const third = limiter.acquire().then((lease) => {
      thirdAcquired = true;
      return lease;
    });

    await flushMicrotasks();
    expect(thirdAcquired).toBe(false);
    expect(limiter.snapshot()).toMatchObject({ active: 2, waiting: 1 });

    first.release();
    await third;
    expect(thirdAcquired).toBe(true);
    second.release();
    (await third).release();
    expect(limiter.snapshot().active).toBe(0);
  });

  it('ignores a second release, so a slot can never be handed out twice', async () => {
    const timer = createVirtualTimer({ autoAdvance: true });
    const limiter = createRateLimiter(
      { capacity: 100, refillPerSecond: 100, maxConcurrent: 1 },
      timer,
    );

    const lease = await limiter.acquire();
    lease.release();
    lease.release();
    expect(limiter.snapshot().active).toBe(0);

    // With a double release corrupting the counter, this second waiter would run immediately and
    // the assertion below would see `active: 2`.
    const held = await limiter.acquire();
    let extraAcquired = false;
    void limiter.acquire().then(() => {
      extraAcquired = true;
    });
    await flushMicrotasks();
    expect(extraAcquired).toBe(false);
    expect(limiter.snapshot().active).toBe(1);
    held.release();
  });

  it('releases the slot when the timer itself fails', async () => {
    const timer = createVirtualTimer();
    const exploding = {
      now: timer.now,
      sleep: () => {
        throw new Error('clock stopped');
      },
    };
    const limiter = createRateLimiter(
      { capacity: 1, refillPerSecond: 1, maxConcurrent: 1 },
      exploding,
    );

    (await limiter.acquire()).release();
    await expect(limiter.acquire()).rejects.toThrow('clock stopped');
    expect(limiter.snapshot().active).toBe(0);
  });
});
