import type { UserRole } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { PermissionDeniedError } from './errors.js';
import {
  APPROVAL_ACTIONS,
  assertCan,
  can,
  isActionableIdentity,
  PERMISSION_ACTIONS,
  PERMISSION_REQUIREMENTS,
  type PermissionAction,
  ROLE_LEVELS,
  USER_ROLES,
} from './permissions.js';

/**
 * The exhaustive role×action table (TD-022: "a pure `can(actor, action, resource)` with an
 * exhaustive test").
 *
 * It is written out by hand rather than derived from `PERMISSION_REQUIREMENTS`, so it is an
 * independent statement of the policy: if the requirement map changes, this table disagrees.
 * The `Record<PermissionAction, …>` type means a new action does not compile until someone
 * decides who may perform it.
 */
const ALL = ['viewer', 'member', 'maintainer', 'admin'] as const;
const MEMBER_UP = ['member', 'maintainer', 'admin'] as const;
const MAINTAINER_UP = ['maintainer', 'admin'] as const;
const ADMIN_ONLY = ['admin'] as const;

const EXPECTED_ROLES: Record<PermissionAction, readonly UserRole[]> = {
  'org.read': ALL,
  'org.settings.write': ADMIN_ONLY,
  'org.users.manage': ADMIN_ONLY,
  'org.audit.read': MAINTAINER_UP,

  'integration.read': MAINTAINER_UP,
  'integration.write': ADMIN_ONLY,

  'project.read': ALL,
  'project.create': ADMIN_ONLY,
  'project.settings.write': ADMIN_ONLY,
  'project.pipeline.write': MAINTAINER_UP,
  'project.autonomy.write': MAINTAINER_UP,
  'project.members.manage': ADMIN_ONLY,
  'project.config.export': MAINTAINER_UP,

  'budget.read': ALL,
  'budget.write': MAINTAINER_UP,

  'task.read': ALL,
  'task.create': MEMBER_UP,
  'task.pause': MEMBER_UP,
  'task.resume': MEMBER_UP,
  'task.cancel': MAINTAINER_UP,
  'task.retry_stage': MEMBER_UP,
  'task.return_to_stage': MAINTAINER_UP,
  'task.rework': MAINTAINER_UP,
  'task.take_over': MEMBER_UP,
  'task.hand_back': MEMBER_UP,
  'task.answer_question': MEMBER_UP,
  'task.approve_plan': MAINTAINER_UP,
  'task.approve_budget': MAINTAINER_UP,
  'task.feedback.create': MEMBER_UP,
  'task.ask': MEMBER_UP,
  'task.export': MEMBER_UP,

  'artifact.read': ALL,
  'transcript.read': MEMBER_UP,

  'run.read': ALL,
  'run.steer': MEMBER_UP,
  'run.cancel': MEMBER_UP,
  'run.retry': MEMBER_UP,

  'kb.read': ALL,
  'kb.write': MAINTAINER_UP,
  'kb.proposal.decide': MAINTAINER_UP,
  'kb.bootstrap': MAINTAINER_UP,

  'shadow.run': MAINTAINER_UP,
  'discovery.run': MAINTAINER_UP,
};

describe('can — exhaustive role × action', () => {
  it('covers every role the contracts define', () => {
    // A new role in `userRoleSchema` must be given a level and a column in the table below.
    expect([...USER_ROLES]).toEqual(['viewer', 'member', 'maintainer', 'admin']);
    expect(Object.keys(ROLE_LEVELS).sort()).toEqual([...USER_ROLES].sort());
  });

  it('lists every action exactly once', () => {
    expect(new Set(PERMISSION_ACTIONS).size).toBe(PERMISSION_ACTIONS.length);
    expect(Object.keys(PERMISSION_REQUIREMENTS).sort()).toEqual([...PERMISSION_ACTIONS].sort());
    expect(Object.keys(EXPECTED_ROLES).sort()).toEqual([...PERMISSION_ACTIONS].sort());
  });

  for (const action of PERMISSION_ACTIONS) {
    for (const role of USER_ROLES) {
      const expected = EXPECTED_ROLES[action].includes(role);
      it(`${role} ${expected ? 'may' : 'may not'} ${action}`, () => {
        expect(can(role, action)).toBe(expected);
      });
    }
  }

  it('gives every role at least one action, so no role is decorative', () => {
    for (const role of USER_ROLES) {
      expect(PERMISSION_ACTIONS.some((action) => can(role, action))).toBe(true);
    }
  });

  it('is monotone in the role level', () => {
    for (const action of PERMISSION_ACTIONS) {
      for (const lower of USER_ROLES) {
        for (const higher of USER_ROLES) {
          if (ROLE_LEVELS[higher] >= ROLE_LEVELS[lower] && can(lower, action)) {
            expect(can(higher, action)).toBe(true);
          }
        }
      }
    }
  });
});

describe('can — subject rules', () => {
  it('lets only an open question be answered (first answer wins)', () => {
    expect(can('member', 'task.answer_question', { kind: 'question', status: 'open' })).toBe(true);
    expect(can('admin', 'task.answer_question', { kind: 'question', status: 'answered' })).toBe(
      false,
    );
    expect(can('admin', 'task.answer_question', { kind: 'question', status: 'expired' })).toBe(
      false,
    );
    // A subject of an unrelated kind never changes the answer.
    expect(can('member', 'task.read', { kind: 'question', status: 'answered' })).toBe(true);
  });

  it('lets only a pending approval be decided', () => {
    expect(can('maintainer', 'task.approve_plan', { kind: 'approval', status: 'pending' })).toBe(
      true,
    );
    expect(can('admin', 'task.approve_plan', { kind: 'approval', status: 'approved' })).toBe(false);
    expect(can('admin', 'kb.proposal.decide', { kind: 'approval', status: 'expired' })).toBe(false);
    expect(can('admin', 'task.approve_budget', { kind: 'approval', status: 'rejected' })).toBe(
      false,
    );
    expect(can('admin', 'task.rework', { kind: 'approval', status: 'rejected' })).toBe(false);
    expect(can('maintainer', 'task.read', { kind: 'approval', status: 'approved' })).toBe(true);
  });

  it('lets only a running run be steered, and only a finished one be retried', () => {
    expect(can('member', 'run.steer', { kind: 'run', status: 'running' })).toBe(true);
    expect(can('admin', 'run.steer', { kind: 'run', status: 'starting' })).toBe(false);
    expect(can('member', 'run.cancel', { kind: 'run', status: 'created' })).toBe(true);
    expect(can('member', 'run.cancel', { kind: 'run', status: 'completed' })).toBe(false);
    expect(can('member', 'run.retry', { kind: 'run', status: 'failed' })).toBe(true);
    expect(can('member', 'run.retry', { kind: 'run', status: 'running' })).toBe(false);
    expect(can('viewer', 'run.read', { kind: 'run', status: 'running' })).toBe(true);
  });

  it('refuses control actions on a finished task', () => {
    for (const state of ['done', 'cancelled'] as const) {
      expect(can('admin', 'task.pause', { kind: 'task', state })).toBe(false);
      expect(can('admin', 'task.cancel', { kind: 'task', state })).toBe(false);
      expect(can('admin', 'task.take_over', { kind: 'task', state })).toBe(false);
      expect(can('admin', 'task.retry_stage', { kind: 'task', state })).toBe(false);
      expect(can('admin', 'task.return_to_stage', { kind: 'task', state })).toBe(false);
      expect(can('admin', 'task.hand_back', { kind: 'task', state })).toBe(false);
      expect(can('admin', 'task.rework', { kind: 'task', state })).toBe(false);
      expect(can('viewer', 'task.read', { kind: 'task', state })).toBe(true);
    }
    expect(can('member', 'task.pause', { kind: 'task', state: 'active' })).toBe(true);
  });

  it('resumes only from a state that is waiting for something', () => {
    for (const state of ['paused', 'waiting_answers', 'waiting_approval', 'needs_human'] as const) {
      expect(can('member', 'task.resume', { kind: 'task', state })).toBe(true);
    }
    expect(can('admin', 'task.resume', { kind: 'task', state: 'active' })).toBe(false);
  });
});

describe('assertCan', () => {
  it('passes silently when allowed', () => {
    expect(() => assertCan('maintainer', 'budget.write')).not.toThrow();
  });

  it('throws a typed error naming the action and the role', () => {
    expect(() => assertCan('viewer', 'budget.write')).toThrow(PermissionDeniedError);
    try {
      assertCan('viewer', 'budget.write');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(PermissionDeniedError);
      const denied = error as PermissionDeniedError;
      expect(denied.code).toBe('permission_denied');
      expect(denied.action).toBe('budget.write');
      expect(denied.role).toBe('viewer');
    }
  });

  it('honours the subject', () => {
    expect(() =>
      assertCan('admin', 'task.answer_question', { kind: 'question', status: 'answered' }),
    ).toThrow(PermissionDeniedError);
  });
});

describe('approval kinds map onto permissions', () => {
  it('routes each kind to the permission its decider needs', () => {
    expect(APPROVAL_ACTIONS).toEqual({
      plan: 'task.approve_plan',
      budget: 'task.approve_budget',
      knowledge: 'kb.proposal.decide',
      rework: 'task.rework',
    });
    for (const action of Object.values(APPROVAL_ACTIONS)) {
      expect(PERMISSION_REQUIREMENTS[action]).toBe('maintainer');
    }
  });
});

describe('isActionableIdentity (BD-022, Q10)', () => {
  it('lets only a mapped, verified identity trigger anything', () => {
    expect(isActionableIdentity({ verified: true })).toBe(true);
    expect(isActionableIdentity({ verified: false })).toBe(false);
  });
});
