import { describe, expect, it, vi } from 'vitest';
import { createAsyncQueue, deferred } from './async-queue.js';
import { manualClock, systemClock } from './clock.js';

describe('manualClock', () => {
  it('does not move on its own', () => {
    const clock = manualClock(1_000);
    const fired = vi.fn();
    clock.setTimer(50, fired);
    expect(clock.now()).toBe(1_000);
    expect(fired).not.toHaveBeenCalled();
  });

  it('fires timers in deadline order, not registration order', () => {
    const clock = manualClock();
    const order: string[] = [];
    clock.setTimer(500, () => order.push('wall-clock'));
    clock.setTimer(100, () => order.push('stall'));
    clock.advance(1_000);
    expect(order).toEqual(['stall', 'wall-clock']);
  });

  it('sets `now` to each timer’s own deadline while it runs', () => {
    const clock = manualClock();
    const seen: number[] = [];
    clock.setTimer(30, () => seen.push(clock.now()));
    clock.setTimer(10, () => seen.push(clock.now()));
    clock.advance(100);
    expect(seen).toEqual([10, 30]);
    expect(clock.now()).toBe(100);
  });

  it('runs a timer armed from inside a callback within the same advance', () => {
    const clock = manualClock();
    const fired: string[] = [];
    clock.setTimer(10, () => {
      fired.push('first');
      clock.setTimer(10, () => fired.push('re-armed'));
    });
    clock.advance(100);
    expect(fired).toEqual(['first', 're-armed']);
  });

  it('cancels', () => {
    const clock = manualClock();
    const fired = vi.fn();
    clock.setTimer(10, fired)();
    clock.advance(100);
    expect(fired).not.toHaveBeenCalled();
    expect(clock.pending).toBe(0);
  });
});

describe('systemClock', () => {
  it('reads the wall clock and cancels a real timer', () => {
    const before = Date.now();
    expect(systemClock.now()).toBeGreaterThanOrEqual(before);
    const fired = vi.fn();
    systemClock.setTimer(60_000, fired)();
    expect(fired).not.toHaveBeenCalled();
  });
});

describe('createAsyncQueue', () => {
  it('hands out values already buffered before anyone reads', async () => {
    const queue = createAsyncQueue<number>();
    queue.push(1);
    queue.push(2);
    queue.close();
    const read: number[] = [];
    for await (const value of queue.iterable) {
      read.push(value);
    }
    expect(read).toEqual([1, 2]);
  });

  it('wakes a waiting consumer when a value arrives later', async () => {
    const queue = createAsyncQueue<string>();
    const iterator = queue.iterable[Symbol.asyncIterator]();
    const next = iterator.next();
    queue.push('steer');
    await expect(next).resolves.toEqual({ value: 'steer', done: false });
  });

  it('ends a waiting consumer on close, which is how the session is told there are no more turns', async () => {
    const queue = createAsyncQueue<string>();
    const iterator = queue.iterable[Symbol.asyncIterator]();
    const next = iterator.next();
    queue.close();
    await expect(next).resolves.toEqual({ value: undefined, done: true });
    expect(queue.closed).toBe(true);
  });

  it('drops a push after close rather than reopening the session', async () => {
    const queue = createAsyncQueue<string>();
    queue.close();
    queue.push('too late');
    const iterator = queue.iterable[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });
});

describe('deferred', () => {
  it('settles once, with the first value', async () => {
    const gate = deferred<string>();
    gate.resolve('stalled');
    gate.resolve('timed_out');
    await expect(gate.promise).resolves.toBe('stalled');
  });
});
