/**
 * S-28.16 (BD-010's 2026-11-10 amendment decision 4, M28 ruling B2 (4)) — the recovery pass's
 * settle row: a pending budget approval an earlier build asked on fewer than three finished tasks is
 * approved by the platform (`auto_decided`, no decider, `estimate_basis_too_thin`), once; one on
 * three or more, a plan approval and a decided one are left alone. Canary: without the row the four
 * Autix tasks keep waiting for a click this build would never have asked for.
 */
import type { BudgetApprovalSubjectDetail, Id, IsoDateTime } from '@platform/contracts';
import {
  BUDGET_APPROVAL_NOT_REQUIRED_CODE,
  createApproval,
  decideApproval,
  sequentialIds,
} from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { StoredTask } from '../pipeline/store.js';
import { MemoryEventing } from '../testing/memory-eventing.js';
import { createMemoryPipelineStore } from '../testing/memory-pipeline.js';
import {
  BUDGET_APPROVAL_SETTLE_COMPONENT,
  recoverBudgetApprovalSettle,
} from './budget-approval-settle.js';

const PROJECT = '00000000-0000-4000-8000-0000000016a1' as Id;
const NOW = '2026-11-10T09:00:00.000Z' as IsoDateTime;
const USER = '00000000-0000-4000-8000-0000000016e1' as Id;

const task = (id: string, estimateSamples: number | null): StoredTask =>
  ({
    task: {
      id: id as Id,
      projectId: PROJECT,
      ticket: { provider: 'fake-jira', key: id.slice(-4), url: `https://jira.example.test/${id}` },
      template: 'feature',
      mode: 'normal',
      state: 'waiting_approval',
      currentStage: 'refinement',
      stageAttempts: { refinement: 1 },
      iterationCounters: {},
      limits: {},
      sequence: 3,
    },
    costActualUsd: 0.45,
    estimateUsd: 123.66,
    estimateBasis: 'project_history',
    estimateSamples,
    version: 1,
  }) as unknown as StoredTask;

const detail = (samples: number | null): BudgetApprovalSubjectDetail => ({
  estimate_usd: 123.66,
  threshold_usd: 50,
  estimate_basis: 'project_history',
  estimate_samples: samples,
});

const ids = sequentialIds();
const context = (correlationId: Id) => ({
  ids,
  actor: { kind: 'system' as const, component: BUDGET_APPROVAL_SETTLE_COMPONENT },
  clock: { now: () => NOW },
  correlationId,
  causeEventId: null,
});

const ONE = '00000000-0000-4000-8000-0000000016b1';
const TWO = '00000000-0000-4000-8000-0000000016b2';
const THREE = '00000000-0000-4000-8000-0000000016b3';
const PLAN = '00000000-0000-4000-8000-0000000016b4';
const DECIDED = '00000000-0000-4000-8000-0000000016b5';
const UNRECORDED = '00000000-0000-4000-8000-0000000016b6';

const setup = async () => {
  const memory = new MemoryEventing();
  const store = createMemoryPipelineStore();
  const approvalIds = new Map<string, Id>();
  await memory.transaction(async (scope) => {
    const rows: readonly [string, 'budget' | 'plan', number | null, number | null, boolean][] = [
      // [task, kind, the subject's samples, the task's samples, decided first]
      [ONE, 'budget', 1, 1, false],
      [TWO, 'budget', 2, 2, false],
      [THREE, 'budget', 3, 3, false],
      [PLAN, 'plan', null, 1, false],
      [DECIDED, 'budget', 1, 1, true],
      // A row asked before the subject was recorded: the task's own figure answers.
      [UNRECORDED, 'budget', null, 1, false],
    ];
    for (const [taskId, kind, subjectSamples, taskSamples, decidedFirst] of rows) {
      await store.tasks.insert(scope.tx, task(taskId, taskSamples));
      const approval = createApproval(
        { id: ids.next(), taskId: taskId as Id, projectId: PROJECT, kind },
        context(taskId as Id),
      );
      approvalIds.set(taskId, approval.id);
      await store.approvals.insert(scope.tx, {
        approval: decidedFirst
          ? decideApproval(
              approval,
              { decision: 'rejected', userId: USER, role: 'maintainer' },
              context(taskId as Id),
            ).aggregate
          : approval,
        stage: 'refinement' as never,
        attempt: 1,
        ...(kind === 'budget' && subjectSamples !== null
          ? { subjectDetail: detail(subjectSamples) }
          : {}),
      });
    }
  });
  const pass = () =>
    recoverBudgetApprovalSettle(
      { unitOfWork: memory },
      { approvals: store.approvals, tasks: store.tasks, context },
      { limit: 50 },
    );
  const load = (taskId: string) =>
    memory.transaction(async (scope) =>
      store.approvals.load(scope.tx, approvalIds.get(taskId) as Id),
    );
  const decidedEvents = async (taskId: string) =>
    (await memory.store.readStream('approval', approvalIds.get(taskId) as Id)).filter(
      (row) => row.event.type === 'task.approval.decided',
    );
  return { pass, load, decidedEvents, store, memory, approvalIds };
};

describe('budget approvals asked on too few finished tasks are settled (S-28.16)', () => {
  it('settles the ones below three, by the platform, with the code and the numbers', async () => {
    const world = await setup();
    expect(await world.pass()).toEqual({ found: 3, settled: 3 });

    for (const taskId of [ONE, TWO, UNRECORDED]) {
      const settled = await world.load(taskId);
      expect(settled?.approval.status, taskId).toBe('approved');
      expect(settled?.approval.decidedByUserId).toBeNull();
      expect(settled?.autoDecided).toBe(true);
      expect(settled?.approval.reason?.startsWith(`${BUDGET_APPROVAL_NOT_REQUIRED_CODE}:`)).toBe(
        true,
      );
      const events = await world.decidedEvents(taskId);
      expect(events).toHaveLength(1);
      expect(events[0]?.event.actor).toEqual({
        kind: 'system',
        component: BUDGET_APPROVAL_SETTLE_COMPONENT,
      });
      // Nobody approved a spend: the cap is not touched.
      expect(events[0]?.event.payload).not.toHaveProperty('cap_after_usd');
    }
    expect((await world.load(TWO))?.approval.reason).toContain('2 finished tasks');
  });

  it('leaves one on three tasks, a plan approval and a decided one alone', async () => {
    const world = await setup();
    await world.pass();
    expect((await world.load(THREE))?.approval.status).toBe('pending');
    expect((await world.load(PLAN))?.approval.status).toBe('pending');
    expect((await world.load(DECIDED))?.approval.status).toBe('rejected');
    expect(await world.decidedEvents(THREE)).toHaveLength(0);
    expect(await world.decidedEvents(PLAN)).toHaveLength(0);
  });

  it('does nothing on a second pass', async () => {
    const world = await setup();
    await world.pass();
    expect(await world.pass()).toEqual({ found: 0, settled: 0 });
    expect(await world.decidedEvents(ONE)).toHaveLength(1);
  });

  it('settles the rest when one approval cannot be settled now, and that one on the next pass', async () => {
    const world = await setup();
    const failing = world.approvalIds.get(ONE);
    let failOnce = true;
    const approvals = {
      ...world.store.approvals,
      load: async (tx: Parameters<typeof world.store.approvals.load>[0], id: Id) => {
        if (id === failing && failOnce) {
          failOnce = false;
          throw new Error('a person decided it in the same instant');
        }
        return world.store.approvals.load(tx, id);
      },
    };
    const pass = () =>
      recoverBudgetApprovalSettle(
        { unitOfWork: world.memory },
        { approvals, tasks: world.store.tasks, context },
        { limit: 50 },
      );
    expect(await pass()).toEqual({ found: 3, settled: 2 });
    expect((await world.load(ONE))?.approval.status).toBe('pending');
    expect((await world.load(TWO))?.approval.status).toBe('approved');
    expect(await pass()).toEqual({ found: 1, settled: 1 });
    expect((await world.load(ONE))?.approval.status).toBe('approved');
  });
});
