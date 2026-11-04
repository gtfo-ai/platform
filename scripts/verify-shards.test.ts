import { describe, expect, it } from 'vitest';
import { isShardRun } from '../vitest.config.js';
import {
  BOUNDED_VITEST,
  blobName,
  blobSetProblem,
  parseVerifyMode,
  shardArgs,
  shardableStep,
} from './verify-shards.mjs';

describe('verify.mjs’s split modes', () => {
  it('reads a whole run, a part and a merge, and refuses anything else by name', () => {
    expect(parseVerifyMode([])).toEqual({ kind: 'whole' });
    expect(parseVerifyMode(['--shard', '2/3'])).toEqual({ kind: 'shard', index: 2, count: 3 });
    expect(parseVerifyMode(['--merge-reports', '.vitest-reports'])).toEqual({
      kind: 'merge',
      dir: '.vitest-reports',
    });
    for (const bad of [
      ['--shard', '0/3'],
      ['--shard', '4/3'],
      ['--shard', '1/0'],
      ['--shard', '1-3'],
      ['--shard'],
      ['--shard', ''],
      ['--merge-reports'],
      ['--shard', '1/3', '--merge-reports', 'x'],
      ['--', '--shard', '1/3'],
      ['--bail', '1'],
    ]) {
      expect(() => parseVerifyMode(bad), JSON.stringify(bad)).toThrow();
    }
  });

  it('splits the one vitest step of a target, and refuses a target with none or two', () => {
    const scripts = {
      test: `${BOUNDED_VITEST}--project unit --coverage`,
      'test:ui': `${BOUNDED_VITEST}--project ui`,
      'coverage:ratchet': 'node scripts/coverage-ratchet.mjs',
      lint: 'biome check .',
    };
    expect(shardableStep('verify:tests', ['test', 'coverage:ratchet'], scripts)).toBe('test');
    expect(() => shardableStep('verify:static', ['lint'], scripts)).toThrow(/0 vitest steps/);
    expect(() => shardableStep('verify', ['lint', 'test', 'test:ui'], scripts)).toThrow(
      /2 vitest steps \(test, test:ui\)/,
    );
  });

  it('gives a part its shard, a blob named for it and the reporter a person reads', () => {
    expect(shardArgs(2, 3)).toEqual([
      '--shard=2/3',
      '--reporter=default',
      '--reporter=blob',
      '--outputFile.blob=.vitest-reports/blob-2-3.json',
    ]);
  });

  it('merges only a complete set of parts', () => {
    const set = (count: number, ...indices: number[]) => indices.map((i) => blobName(i, count));
    expect(blobSetProblem(set(3, 1, 2, 3), 'r')).toBeNull();
    expect(blobSetProblem(set(1, 1), 'r')).toBeNull();
    // The case that matters: a part that never reported would make a smaller pass.
    expect(blobSetProblem(set(3, 1, 3), 'r')).toMatch(/missing blob-2-3\.json/);
    expect(blobSetProblem(null, 'r')).toMatch(/does not exist/);
    expect(blobSetProblem([], 'r')).toMatch(/empty/);
    expect(blobSetProblem([...set(3, 1, 2, 3), ...set(2, 1)], 'r')).toMatch(/2 different splits/);
    expect(blobSetProblem([...set(2, 1, 2), 'notes.txt'], 'r')).toMatch(/notes\.txt/);
    expect(blobSetProblem(set(2, 1, 2, 3), 'r')).toMatch(/outside 1–2: blob-3-2\.json/);
  });
});

describe('the coverage thresholds of a split run (vitest.config.ts)', () => {
  it('are left to the merge in a part, and checked everywhere else', () => {
    expect(isShardRun(['node', 'vitest.mjs', 'run', '--shard=1/3'])).toBe(true);
    expect(isShardRun(['node', 'vitest.mjs', 'run', '--shard', '1/3'])).toBe(true);
    // The merge carries no `--shard`, so the thresholds are checked on the whole.
    expect(isShardRun(['node', 'vitest.mjs', 'run', '--merge-reports=.vitest-reports'])).toBe(
      false,
    );
    expect(isShardRun(['node', 'vitest.mjs', 'run', '--coverage'])).toBe(false);
    expect(isShardRun(['node', 'vitest.mjs', 'run', '--sharded-thing'])).toBe(false);
  });
});
