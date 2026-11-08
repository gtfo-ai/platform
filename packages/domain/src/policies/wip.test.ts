import { type TaskState, taskStateSchema } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  compareQueuedTasks,
  countsAsActive,
  countsInPipeline,
  DEFAULT_WIP_LIMITS,
  evaluateRunAdmission,
  evaluateTaskAdmission,
  holdsPlace,
  orderQueue,
  type QueuedTask,
  queueAdmissionOf,
  wipCountsOf,
} from './wip.js';

describe('BD-010 defaults', () => {
  it('reproduces the decision verbatim', () => {
    expect(DEFAULT_WIP_LIMITS).toEqual({
      maxParallelTasks: 2,
      maxTasksInPipeline: 5,
      maxParallelRuns: 4,
    });
  });
});

describe('which states occupy a slot', () => {
  it('counts the states that are moving as active', () => {
    expect(taskStateSchema.options.filter(countsAsActive)).toEqual(['active', 'returned']);
  });

  it('counts waiting tasks as in the pipeline, and nothing before or after it', () => {
    expect(taskStateSchema.options.filter((state) => !countsInPipeline(state))).toEqual([
      'queued',
      'done',
      'cancelled',
    ]);
    expect(countsInPipeline('waiting_answers')).toBe(true);
    expect(countsInPipeline('paused')).toBe(true);
  });

  it('never counts a task as active without counting it in the pipeline', () => {
    for (const state of taskStateSchema.options) {
      if (countsAsActive(state)) {
        expect(countsInPipeline(state)).toBe(true);
      }
    }
  });
});

describe('evaluateTaskAdmission', () => {
  it('admits below both limits', () => {
    expect(evaluateTaskAdmission({ activeTasks: 1, tasksInPipeline: 4 })).toEqual({
      admitted: true,
    });
  });

  it('reports which limit refused', () => {
    expect(evaluateTaskAdmission({ activeTasks: 2, tasksInPipeline: 2 })).toEqual({
      admitted: false,
      reason: 'max_parallel_tasks',
      limit: 2,
    });
    expect(evaluateTaskAdmission({ activeTasks: 0, tasksInPipeline: 5 })).toEqual({
      admitted: false,
      reason: 'max_tasks_in_pipeline',
      limit: 5,
    });
  });

  it('honours project limits', () => {
    const limits = { maxParallelTasks: 4, maxTasksInPipeline: 10, maxParallelRuns: 8 };
    expect(evaluateTaskAdmission({ activeTasks: 3, tasksInPipeline: 9 }, limits).admitted).toBe(
      true,
    );
  });

  it(
    'never admits past a limit, for any counts',
    () => {
      fc.assert(
        fc.property(fc.nat({ max: 20 }), fc.nat({ max: 20 }), (activeTasks, tasksInPipeline) => {
          const decision = evaluateTaskAdmission({ activeTasks, tasksInPipeline });
          if (decision.admitted) {
            expect(activeTasks).toBeLessThan(DEFAULT_WIP_LIMITS.maxParallelTasks);
            expect(tasksInPipeline).toBeLessThan(DEFAULT_WIP_LIMITS.maxTasksInPipeline);
          }
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('evaluateRunAdmission', () => {
  it('protects the organisation against rate limits', () => {
    expect(evaluateRunAdmission({ activeRuns: 3 })).toEqual({ admitted: true });
    expect(evaluateRunAdmission({ activeRuns: 4 })).toEqual({
      admitted: false,
      reason: 'max_parallel_runs',
      limit: 4,
    });
  });
});

describe('queue order (priority, then age)', () => {
  const task = (id: string, priorityRank: number, createdAt: string): QueuedTask => ({
    id,
    priorityRank,
    createdAt,
  });

  it('puts the more urgent ticket first', () => {
    const high = task('00000000-0000-4000-8000-00000000000b', 1, '2026-09-09T10:00:00.000Z');
    const low = task('00000000-0000-4000-8000-00000000000a', 3, '2026-09-01T10:00:00.000Z');
    expect(orderQueue([low, high])).toEqual([high, low]);
  });

  it('breaks a priority tie by age, then by id', () => {
    const older = task('00000000-0000-4000-8000-00000000000b', 2, '2026-09-01T10:00:00.000Z');
    const newer = task('00000000-0000-4000-8000-00000000000a', 2, '2026-09-09T10:00:00.000Z');
    expect(orderQueue([newer, older])).toEqual([older, newer]);

    const twin = task('00000000-0000-4000-8000-00000000000c', 2, older.createdAt);
    expect(orderQueue([twin, older])).toEqual([older, twin]);
  });

  it(
    'is a total order, so the queue is stable',
    () => {
      const arbitrary = fc.record({
        id: fc.integer({ min: 0, max: 999 }).map((n) => n.toString().padStart(3, '0')),
        priorityRank: fc.integer({ min: 1, max: 3 }),
        createdAt: fc.integer({ min: 0, max: 5 }).map((day) => `2026-09-0${day + 1}T00:00:00.000Z`),
      });
      fc.assert(
        fc.property(fc.uniqueArray(arbitrary, { selector: (t) => t.id }), (tasks) => {
          const ordered = orderQueue(tasks);
          expect(ordered).toHaveLength(tasks.length);
          for (let index = 1; index < ordered.length; index += 1) {
            const previous = ordered[index - 1] as QueuedTask;
            const current = ordered[index] as QueuedTask;
            expect(compareQueuedTasks(previous, current)).toBeLessThan(0);
          }
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});

describe('why a queued task waits (S-25.16)', () => {
  /** The scheduler's own count: the memory store's two filters over the project's task states. */
  const schedulerCounts = (states: readonly TaskState[]) => ({
    activeTasks: states.filter(countsAsActive).length,
    tasksInPipeline: states.filter(countsInPipeline).length,
  });
  const states = fc.array(fc.constantFrom(...taskStateSchema.options), { maxLength: 30 });
  const limits = fc.record({
    maxParallelTasks: fc.integer({ min: 1, max: 8 }),
    maxTasksInPipeline: fc.integer({ min: 1, max: 12 }),
    maxParallelRuns: fc.integer({ min: 1, max: 8 }),
  });

  it(
    'gives the verdict the scheduler gives, over any multiset of task states and any limits',
    () => {
      fc.assert(
        fc.property(states, limits, (taskStates, wip) => {
          const verdict = queueAdmissionOf(wipCountsOf(taskStates), wip);
          const scheduler = evaluateTaskAdmission(schedulerCounts(taskStates), wip);
          expect(verdict.status === 'admitted').toBe(scheduler.admitted);
          if (verdict.status === 'waiting' && !scheduler.admitted) {
            expect(verdict.reason).toBe(scheduler.reason);
            expect(verdict.limit).toBe(scheduler.limit);
            // The count it names is the places held under that limit, and it reached the limit.
            expect(verdict.count).toBe(
              taskStates.filter((state) => holdsPlace(verdict.reason, state)).length,
            );
            expect(verdict.count).toBeGreaterThanOrEqual(verdict.limit);
          }
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it('names the pipeline limit when stopped tasks fill it — the Autix shape', () => {
    const autix: TaskState[] = [
      ...Array.from({ length: 5 }, () => 'needs_human' as const),
      ...Array.from({ length: 5 }, () => 'queued' as const),
    ];
    expect(queueAdmissionOf(wipCountsOf(autix))).toEqual({
      status: 'waiting',
      reason: 'max_tasks_in_pipeline',
      count: 5,
      limit: 5,
    });
  });

  it('names the parallel limit before the pipeline limit, as the scheduler checks them', () => {
    expect(queueAdmissionOf(wipCountsOf(['active', 'returned', 'needs_human']))).toEqual({
      status: 'waiting',
      reason: 'max_parallel_tasks',
      count: 2,
      limit: 2,
    });
  });

  it('answers admitted, from both sides of each limit', () => {
    expect(queueAdmissionOf(wipCountsOf(['active', 'needs_human', 'queued', 'done']))).toEqual({
      status: 'admitted',
    });
    expect(queueAdmissionOf(wipCountsOf(['active', 'active'])).status).toBe('waiting');
    expect(queueAdmissionOf(wipCountsOf(Array(4).fill('needs_human'))).status).toBe('admitted');
    expect(queueAdmissionOf(wipCountsOf(Array(5).fill('needs_human'))).status).toBe('waiting');
  });

  it('counts a stopped task as holding a pipeline place and no parallel one', () => {
    expect(holdsPlace('max_tasks_in_pipeline', 'needs_human')).toBe(true);
    expect(holdsPlace('max_parallel_tasks', 'needs_human')).toBe(false);
    expect(holdsPlace('max_parallel_tasks', 'returned')).toBe(true);
    expect(holdsPlace('max_tasks_in_pipeline', 'queued')).toBe(false);
  });
});
