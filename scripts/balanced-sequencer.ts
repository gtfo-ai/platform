/**
 * The `sequence.sequencer` of `vitest.config.ts`: vitest's own `BaseSequencer` everywhere except a
 * split run (`--shard`, `scripts/verify.mjs`), where it gives each part its files by measured
 * duration (`./shard-balance.ts` has the rule and its four properties) and runs them longest first.
 *
 * The hook is `TestSequencer.shard(files)`, which vitest 5.0.0 calls once per run with **every**
 * project's files (`createPool` → `sequencer.shard`, then `sequencer.sort` over what it returned);
 * the sequencer is read from the root configuration only, so one class serves `unit`, `contract`,
 * `process` and `e2e-fake-claude` alike.
 *
 * `vitest/node` is imported **lazily**, inside `sort`, and only for a run that is not split: several
 * unit tests import `vitest.config.ts` for its exported constants, and a static import would load
 * vitest's whole node API into each of those workers.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TestSequencer, TestSpecification, Vitest } from 'vitest/node';
import { assignParts, fileKey, longestFirst, type ShardTimings } from './shard-balance.js';

/** The checked-in table, read when a split run first needs it (`node scripts/shard-timings.mjs`). */
export const SHARD_TIMINGS_PATH = fileURLToPath(new URL('./shard-timings.json', import.meta.url));

let timings: ShardTimings | undefined;
const readTimings = (): ShardTimings => {
  timings ??= JSON.parse(readFileSync(SHARD_TIMINGS_PATH, 'utf8')) as ShardTimings;
  return timings;
};

const describeSpec = (root: string, spec: TestSpecification) => ({
  file: {
    key: fileKey(spec.project.name, relative(root, resolve(root, spec.moduleId))),
    project: spec.project.name,
  },
  groupOrder: spec.project.config.sequence.groupOrder ?? 0,
});

export class BalancedSequencer implements TestSequencer {
  private readonly ctx: Vitest;

  constructor(ctx: Vitest) {
    this.ctx = ctx;
  }

  async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const root = this.ctx.config.root;
    const byKey = new Map(files.map((spec) => [describeSpec(root, spec).file.key, spec]));
    const parts = assignParts(
      files.map((spec) => describeSpec(root, spec).file),
      readTimings(),
      count,
    );
    return (parts[index - 1] ?? []).map((file) => byKey.get(file.key) as TestSpecification);
  }

  async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    if (this.ctx.config.shard) {
      const root = this.ctx.config.root;
      return longestFirst(files, (spec) => describeSpec(root, spec), readTimings());
    }
    const { BaseSequencer } = await import('vitest/node');
    return new BaseSequencer(this.ctx).sort(files);
  }
}
