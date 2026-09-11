/**
 * BD-007's batch window, and the queue declarations behind it.
 *
 * technical/02 asks for "one `task.stage.returned` after a 2-minute debounce per MR". The `Jobs`
 * port's coalescing cannot express it — both modes are leading-edge — so the window is a `stately`
 * queue, a singleton key per merge request and a `startAfter`, with the handler re-reading every
 * unresolved thread when it fires. These are the three endings that has.
 */
import { describe, expect, it } from 'vitest';
import { JOB_QUEUES } from '../ports/jobs.js';
import { recordingJobs } from '../testing/pipeline-harness.js';
import { declarePipelineQueues, enqueueReviewCommentWindow, GATE_RECHECK_MS } from './jobs.js';

const NOW = new Date('2026-06-01T09:00:00.000Z');

describe('the review-comment window', () => {
  it('is a delayed singleton per merge request, and never a coalesced job', async () => {
    const jobs = recordingJobs();
    await enqueueReviewCommentWindow(jobs, {
      taskId: '00000000-0000-4000-8000-000000000001',
      projectId: '00000000-0000-4000-8000-0000000000b1',
      iid: 7,
      windowMs: 120_000,
      now: NOW,
    });
    const [request] = jobs.enqueued;
    expect(request?.queue).toBe(JOB_QUEUES.mrCommentDebounce);
    expect(request?.singletonKey).toBe('mr:7');
    expect(request?.startAfter?.toISOString()).toBe('2026-06-01T09:02:00.000Z');
    // The port refuses `coalesce` with `startAfter`, and both coalescing modes are leading-edge:
    // the first comment of a burst would bounce the task back while the human was still typing.
    expect(request?.coalesce).toBeUndefined();
  });

  it('declares the queues with the policies TD-004 names', async () => {
    const declared: { name: string; policy?: string; expireInSeconds?: number }[] = [];
    await declarePipelineQueues({
      ...recordingJobs(),
      defineQueue: async (definition) => {
        declared.push(definition);
      },
    });
    expect(declared).toEqual([
      expect.objectContaining({ name: JOB_QUEUES.stageExecute, policy: 'stately' }),
      expect.objectContaining({ name: JOB_QUEUES.mrCommentDebounce, policy: 'stately' }),
    ]);
    // A stage is a whole agent run; the 15-minute default would call it lost mid-way.
    const stage = declared.find((entry) => entry.name === JOB_QUEUES.stageExecute);
    expect(stage?.expireInSeconds).toBeGreaterThan(15 * 60);
  });
});

describe('the gate re-check delay', () => {
  it('is not zero, because a gate that re-enqueues itself immediately is a spin', () => {
    // Measured as a defect before it existed: five checks in a few milliseconds parked the task
    // for a human before the pipeline it was waiting for had started.
    expect(GATE_RECHECK_MS).toBeGreaterThan(1000);
  });
});
