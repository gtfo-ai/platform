/**
 * S-25.21 (BACKLOG 1369): what a raised WIP limit records — {@link raisedWipLimits} over both
 * limits in both directions, and the recorder's one `config.changed` on the project's stream (or
 * nothing). That the scheduler then starts the queue is `saga.test.ts`'s; that the two writes call
 * it is `test/e2e/server/org-settings.e2e.test.ts`'s.
 */
import type { DomainEvent } from '@platform/contracts';
import { DEFAULT_WIP_LIMITS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { createPipelineHarness } from '../testing/pipeline-harness.js';
import { createWipRaisedRecorder, raisedWipLimits } from './wip-raised.js';

describe('raisedWipLimits', () => {
  it('names each limit that rose, with both values, and nothing that fell or stayed', () => {
    expect(raisedWipLimits(DEFAULT_WIP_LIMITS, DEFAULT_WIP_LIMITS)).toEqual([]);
    expect(
      raisedWipLimits(DEFAULT_WIP_LIMITS, {
        ...DEFAULT_WIP_LIMITS,
        maxParallelTasks: 3,
        maxTasksInPipeline: 4,
      }),
    ).toEqual([{ key: 'pipeline.wip.max_parallel_tasks', from: 2, to: 3 }]);
    expect(
      raisedWipLimits(
        { ...DEFAULT_WIP_LIMITS, maxParallelTasks: 1, maxTasksInPipeline: 1 },
        DEFAULT_WIP_LIMITS,
      ),
    ).toEqual([
      { key: 'pipeline.wip.max_parallel_tasks', from: 1, to: 2 },
      { key: 'pipeline.wip.max_tasks_in_pipeline', from: 1, to: 5 },
    ]);
    // `maxParallelRuns` is the organisation's own limit and no write here moves it.
    expect(
      raisedWipLimits(DEFAULT_WIP_LIMITS, { ...DEFAULT_WIP_LIMITS, maxParallelRuns: 9 }),
    ).toEqual([]);
  });
});

describe('createWipRaisedRecorder', () => {
  const ACTOR = { kind: 'user', user_id: '00000000-0000-4000-8000-0000000000e1' } as const;

  it('appends one config.changed on the project’s stream for a raise, and nothing for none', async () => {
    const harness = createPipelineHarness();
    const recorder = createWipRaisedRecorder({
      unitOfWork: harness.memory,
      ids: harness.ids,
      clock: { now: () => '2026-11-09T10:00:00.000Z' },
    });
    await recorder.record({ projectId: harness.projectId, scope: 'org', raised: [], actor: ACTOR });
    expect(harness.events().filter((entry) => entry.type === 'config.changed')).toEqual([]);

    await recorder.record({
      projectId: harness.projectId,
      scope: 'org',
      raised: [{ key: 'pipeline.wip.max_tasks_in_pipeline', from: 1, to: 2 }],
      actor: ACTOR,
    });
    const changed = harness
      .events()
      .filter(
        (entry): entry is Extract<DomainEvent, { type: 'config.changed' }> =>
          entry.type === 'config.changed',
      );
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({
      stream_type: 'project',
      stream_id: harness.projectId,
      actor: ACTOR,
      payload: {
        project_id: harness.projectId,
        scope: 'org',
        scope_id: null,
        diff: [{ key: 'pipeline.wip.max_tasks_in_pipeline', from: '1', to: '2' }],
      },
    });
  });
});
