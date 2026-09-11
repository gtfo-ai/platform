import { approvalKindSchema, approvalStatusSchema, type UserRole } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { type Clock, fixedClock } from '../clock.js';
import { IllegalTransitionError, PermissionDeniedError } from '../errors.js';
import { type CommandContext, FIRST_STREAM_SEQ } from '../events.js';
import { type IdSource, sequentialIds } from '../ids.js';
import {
  APPROVAL_TRANSITIONS,
  type Approval,
  canTransitionApproval,
  createApproval,
  decideApproval,
  expireApproval,
  isApprovalOverdue,
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
      deadlineAt: '2026-09-10T09:00:00.000Z',
    },
    context(shared),
  );

describe('Approval transition table', () => {
  it('covers exactly the statuses the contracts define, all terminal but `pending`', () => {
    expect(Object.keys(APPROVAL_TRANSITIONS).sort()).toEqual(
      [...approvalStatusSchema.options].sort(),
    );
    expect(canTransitionApproval('approved', 'rejected')).toBe(false);
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
      deadline_at: '2026-09-10T09:00:00.000Z',
      decided_by_user_id: null,
      decided_at: null,
      reason: null,
    });
  });

  it('leaves the deadline open when there is none', () => {
    const approval = createApproval(
      { id: APPROVAL_ID, taskId: TASK_ID, projectId: PROJECT_ID, kind: 'budget' },
      context(world()),
    );
    expect(approval.deadlineAt).toBeNull();
    expect(isApprovalOverdue(approval, '2030-01-01T00:00:00.000Z')).toBe(false);
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

describe('expiry', () => {
  it('knows when the deadline has passed', () => {
    const approval = pending();
    expect(isApprovalOverdue(approval, '2026-09-09T10:00:00.000Z')).toBe(false);
    expect(isApprovalOverdue(approval, '2026-09-11T00:00:00.000Z')).toBe(true);
  });

  it('records an expiry with no decider', () => {
    const shared = world();
    const { aggregate, events } = expireApproval(pending(shared), context(shared));
    expect(aggregate.status).toBe('expired');
    expect(aggregate.decidedByUserId).toBeNull();
    expect(events[0]?.payload).toMatchObject({ decision: 'expired', decided_by_user_id: null });
  });

  it('cannot expire an approval that was decided', () => {
    const shared = world();
    const decided = decideApproval(
      pending(shared),
      { decision: 'approved', userId: USER_ID, role: 'maintainer' },
      context(shared),
    ).aggregate;
    expect(() => expireApproval(decided, context(shared))).toThrow(IllegalTransitionError);
    expect(isApprovalOverdue(decided, '2030-01-01T00:00:00.000Z')).toBe(false);
  });
});
