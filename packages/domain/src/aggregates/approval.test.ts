import {
  approvalKindSchema,
  approvalStatusSchema,
  taskStateSchema,
  type UserRole,
  userRoleSchema,
} from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../clock.js';
import { ApprovalPendingError, IllegalTransitionError, PermissionDeniedError } from '../errors.js';
import { type CommandContext, FIRST_STREAM_SEQ } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import { can } from '../permissions.js';
import * as approvalModule from './approval.js';
import {
  APPROVAL_REMINDER_LIMIT,
  APPROVAL_TRANSITIONS,
  type Approval,
  assertNoPendingApproval,
  canTransitionApproval,
  createApproval,
  decideApproval,
  recordApprovalReminder,
  toApprovalRecord,
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

  it('refuses a retry of a task paused out of the wait, naming the approval (BACKLOG 1480)', () => {
    let refused: unknown;
    try {
      assertNoPendingApproval({ state: 'paused' }, pending(), {
        stage: 'architecture',
        move: 'retry-stage',
      });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ApprovalPendingError);
    expect((refused as ApprovalPendingError).from).toBe('paused');
    expect((refused as Error).message).toContain(APPROVAL_ID);
  });

  it('asks nothing of a task in any other state', () => {
    for (const state of taskStateSchema.options.filter(
      (state) => state !== 'waiting_approval' && state !== 'paused',
    )) {
      expect(() => assertNoPendingApproval({ state }, pending(), entry), state).not.toThrow();
    }
  });
});
