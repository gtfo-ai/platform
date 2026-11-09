/**
 * `queue_wait`'s pure half (S-25.16): the scheduler's admission over the project's live tasks, the
 * queue's order and the holders. The database half — the statement, the counts the store takes,
 * the routes — is `test/integration/server/queue-wait.integration.test.ts`.
 */
import { MAX_QUEUE_WAIT_HOLDERS, type TaskState } from '@platform/contracts';
import { DEFAULT_WIP_LIMITS } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { queueWaitsOf } from './queue-wait.js';

let sequence = 0;
const task = (
  state: TaskState,
  options: { readonly priority?: string | null; readonly minute?: number } = {},
) => {
  sequence += 1;
  return {
    id: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, '0')}`,
    state,
    ticketKey: `AUT-${6800 + sequence}`,
    priority: options.priority ?? null,
    createdAt: new Date(Date.UTC(2026, 10, 6, 9, options.minute ?? sequence)),
  };
};

describe('queueWaitsOf', () => {
  it('names the pipeline limit, the holders and the position — the Autix shape', () => {
    const stopped = Array.from({ length: 5 }, () => task('needs_human'));
    const first = task('queued', { minute: 1 });
    const second = task('queued', { minute: 2 });
    const live = [...stopped, second, first];
    const answers = queueWaitsOf(live, [second.id, first.id], DEFAULT_WIP_LIMITS);
    expect(answers.get(second.id)).toEqual({
      status: 'waiting',
      reason: 'max_tasks_in_pipeline',
      count: 5,
      limit: 5,
      organisation_bound: false,
      position: 2,
      queued: 2,
      running: { count: 0, limit: 2 },
      pipeline: { count: 5, limit: 5 },
      holders: {
        total: 5,
        needs_human: 5,
        items: stopped.map((held) => ({
          task_id: held.id,
          ticket_key: held.ticketKey,
          state: 'needs_human',
        })),
      },
    });
    expect(answers.get(first.id)).toMatchObject({ position: 1 });
  });

  it('orders the queue as the scheduler does: priority, then age', () => {
    const old = task('queued', { minute: 1 });
    const urgent = task('queued', { priority: 'Highest', minute: 30 });
    const answers = queueWaitsOf([old, urgent], [old.id, urgent.id], DEFAULT_WIP_LIMITS);
    expect(answers.get(urgent.id)).toMatchObject({ status: 'admitted', position: 1, queued: 2 });
    expect(answers.get(old.id)).toMatchObject({ status: 'admitted', position: 2, queued: 2 });
  });

  it('answers admitted when the limits have room, with no holders', () => {
    const queued = task('queued');
    const answers = queueWaitsOf(
      [task('active'), task('needs_human'), queued],
      [queued.id],
      DEFAULT_WIP_LIMITS,
    );
    expect(answers.get(queued.id)).toEqual({
      status: 'admitted',
      position: 1,
      queued: 1,
      running: { count: 1, limit: 2 },
      pipeline: { count: 2, limit: 5 },
    });
  });

  it('names the running tasks for the parallel limit, never a stopped one', () => {
    const running = [task('active'), task('returned')];
    const queued = task('queued');
    const answers = queueWaitsOf(
      [task('needs_human'), ...running, queued],
      [queued.id],
      DEFAULT_WIP_LIMITS,
    );
    expect(answers.get(queued.id)).toMatchObject({
      status: 'waiting',
      reason: 'max_parallel_tasks',
      count: 2,
      limit: 2,
      holders: { total: 2, needs_human: 0 },
    });
    const wait = answers.get(queued.id);
    expect(wait?.status === 'waiting' ? wait.holders.items.map((h) => h.task_id) : []).toEqual(
      running.map((held) => held.id),
    );
  });

  it('carries both limits, and lists the pipeline’s holders when it is full too — review case (a)', () => {
    // 2 running + 3 stopped: the parallel limit refuses first, and the pipeline is full as well.
    const running = [task('active'), task('active')];
    const stopped = [task('needs_human'), task('needs_human'), task('needs_human')];
    const queued = task('queued');
    const wait = queueWaitsOf(
      [...running, ...stopped, queued],
      [queued.id],
      DEFAULT_WIP_LIMITS,
    ).get(queued.id);
    expect(wait).toMatchObject({
      status: 'waiting',
      reason: 'max_parallel_tasks',
      count: 2,
      limit: 2,
      running: { count: 2, limit: 2 },
      pipeline: { count: 5, limit: 5 },
      holders: { total: 5, needs_human: 3 },
    });
  });

  it('applies the limits it is given, not the defaults', () => {
    const queued = task('queued');
    const live = [task('needs_human'), queued];
    const tight = { ...DEFAULT_WIP_LIMITS, maxTasksInPipeline: 1 };
    expect(queueWaitsOf(live, [queued.id], tight).get(queued.id)?.status).toBe('waiting');
    expect(queueWaitsOf(live, [queued.id], DEFAULT_WIP_LIMITS).get(queued.id)?.status).toBe(
      'admitted',
    );
  });

  it('lists people-waiting holders first, cut at the cap with the totals beside', () => {
    const paused = Array.from({ length: 6 }, () => task('paused'));
    const stopped = Array.from({ length: 6 }, () => task('needs_human'));
    const queued = task('queued');
    const limits = { ...DEFAULT_WIP_LIMITS, maxParallelTasks: 20, maxTasksInPipeline: 12 };
    const wait = queueWaitsOf([...paused, ...stopped, queued], [queued.id], limits).get(queued.id);
    if (wait?.status !== 'waiting') {
      throw new Error(`expected a wait, got ${JSON.stringify(wait)}`);
    }
    expect(wait.holders.total).toBe(12);
    expect(wait.holders.needs_human).toBe(6);
    expect(wait.holders.items).toHaveLength(MAX_QUEUE_WAIT_HOLDERS);
    expect(wait.holders.items.slice(0, 6).every((held) => held.state === 'needs_human')).toBe(true);
    expect(wait.holders.items[6]?.state).toBe('paused');
  });

  it('says the organisation binds only when the refusing limit is one it lowered (S-25.21)', () => {
    const queued = task('queued');
    const live = [task('active'), task('active'), queued];
    const bound = (keys: Parameters<typeof queueWaitsOf>[3]) => {
      const wait = queueWaitsOf(live, [queued.id], DEFAULT_WIP_LIMITS, keys).get(queued.id);
      return wait?.status === 'waiting' ? wait.organisation_bound : null;
    };
    // The parallel limit (2) refuses: bound when it is the lowered one, not when the other is.
    expect(bound(['pipeline.wip.max_parallel_tasks'])).toBe(true);
    expect(bound(['pipeline.wip.max_tasks_in_pipeline'])).toBe(false);
    expect(bound([])).toBe(false);
  });

  it('answers nothing for a task that is not queued at this read', () => {
    const moved = task('active');
    expect(queueWaitsOf([moved], [moved.id], DEFAULT_WIP_LIMITS).has(moved.id)).toBe(false);
  });
});
