/** The run page's job list (S-23.10): the task's runs in stage order, in words. */
import type { RunRecord } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { isFailedRun, isLiveRun, jobLabel, jobsInStageOrder, RUN_STATUS_ICON } from './run-jobs.js';

type Job = Pick<RunRecord, 'id' | 'stage' | 'attempt' | 'started_at' | 'role'>;

const job = (id: string, stage: string | null, attempt: number, startedAt: string | null): Job => ({
  id,
  stage,
  attempt,
  started_at: startedAt,
  role: 'developer',
});

const rows = (...stages: string[]) => stages.map((stage) => ({ stage }));

describe('jobsInStageOrder', () => {
  it('orders by the stage’s first entry, then by attempt, then by start', () => {
    const runs = [
      job('review', 'code_review', 1, '2026-11-05T11:00:00.000Z'),
      job('impl-2', 'implementation', 2, '2026-11-05T10:30:00.000Z'),
      job('impl-1b', 'implementation', 1, '2026-11-05T10:10:00.000Z'),
      job('impl-1a', 'implementation', 1, '2026-11-05T10:00:00.000Z'),
      job('refine', 'refinement', 1, '2026-11-05T09:00:00.000Z'),
    ];
    // Implementation was re-entered after the review: its first entry decides its place.
    const order = jobsInStageOrder(
      runs,
      rows('refinement', 'implementation', 'code_review', 'implementation'),
    );
    expect(order.map((run) => run.id)).toEqual([
      'refine',
      'impl-1a',
      'impl-1b',
      'impl-2',
      'review',
    ]);
  });

  it('keeps a run whose stage the rows do not name, after them, and an ask run last', () => {
    const order = jobsInStageOrder(
      [job('ask', null, 1, null), job('odd', 'qa', 1, null), job('refine', 'refinement', 1, null)],
      rows('refinement'),
    );
    expect(order.map((run) => run.id)).toEqual(['refine', 'odd', 'ask']);
  });

  it('does not reorder its input', () => {
    const runs = [job('b', 'implementation', 1, null), job('a', 'refinement', 1, null)];
    jobsInStageOrder(runs, rows('refinement', 'implementation'));
    expect(runs.map((run) => run.id)).toEqual(['b', 'a']);
  });
});

describe('a job in words', () => {
  it('names the stage, the attempt past the first, and the role of a run with no stage', () => {
    expect(jobLabel({ stage: 'implementation', attempt: 1, role: 'developer' })).toBe(
      'Implementation',
    );
    expect(jobLabel({ stage: 'implementation', attempt: 3, role: 'developer' })).toBe(
      'Implementation · attempt 3',
    );
    expect(jobLabel({ stage: null, attempt: 1, role: 'facilitator' })).toBe('Facilitator');
  });

  it('reads every live and every failed status the same way the icon does', () => {
    expect(['created', 'starting', 'running'].every((s) => isLiveRun(s as never))).toBe(true);
    expect(isLiveRun('completed')).toBe(false);
    const failed = Object.entries(RUN_STATUS_ICON)
      .filter(([, icon]) => icon === 'failure')
      .map(([status]) => status)
      .sort();
    expect(failed).toEqual(['budget_exceeded', 'failed', 'stalled', 'timed_out']);
    expect(failed.every((status) => isFailedRun(status as never))).toBe(true);
    expect(isFailedRun('cancelled')).toBe(false);
  });
});
