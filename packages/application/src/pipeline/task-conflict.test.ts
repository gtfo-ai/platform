/**
 * The ending for a refused write: the bound, and what happens when it is spent (WP-15e).
 *
 * Standing rule **42** — a boundary asserted from one side is half a test — so the bound is
 * asserted **at** it (the last permitted attempt succeeds) and **one past** it (every attempt
 * conflicts, and the task is escalated rather than dropped). Rule **10**: each case says which
 * branch ran, by counting the attempts rather than only by looking at the outcome.
 */
import type { Id } from '@platform/contracts';
import { FEATURE_TEMPLATE } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import { INITIAL_TASK_VERSION, TaskConcurrentModificationError } from './store.js';
import {
  escalateTaskAfterConflict,
  MAX_TASK_CONFLICT_ATTEMPTS,
  retryOnTaskConflict,
  TaskConflictExhaustedError,
} from './task-conflict.js';

const TASK = '00000000-0000-4000-8000-00000000e001' as Id;
const PROJECT = '00000000-0000-4000-8000-00000000e002' as Id;

const conflict = (version: number): TaskConcurrentModificationError =>
  new TaskConcurrentModificationError(TASK, version, version + 1);

describe('retryOnTaskConflict', () => {
  it('runs the unit once when nothing conflicts', async () => {
    let attempts = 0;
    const result = await retryOnTaskConflict({ taskId: TASK, what: 'a write' }, async () => {
      attempts += 1;
      return 'written';
    });
    expect(result).toBe('written');
    expect(attempts).toBe(1);
  });

  it('succeeds on the last attempt the bound allows', async () => {
    let attempts = 0;
    const result = await retryOnTaskConflict({ taskId: TASK, what: 'a write' }, async () => {
      attempts += 1;
      if (attempts < MAX_TASK_CONFLICT_ATTEMPTS) {
        throw conflict(attempts);
      }
      return 'written';
    });
    expect(result).toBe('written');
    expect(attempts).toBe(MAX_TASK_CONFLICT_ATTEMPTS);
  });

  it('gives up one attempt past the bound, with a typed failure that names the unit', async () => {
    let attempts = 0;
    const failure = await retryOnTaskConflict(
      { taskId: TASK, what: "a run's result" },
      async () => {
        attempts += 1;
        throw conflict(attempts);
      },
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(attempts).toBe(MAX_TASK_CONFLICT_ATTEMPTS);
    expect(failure).toBeInstanceOf(TaskConflictExhaustedError);
    expect(failure).toMatchObject({
      taskId: TASK,
      attempts: MAX_TASK_CONFLICT_ATTEMPTS,
      what: "a run's result",
    });
    // The refusal that caused it is kept, so a log line can say which version lost.
    expect((failure as TaskConflictExhaustedError).cause).toBeInstanceOf(
      TaskConcurrentModificationError,
    );
  });

  it('does not retry an error that is not a conflict', async () => {
    let attempts = 0;
    await expect(
      retryOnTaskConflict({ taskId: TASK, what: 'a write' }, async () => {
        attempts += 1;
        throw new Error('the task does not exist');
      }),
    ).rejects.toThrow('the task does not exist');
    expect(attempts).toBe(1);
  });

  /**
   * The property criterion 4 is actually about: the retry must read again.
   *
   * Asserted against the real in-memory store rather than against a counter, because the failure
   * mode being excluded is a caller that catches the refusal and re-applies the snapshot it was
   * already holding — which a counter cannot tell apart from a correct retry.
   */
  it('re-reads the aggregate on every attempt instead of re-applying the stale one', async () => {
    const store = createMemoryPipelineStore();
    const uow = new MemoryEventing();
    const seen: number[] = [];

    await uow.transaction(async (scope) => {
      await store.tasks.insert(scope.tx, {
        task: {
          id: TASK,
          projectId: PROJECT,
          ticket: { provider: 'fake-jira', key: 'ACME-9', url: 'https://jira.test/ACME-9' },
          template: 'feature',
          mode: 'normal',
          state: 'active',
          currentStage: 'refinement',
          stageAttempts: { refinement: 1 },
          iterationCounters: {},
          limits: {
            code_review: 3,
            business_review: 2,
            ci_fix: 3,
            human_rounds: 3,
            refinement_questions: 2,
            architecture_revisions: 2,
            rebase: 2,
          },
          sequence: 1,
        },
        template: FEATURE_TEMPLATE,
        priorityRank: 2,
        createdAt: '2026-06-01T09:00:00.000Z',
        branch: null,
        mr: null,
        workpad: null,
        costActualUsd: 0,
        estimateUsd: null,
        ticketSnapshot: null,
        ticketSnapshotAt: null,
        version: INITIAL_TASK_VERSION,
      });
    });

    // The stale snapshot a naive retry would re-apply, taken once and never refreshed.
    const stale = await uow.transaction(async (scope) => store.tasks.load(scope.tx, TASK));

    let attempt = 0;
    await retryOnTaskConflict({ taskId: TASK, what: 'adding a stage cost' }, async () =>
      uow.transaction(async (scope) => {
        attempt += 1;
        const current = await store.tasks.load(scope.tx, TASK);
        seen.push(current?.version ?? -1);
        if (attempt === 1) {
          // Another writer lands between this read and this write.
          await uow.transaction(async (other) => {
            const fresh = await store.tasks.load(other.tx, TASK);
            await store.tasks.save(other.tx, {
              ...(fresh as NonNullable<typeof fresh>),
              costActualUsd: 2.4,
            });
          });
        }
        await store.tasks.save(scope.tx, {
          ...(current as NonNullable<typeof current>),
          costActualUsd: (current?.costActualUsd ?? 0) + 0.4,
        });
      }),
    );

    expect(attempt).toBe(2);
    // Two different versions were read, which is what "re-reads" means.
    expect(seen).toEqual([INITIAL_TASK_VERSION, INITIAL_TASK_VERSION + 1]);
    const after = await uow.transaction(async (scope) => store.tasks.load(scope.tx, TASK));
    // 2.40 from the winner plus this writer's own 0.40 — not the 0.40 the stale snapshot implies.
    expect(after?.costActualUsd).toBeCloseTo(2.8, 6);
    expect(stale?.costActualUsd).toBe(0);
  });
});

describe('escalateTaskAfterConflict', () => {
  const givenTask = async (
    store: ReturnType<typeof createMemoryPipelineStore>,
    uow: MemoryEventing,
    state: 'active' | 'done',
  ): Promise<void> => {
    await uow.transaction(async (scope) => {
      await store.tasks.insert(scope.tx, {
        task: {
          id: TASK,
          projectId: PROJECT,
          ticket: { provider: 'fake-jira', key: 'ACME-9', url: 'https://jira.test/ACME-9' },
          template: 'feature',
          mode: 'normal',
          state,
          currentStage: state === 'done' ? null : 'refinement',
          stageAttempts: { refinement: 1 },
          iterationCounters: {},
          limits: {
            code_review: 3,
            business_review: 2,
            ci_fix: 3,
            human_rounds: 3,
            refinement_questions: 2,
            architecture_revisions: 2,
            rebase: 2,
          },
          sequence: 1,
        },
        template: FEATURE_TEMPLATE,
        priorityRank: 2,
        createdAt: '2026-06-01T09:00:00.000Z',
        branch: null,
        mr: null,
        workpad: null,
        costActualUsd: 0,
        estimateUsd: null,
        ticketSnapshot: null,
        ticketSnapshotAt: null,
        version: INITIAL_TASK_VERSION,
      });
    });
  };

  const options = (store: ReturnType<typeof createMemoryPipelineStore>, uow: MemoryEventing) => ({
    unitOfWork: uow,
    store,
    context: (taskId: Id) => ({
      ids: { next: () => '00000000-0000-4000-8000-00000000e00f' as Id },
      actor: { kind: 'system' as const, component: 'pipeline' },
      clock: { now: () => '2026-06-01T10:00:00.000Z' as never },
      correlationId: taskId,
      causeEventId: null,
    }),
  });

  it('parks the task for a human, with a brief that says what was not written', async () => {
    const store = createMemoryPipelineStore();
    const uow = new MemoryEventing();
    await givenTask(store, uow, 'active');

    await escalateTaskAfterConflict(
      options(store, uow),
      new TaskConflictExhaustedError(TASK, MAX_TASK_CONFLICT_ATTEMPTS, "recording a run's result"),
    );

    const after = await uow.transaction(async (scope) => store.tasks.load(scope.tx, TASK));
    expect(after?.task.state).toBe('needs_human');
    const stream = await uow.store.readStream('task', TASK);
    const escalations = stream.filter((stored) => stored.event.type === 'task.escalated');
    expect(escalations).toHaveLength(1);
    expect(JSON.stringify(escalations[0]?.event.payload)).toContain("recording a run's result");
  });

  it('consumes the escalation for a task that has already finished, rather than throwing', async () => {
    const store = createMemoryPipelineStore();
    const uow = new MemoryEventing();
    await givenTask(store, uow, 'done');

    await expect(
      escalateTaskAfterConflict(
        options(store, uow),
        new TaskConflictExhaustedError(TASK, MAX_TASK_CONFLICT_ATTEMPTS, 'settling a gate'),
      ),
    ).resolves.toBeUndefined();

    const after = await uow.transaction(async (scope) => store.tasks.load(scope.tx, TASK));
    expect(after?.task.state).toBe('done');
    const stream = await uow.store.readStream('task', TASK);
    expect(stream.filter((stored) => stored.event.type === 'task.escalated')).toHaveLength(0);
  });
});
