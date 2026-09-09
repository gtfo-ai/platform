/**
 * The real timer.
 *
 * Deliberately three small assertions and no timing one: "a `setTimeout` fires after roughly N
 * milliseconds" is a fact about the platform, not about this code, and asserting it on a 2-core
 * CI runner buys a flake instead of a guarantee. What matters here is that the adapter resolves,
 * validates its input, and reads a clock that moves forward.
 */
import { describe, expect, it } from 'vitest';
import { systemTimer } from './system-timer.js';

describe('systemTimer', () => {
  it('reads a clock that does not go backwards', () => {
    const first = systemTimer.now();
    const second = systemTimer.now();
    expect(second).toBeGreaterThanOrEqual(first);
  });

  it('resolves a zero-length sleep', async () => {
    await expect(systemTimer.sleep(0)).resolves.toBeUndefined();
  });

  it('rejects a duration that is not a duration', async () => {
    expect(() => systemTimer.sleep(-1)).toThrow(TypeError);
    expect(() => systemTimer.sleep(Number.NaN)).toThrow(TypeError);
  });
});
