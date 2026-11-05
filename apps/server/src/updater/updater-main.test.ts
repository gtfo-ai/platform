import { afterEach, describe, expect, it, vi } from 'vitest';
import { refSleep } from './main.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the updater processes’ wait', () => {
  it('holds the event loop open: an unref’d timer let the updater exit mid-poll (measured, S-22.10)', async () => {
    const spy = vi.spyOn(globalThis, 'setTimeout');
    await refSleep(1);
    const timer = spy.mock.results[0]?.value as NodeJS.Timeout;
    expect(typeof timer.hasRef).toBe('function');
    expect(timer.hasRef()).toBe(true);
  });
});
