import { describe, expect, it } from 'vitest';
import {
  COLLECTION_BOUND_MS,
  createCollectionWatchdog,
  processTree,
  stallLine,
} from './vitest-bounded.mjs';

/**
 * The collection bound's pure halves (WP-213, backlog 597). The runner itself, against planted
 * stalls, crashes, long tests and signals, is `scripts/collection-watchdog.test.ts` in the
 * `process` project.
 */
describe('the collection watchdog', () => {
  const unit = (file: string) => ({ project: 'unit', file });

  it('names a file once it and the run have been quiet for the bound, and not a millisecond before', () => {
    const watchdog = createCollectionWatchdog(1_000, 0);
    watchdog.queued(unit('a.test.ts'), 0);
    expect(watchdog.stalled(999)).toBeNull();
    expect(watchdog.stalled(1_000)).toBe('a.test.ts');
  });

  it('names the file still collecting, never the last one collected', () => {
    const watchdog = createCollectionWatchdog(1_000, 0);
    watchdog.queued(unit('stuck.test.ts'), 0);
    watchdog.queued(unit('quick.test.ts'), 10);
    watchdog.collected(unit('quick.test.ts'), 20);
    expect(watchdog.stalled(1_020)).toBe('stuck.test.ts');
  });

  it('does not stop a run that is still doing something, whatever file was left behind (a crashed worker)', () => {
    const watchdog = createCollectionWatchdog(1_000, 0);
    watchdog.queued(unit('crashed.test.ts'), 0);
    watchdog.active(900);
    expect(watchdog.stalled(1_899)).toBeNull();
    expect(watchdog.stalled(1_900)).toBe('crashed.test.ts');
  });

  it('never stops a long test: nothing is collecting', () => {
    const watchdog = createCollectionWatchdog(1_000, 0);
    watchdog.queued(unit('long.test.ts'), 0);
    watchdog.collected(unit('long.test.ts'), 10);
    expect(watchdog.stalled(60_000)).toBeNull();
  });

  it('keeps one project’s file apart from the same path in another', () => {
    const watchdog = createCollectionWatchdog(1_000, 0);
    watchdog.queued(unit('a.test.ts'), 0);
    watchdog.queued({ project: 'contract', file: 'a.test.ts' }, 0);
    watchdog.collected(unit('a.test.ts'), 0);
    expect(watchdog.stalled(1_000)).toBe('a.test.ts');
  });

  it('is two minutes, thirty times the slowest collection measured on main', () => {
    expect(COLLECTION_BOUND_MS).toBe(120_000);
  });

  it('prints the line the row specifies', () => {
    expect(stallLine('verify:tests', 'a/b.test.ts')).toBe(
      'FAIL: verify:tests — collection stalled in a/b.test.ts',
    );
  });
});

describe('the process tree the watchdog stops', () => {
  it('is the root and its descendants, parents first, and nobody else', () => {
    const table: [number, number][] = [
      [1, 0],
      [10, 1],
      [20, 10],
      [21, 10],
      [30, 20],
      [40, 1],
    ];
    expect(processTree(10, table)).toEqual([10, 20, 21, 30]);
    expect(processTree(99, table)).toEqual([99]);
  });
});
