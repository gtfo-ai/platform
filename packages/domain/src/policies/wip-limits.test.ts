/** `resolveWipLimits` — WP-91, backlog 224: the project's value, bounded by the organisation's. */
import { describe, expect, it } from 'vitest';
import { DEFAULT_WIP_LIMITS, resolveWipLimits } from './wip.js';

describe('resolveWipLimits', () => {
  it('is BD-010 when nobody states anything', () => {
    expect(resolveWipLimits(undefined, undefined)).toEqual({
      limits: DEFAULT_WIP_LIMITS,
      bounded: [],
    });
  });

  it('takes the project’s value below the organisation’s, and the organisation’s above it', () => {
    expect(
      resolveWipLimits({ max_parallel_tasks: 1 }, { max_parallel_tasks: 3 }).limits,
    ).toMatchObject({ maxParallelTasks: 1 });
    const bounded = resolveWipLimits({ max_parallel_tasks: 4 }, { max_parallel_tasks: 3 });
    expect(bounded.limits.maxParallelTasks).toBe(3);
    expect(bounded.bounded).toEqual([
      { key: 'pipeline.wip.max_parallel_tasks', stated: 4, bound: 3 },
    ]);
    // At the bound exactly, nothing is lowered and nothing reported.
    expect(resolveWipLimits({ max_parallel_tasks: 3 }, { max_parallel_tasks: 3 }).bounded).toEqual(
      [],
    );
  });

  it('takes the per-person default from the organisation, lets a project tighten it, never raise it (S-28.6)', () => {
    expect(resolveWipLimits(undefined, { max_tasks_per_owner: 5 }).limits).toMatchObject({
      maxTasksPerOwner: 5,
      ownerLimitMaximum: 5,
    });
    expect(
      resolveWipLimits({ max_tasks_per_owner: 2 }, { max_tasks_per_owner: 5 }).limits,
    ).toMatchObject({ maxTasksPerOwner: 2, ownerLimitMaximum: 5 });
    const bounded = resolveWipLimits({ max_tasks_per_owner: 9 }, { max_tasks_per_owner: 5 });
    expect(bounded.limits.maxTasksPerOwner).toBe(5);
    expect(bounded.bounded).toEqual([
      { key: 'pipeline.wip.max_tasks_per_owner', stated: 9, bound: 5 },
    ]);
  });

  it('bounds a default the organisation set lower, and never touches the run limit', () => {
    const result = resolveWipLimits(undefined, { max_tasks_in_pipeline: 2 });
    expect(result.limits).toEqual({
      ...DEFAULT_WIP_LIMITS,
      maxTasksInPipeline: 2,
    });
    expect(result.bounded).toEqual([
      { key: 'pipeline.wip.max_tasks_in_pipeline', stated: 5, bound: 2 },
    ]);
  });
});
