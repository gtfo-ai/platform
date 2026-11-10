import {
  approvalKindSchema,
  approvalStatusSchema,
  taskStateSchema,
  type UserRole,
  userRoleSchema,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../clock.js';
import {
  ApprovalPendingError,
  IllegalTransitionError,
  InvariantViolationError,
  PermissionDeniedError,
} from '../errors.js';
import { type CommandContext, FIRST_STREAM_SEQ } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import { can } from '../permissions.js';
import * as approvalModule from './approval.js';
import {
  APPROVAL_REMINDER_LIMIT,
  APPROVAL_TRANSITIONS,
  APPROVAL_WITHDRAWN_REASON,
  type Approval,
  assertNoPendingApproval,
  autoApproveApproval,
  BUDGET_APPROVAL_NOT_REQUIRED_CODE,
  canTransitionApproval,
  createApproval,
  decideApproval,
  recordApprovalReminder,
  settleBudgetApprovalNotRequired,
  toApprovalRecord,
  withdrawApproval,
} from './approval.js';

const APPROVAL_ID = '00000000-0000-4000-8000-0000000000d1';
const TASK_ID = '00000000-0000-4000-8000-0000000000aa';
const PROJECT_ID = '00000000-0000-4000-8000-0000000000bb';
const USER_ID = '00000000-0000-4000-8000-0000000000e9';

const world = (): { ids: IdSource; clock: Clock } => ({
  ids: sequentialIds(),
  clock: fixedClock('2026-09-09T09:00:00.000Z', 1_000),
});

const context = (shared: { ids: IdSource; clock: Clock }): CommandContext => ({
  ids: shared.ids,
  actor: { kind: 'user', user_id: USER_ID },
  clock: shared.clock,
});

const pending = (shared = world(), kind: Approval['kind'] = 'plan'): Approval =>
  createApproval(
    {
      id: APPROVAL_ID,
      taskId: TASK_ID,
      projectId: PROJECT_ID,
      kind,
    },
    context(shared),
  );

describe('Approval transition table', () => {
  it('covers exactly the statuses the contracts define, all terminal but `pending`', () => {
    expect(Object.keys(APPROVAL_TRANSITIONS).sort()).toEqual(
      [...approvalStatusSchema.options].sort(),
    );
    expect(canTransitionApproval('approved', 'rejected')).toBe(false);
    // Kept for history and replay (BD-006's 2026-11-07 amendment, item 4): rows and events an
    // earlier build wrote say `expired`; nothing on this build produces it.
    expect(canTransitionApproval('pending', 'expired')).toBe(true);
  });
});

describe('createApproval', () => {
  it('records the request without emitting: the task owns `task.approval.requested`', () => {
    const approval = pending();
    expect(approval.status).toBe('pending');
    expect(approval.requestedAt).toBe('2026-09-09T09:00:00.000Z');
    expect(approval.sequence).toBe(FIRST_STREAM_SEQ);
    expect(toApprovalRecord(approval)).toEqual({
      id: APPROVAL_ID,
      task_id: TASK_ID,
      kind: 'plan',
      status: 'pending',
      requested_at: '2026-09-09T09:00:00.000Z',
      // BD-006's 2026-11-07 amendment: an approval waits until a person decides it.
      deadline_at: null,
      decided_by_user_id: null,
      decided_at: null,
      reason: null,
    });
  });
});

describe('deciding', () => {
  it('records who decided and why', () => {
    const shared = world();
    const { aggregate, events } = decideApproval(
      pending(shared),
      { decision: 'approved', userId: USER_ID, role: 'maintainer', reason: 'plan looks right' },
      context(shared),
    );
    expect(aggregate.status).toBe('approved');
    expect(aggregate.decidedByUserId).toBe(USER_ID);
    expect(aggregate.reason).toBe('plan looks right');
    expect(events.map((event) => event.type)).toEqual(['task.approval.decided']);
    expect(events[0]?.stream_type).toBe('approval');
    expect(events[0]?.payload).toMatchObject({ decision: 'approved' });
  });

  it('rejects with no reason given', () => {
    const shared = world();
    const { aggregate } = decideApproval(
      pending(shared),
      { decision: 'rejected', userId: USER_ID, role: 'admin' },
      context(shared),
    );
    expect(aggregate.status).toBe('rejected');
    expect(aggregate.reason).toBeNull();
  });

  it('only lets a maintainer decide, whatever the kind (BD-006, Q10)', () => {
    for (const kind of approvalKindSchema.options) {
      for (const role of ['viewer', 'member'] satisfies UserRole[]) {
        const shared = world();
        expect(() =>
          decideApproval(
            pending(shared, kind),
            { decision: 'approved', userId: USER_ID, role },
            context(shared),
          ),
        ).toThrow(PermissionDeniedError);
      }
      const shared = world();
      expect(() =>
        decideApproval(
          pending(shared, kind),
          { decision: 'approved', userId: USER_ID, role: 'maintainer' },
          context(shared),
        ),
      ).not.toThrow();
    }
  });

  it('cannot be decided twice', () => {
    const shared = world();
    const decided = decideApproval(
      pending(shared),
      { decision: 'approved', userId: USER_ID, role: 'maintainer' },
      context(shared),
    ).aggregate;
    expect(() =>
      decideApproval(
        decided,
        { decision: 'rejected', userId: USER_ID, role: 'admin' },
        context(shared),
      ),
    ).toThrow(IllegalTransitionError);
  });
});

describe('an approval waits until a person decides it (BD-006, 2026-11-07, S-27.1)', () => {
  it('is created with no deadline, whatever the kind', () => {
    for (const kind of approvalKindSchema.options) {
      expect(pending(world(), kind).deadlineAt, kind).toBeNull();
    }
  });

  it('has no expiry left to call: the command and its overdue predicate are deleted (item 4)', () => {
    expect(approvalModule).not.toHaveProperty('expireApproval');
    expect(approvalModule).not.toHaveProperty('isApprovalOverdue');
  });

  it('counts at most five reminders, and only while it is pending (item 2)', () => {
    let approval = pending();
    for (let sent = 0; sent < APPROVAL_REMINDER_LIMIT; sent += 1) {
      approval = recordApprovalReminder(approval);
    }
    expect(APPROVAL_REMINDER_LIMIT).toBe(5);
    expect(approval.remindersSent).toBe(5);
    expect(() => recordApprovalReminder(approval)).toThrow(/at most 5 times/);
    const shared = world();
    const decided = decideApproval(
      pending(shared),
      { decision: 'approved', userId: USER_ID, role: 'maintainer' },
      context(shared),
    ).aggregate;
    expect(() => recordApprovalReminder(decided)).toThrow(/only a pending approval/);
  });
});

describe('a human entry never moves a task past a pending approval (BACKLOG 854)', () => {
  const entry = { stage: 'architecture', move: 'resume' } as const;

  it('refuses a resume of a waiting_approval task with a pending approval, naming it, for every role', () => {
    const approval = pending();
    for (const role of userRoleSchema.options) {
      // The role check is not what refuses it: a member may resume (and `waiting_approval` is a
      // resumable state), so the refusal has to come from the approval, the same for every role.
      if (role !== 'viewer') {
        expect(can(role, 'task.resume', { kind: 'task', state: 'waiting_approval' }), role).toBe(
          true,
        );
      }
      let refused: unknown;
      try {
        assertNoPendingApproval({ state: 'waiting_approval' }, approval, entry);
      } catch (error) {
        refused = error;
      }
      expect(refused, role).toBeInstanceOf(ApprovalPendingError);
      expect(refused, role).toBeInstanceOf(IllegalTransitionError);
      expect((refused as ApprovalPendingError).approvalId).toBe(APPROVAL_ID);
      expect((refused as Error).message).toContain(APPROVAL_ID);
      expect((refused as Error).message).toContain('plan approval');
    }
  });

  it('refuses a return-to-stage or a rework the same way, for every role (BACKLOG 1481)', () => {
    for (const move of ['return-to-stage', 'rework']) {
      for (const state of ['waiting_approval', 'needs_human', 'paused'] as const) {
        let refused: unknown;
        try {
          assertNoPendingApproval({ state }, pending(), { stage: 'architecture', move });
        } catch (error) {
          refused = error;
        }
        expect(refused, `${move} from ${state}`).toBeInstanceOf(ApprovalPendingError);
        expect((refused as Error).message).toContain(`a ${move} cannot move it`);
        expect((refused as Error).message).toContain(APPROVAL_ID);
      }
    }
  });

  it('lets the task move once the approval is decided, or when there is none (the rescue)', () => {
    const shared = world();
    const decided = decideApproval(
      pending(shared),
      { decision: 'approved', userId: USER_ID, role: 'maintainer' },
      context(shared),
    ).aggregate;
    expect(() =>
      assertNoPendingApproval({ state: 'waiting_approval' }, decided, entry),
    ).not.toThrow();
    expect(() => assertNoPendingApproval({ state: 'waiting_approval' }, null, entry)).not.toThrow();
  });

  it('refuses an entry in any state while the approval is pending — a hand-back included (BACKLOG 1480)', () => {
    for (const state of taskStateSchema.options) {
      let refused: unknown;
      try {
        assertNoPendingApproval({ state }, pending(), {
          stage: 'implementation',
          move: 'hand-back',
        });
      } catch (error) {
        refused = error;
      }
      expect(refused, state).toBeInstanceOf(ApprovalPendingError);
      expect((refused as ApprovalPendingError).from).toBe(state);
      expect((refused as Error).message).toContain(APPROVAL_ID);
    }
  });
});

describe('a low-risk plan goes ahead without a person (S-28.8, M28 ruling 5)', () => {
  it('approves the plan with no decider, on the approval stream, with the ordinary event', () => {
    const shared = world();
    const { aggregate, events } = autoApproveApproval(pending(shared), context(shared));
    expect(aggregate.status).toBe('approved');
    expect(aggregate.decidedByUserId).toBeNull();
    expect(aggregate.decidedAt).not.toBeNull();
    expect(aggregate.reason).toBeNull();
    expect(events.map((event) => [event.type, event.stream_type])).toEqual([
      ['task.approval.decided', 'approval'],
    ]);
    // No new payload key: an older build reading the event during a rollback accepts it.
    expect(Object.keys(events[0]?.payload ?? {}).sort()).toEqual(
      ['approval_id', 'decided_by_user_id', 'decision', 'project_id', 'reason', 'task_id'].sort(),
    );
    expect(events[0]?.payload).toMatchObject({ decision: 'approved', decided_by_user_id: null });
  });

  it('refuses any kind but a plan, and an approval already decided', () => {
    const shared = world();
    expect(() => autoApproveApproval(pending(shared, 'budget'), context(shared))).toThrow(
      /only a plan approval/,
    );
    const decided = decideApproval(
      pending(shared),
      { decision: 'rejected', userId: USER_ID, role: 'maintainer' },
      context(shared),
    ).aggregate;
    expect(() => autoApproveApproval(decided, context(shared))).toThrow(IllegalTransitionError);
  });
});

describe('a cancelled task withdraws its pending approval (S-27.1, review of #113)', () => {
  it('ends it expired, with no decider and the reason, on the approval stream', () => {
    const shared = world();
    const { aggregate, events } = withdrawApproval(pending(shared), context(shared));
    expect(aggregate.status).toBe('expired');
    expect(aggregate.decidedByUserId).toBeNull();
    expect(aggregate.reason).toBe(APPROVAL_WITHDRAWN_REASON);
    expect(events.map((event) => [event.type, event.stream_type])).toEqual([
      ['task.approval.decided', 'approval'],
    ]);
    expect(events[0]?.payload).toMatchObject({
      decision: 'expired',
      decided_by_user_id: null,
      reason: 'the task was cancelled',
    });
  });

  it('cannot withdraw an approval that was decided', () => {
    const shared = world();
    const decided = decideApproval(
      pending(shared),
      { decision: 'approved', userId: USER_ID, role: 'maintainer' },
      context(shared),
    ).aggregate;
    expect(() => withdrawApproval(decided, context(shared))).toThrow(IllegalTransitionError);
  });
});

/**
 * S-28.16 (BD-010's 2026-11-10 amendment, M28 ruling B2): an approved budget above the task's cap
 * carries the cap it raised on its decision, and a budget approval asked on too few finished tasks
 * is settled by the platform as no longer required.
 */
describe('the budget approval’s cap and its settle (S-28.16)', () => {
  const maintainer = {
    decision: 'approved' as const,
    userId: USER_ID,
    role: 'maintainer' as const,
  };

  it('carries the cap before and after on an approved budget’s decision', () => {
    const shared = world();
    const decided = decideApproval(
      pending(shared, 'budget'),
      { ...maintainer, capChange: { beforeUsd: 50, afterUsd: 123.66 } },
      context(shared),
    );
    expect(decided.events[0]?.payload).toMatchObject({
      decision: 'approved',
      cap_before_usd: 50,
      cap_after_usd: 123.66,
    });
  });

  it('carries no cap fields on a decision that raised nothing', () => {
    const shared = world();
    const decided = decideApproval(pending(shared, 'budget'), maintainer, context(shared));
    expect(decided.events[0]?.payload).not.toHaveProperty('cap_before_usd');
    expect(decided.events[0]?.payload).not.toHaveProperty('cap_after_usd');
  });

  it('refuses a cap change on a plan, on a reject, and downwards', () => {
    const shared = world();
    const change = { beforeUsd: 50, afterUsd: 123.66 };
    expect(() =>
      decideApproval(
        pending(shared, 'plan'),
        { ...maintainer, capChange: change },
        context(shared),
      ),
    ).toThrow(InvariantViolationError);
    expect(() =>
      decideApproval(
        pending(shared, 'budget'),
        { ...maintainer, decision: 'rejected', capChange: change },
        context(shared),
      ),
    ).toThrow(InvariantViolationError);
    expect(() =>
      decideApproval(
        pending(shared, 'budget'),
        { ...maintainer, capChange: { beforeUsd: 80, afterUsd: 60 } },
        context(shared),
      ),
    ).toThrow(InvariantViolationError);
  });

  it('settles a budget approval below the floor: approved, nobody decided, the code and the numbers', () => {
    const shared = world();
    const settled = settleBudgetApprovalNotRequired(
      pending(shared, 'budget'),
      { samples: 1, min: 3 },
      context(shared),
    );
    expect(settled.aggregate.status).toBe('approved');
    expect(settled.aggregate.decidedByUserId).toBeNull();
    expect(settled.aggregate.reason?.startsWith(`${BUDGET_APPROVAL_NOT_REQUIRED_CODE}:`)).toBe(
      true,
    );
    expect(settled.aggregate.reason).toContain('1 finished task');
    expect(settled.events[0]?.payload).toMatchObject({
      decision: 'approved',
      decided_by_user_id: null,
      reason: settled.aggregate.reason,
    });
    expect(settled.events[0]?.payload).not.toHaveProperty('cap_after_usd');
  });

  it('settles only a pending budget approval resting on too few tasks', () => {
    const shared = world();
    expect(() =>
      settleBudgetApprovalNotRequired(
        pending(shared, 'plan'),
        { samples: 1, min: 3 },
        context(shared),
      ),
    ).toThrow(InvariantViolationError);
    expect(() =>
      settleBudgetApprovalNotRequired(
        pending(shared, 'budget'),
        { samples: 3, min: 3 },
        context(shared),
      ),
    ).toThrow(InvariantViolationError);
    const decided = decideApproval(
      pending(shared, 'budget'),
      maintainer,
      context(shared),
    ).aggregate;
    expect(() =>
      settleBudgetApprovalNotRequired(decided, { samples: 1, min: 3 }, context(shared)),
    ).toThrow(IllegalTransitionError);
  });
});
