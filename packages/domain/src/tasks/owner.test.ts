/**
 * S-26.1 — a task's owner, the pure half (TD-031's 2026-11-06 amendment items 1–3 and 6).
 *
 * The permission matrix is restated here **by hand**, cell by cell, from the M26 UX spec § 2 — the
 * table a reviewer reads — and the task DTO's three flags are held to the function the route
 * decides with over every input, so the page cannot offer what the route would refuse.
 */
import type { Id, IsoDateTime, TaskState, TicketAssignee, UserRole } from '@platform/contracts';
import { TICKET_ASSIGNEE_NAME_MAX_CHARS } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import {
  adoptOwnerOnLink,
  decideOwnerCommand,
  type OwnerTarget,
  ownerCapabilities,
  ownerChangePermitted,
  ownerTargetOf,
  recordPlatformAssign,
  recordPlatformUnassign,
  sameTicketAssignee,
  syncOwnerFromTracker,
  type TaskOwnership,
  taskHeldElsewhere,
  taskIsUnassigned,
  ticketAssigneeOf,
  UNOWNED,
} from './owner.js';

const ME = '00000000-0000-4000-8000-0000000000e1' as Id;
const OTHER = '00000000-0000-4000-8000-0000000000e2' as Id;
const AT = '2026-11-07T09:00:00.000Z' as IsoDateTime;

const person = (external_id: string, platform = false): TicketAssignee => ({
  provider: 'jira-cloud',
  external_id,
  display_name: 'Jan Novák',
  platform,
});

const owned = (ownerUserId: Id | null, ticketAssignee: TicketAssignee | null = null) =>
  ({
    ownerUserId,
    ownerSource: ownerUserId === null ? null : 'platform',
    ownerChangedAt: ownerUserId === null ? null : AT,
    ticketAssignee,
  }) satisfies TaskOwnership;

describe('held elsewhere and unassigned (TD-031 item 6)', () => {
  it('is held elsewhere only for a stored person the platform cannot map', () => {
    expect(taskHeldElsewhere({ ticketAssignee: null, assigneeIsLinkedMember: false })).toBe(false);
    expect(
      taskHeldElsewhere({ ticketAssignee: person('bot', true), assigneeIsLinkedMember: false }),
    ).toBe(false);
    expect(taskHeldElsewhere({ ticketAssignee: person('dev'), assigneeIsLinkedMember: true })).toBe(
      false,
    );
    expect(
      taskHeldElsewhere({ ticketAssignee: person('dev'), assigneeIsLinkedMember: false }),
    ).toBe(true);
  });

  it('is unassigned with no owner and nothing held elsewhere — a member’s release included', () => {
    expect(taskIsUnassigned({ ownerUserId: null, heldElsewhere: false })).toBe(true);
    expect(taskIsUnassigned({ ownerUserId: null, heldElsewhere: true })).toBe(false);
    expect(taskIsUnassigned({ ownerUserId: ME, heldElsewhere: false })).toBe(false);
  });
});

describe('the tracker sync (TD-031 item 2)', () => {
  it('makes a linked member the owner, from the tracker', () => {
    const decision = syncOwnerFromTracker(UNOWNED, {
      assignee: person('dev'),
      assigneeClass: { kind: 'member', userId: ME },
      at: AT,
    });
    expect(decision).toEqual({
      kind: 'write',
      next: {
        ownerUserId: ME,
        ownerSource: 'tracker',
        ownerChangedAt: AT,
        ticketAssignee: person('dev'),
      },
      change: {
        ownerUserId: ME,
        previousOwnerUserId: null,
        source: 'tracker',
        via: 'tracker_sync',
      },
    });
  });

  it.each([
    ['an unlinked person or a non-member', { kind: 'person' } as const, false],
    ['a machine or the binding’s own account', { kind: 'platform' } as const, true],
  ])('stores %s as the assignee and leaves the owner null', (_label, assigneeClass, platform) => {
    const assignee = person('x', platform);
    const decision = syncOwnerFromTracker(UNOWNED, { assignee, assigneeClass, at: AT });
    expect(decision).toEqual({
      kind: 'write',
      next: { ...UNOWNED, ticketAssignee: assignee },
      change: null,
    });
  });

  it('acts only on a different identity: a drifting display name is the same assignee', () => {
    const current = owned(OTHER, person('dev'));
    expect(
      syncOwnerFromTracker(current, {
        assignee: { ...person('dev'), display_name: 'Jan N.' },
        assigneeClass: { kind: 'member', userId: ME },
        at: AT,
      }),
    ).toEqual({ kind: 'unchanged' });
    expect(sameTicketAssignee(person('a'), { ...person('a'), provider: 'gitlab' })).toBe(false);
    expect(sameTicketAssignee(null, null)).toBe(true);
    expect(sameTicketAssignee(person('a'), null)).toBe(false);
  });

  it('replaces a platform owner when the tracker changes, and unassigning in the tracker clears it', () => {
    const current = owned(OTHER, person('old'));
    const moved = syncOwnerFromTracker(current, {
      assignee: person('dev'),
      assigneeClass: { kind: 'member', userId: ME },
      at: AT,
    });
    expect(moved.kind === 'write' && moved.change).toEqual({
      ownerUserId: ME,
      previousOwnerUserId: OTHER,
      source: 'tracker',
      via: 'tracker_sync',
    });
    const cleared = syncOwnerFromTracker(current, { assignee: null, assigneeClass: null, at: AT });
    expect(cleared.kind === 'write' && cleared.next).toEqual({
      ownerUserId: null,
      ownerSource: 'tracker',
      ownerChangedAt: AT,
      ticketAssignee: null,
    });
  });

  it('keeps the owner when the tracker moves to a platform assignee, and stores the assignee (review of #92)', () => {
    // The claim's own `assignToSelf` read back: a person's owner, from either side, survives it.
    for (const ownerSource of ['platform', 'tracker'] as const) {
      const current: TaskOwnership = { ...owned(ME, person('dev')), ownerSource };
      for (const read of [
        { assignee: person('bot', true), assigneeClass: { kind: 'platform' } as const },
        // A stored platform flag decides it too, whatever the class says.
        { assignee: person('bot', true), assigneeClass: { kind: 'person' } as const },
      ]) {
        expect(syncOwnerFromTracker(current, { ...read, at: AT }), ownerSource).toEqual({
          kind: 'write',
          next: { ...current, ticketAssignee: person('bot', true) },
          change: null,
        });
      }
    }
    // …and a real change after it still wins.
    const claimed = owned(ME, person('bot', true));
    const moved = syncOwnerFromTracker(claimed, {
      assignee: person('other'),
      assigneeClass: { kind: 'member', userId: OTHER },
      at: AT,
    });
    expect(moved.kind === 'write' && moved.change?.ownerUserId).toBe(OTHER);
  });

  it('bounds the stored name to the column, by whole code points', () => {
    const long = '😀'.repeat(TICKET_ASSIGNEE_NAME_MAX_CHARS);
    const stored = ticketAssigneeOf(
      { provider: 'jira-cloud', externalId: 'dev', redactedDisplayName: long },
      { kind: 'person' },
    );
    expect(stored?.display_name?.length).toBe(TICKET_ASSIGNEE_NAME_MAX_CHARS);
    expect(stored?.display_name).toBe('😀'.repeat(TICKET_ASSIGNEE_NAME_MAX_CHARS / 2));
    expect(
      ticketAssigneeOf(
        { provider: 'jira-cloud', externalId: 'dev', redactedDisplayName: '' },
        { kind: 'platform' },
      ),
    ).toEqual({ provider: 'jira-cloud', external_id: 'dev', display_name: null, platform: true });
    expect(ticketAssigneeOf(null, null)).toBeNull();
  });
});

describe('the permission matrix (the M26 UX spec § 2, TD-031 item 3)', () => {
  /** `[role, owner, heldElsewhere, target] → permitted`, every cell written out. */
  const MATRIX: readonly [UserRole, 'nobody' | 'me' | 'other', boolean, OwnerTarget, boolean][] = [
    // A member takes an unassigned task, and only that.
    ['member', 'nobody', false, 'self', true],
    ['member', 'nobody', true, 'self', false],
    ['member', 'other', false, 'self', false],
    ['member', 'me', false, 'self', true],
    // A member releases their own, and only that.
    ['member', 'me', false, 'nobody', true],
    ['member', 'other', false, 'nobody', false],
    ['member', 'nobody', false, 'nobody', false],
    // A member never assigns somebody else.
    ['member', 'nobody', false, 'another', false],
    ['member', 'me', false, 'another', false],
    // A maintainer sets anyone or nobody, on any task.
    ['maintainer', 'other', true, 'self', true],
    ['maintainer', 'other', false, 'another', true],
    ['maintainer', 'other', false, 'nobody', true],
    ['maintainer', 'nobody', true, 'another', true],
    ['admin', 'other', true, 'nobody', true],
    // A viewer does nothing.
    ['viewer', 'nobody', false, 'self', false],
    ['viewer', 'me', false, 'nobody', false],
  ];

  it.each(MATRIX)(
    '%s, owner %s, held elsewhere %s, target %s → %s',
    (role, owner, held, target, permitted) => {
      expect(
        ownerChangePermitted({
          actorUserId: ME,
          actorRole: role,
          ownerUserId: owner === 'nobody' ? null : owner === 'me' ? ME : OTHER,
          heldElsewhere: held,
          target,
        }),
      ).toBe(permitted);
    },
  );

  it('names the target from the caller’s side', () => {
    expect(ownerTargetOf(ME, ME)).toBe('self');
    expect(ownerTargetOf(ME, null)).toBe('nobody');
    expect(ownerTargetOf(ME, OTHER)).toBe('another');
  });
});

describe('the command (TD-031 item 3)', () => {
  const base = {
    actorUserId: ME,
    actorRole: 'member' as UserRole,
    taskState: 'active' as TaskState,
    heldElsewhere: false,
    targetUserId: ME as Id | null,
    targetMayOwn: true,
    at: AT,
  };

  it('refuses in order: the matrix, the target’s role, the state', () => {
    expect(decideOwnerCommand(owned(OTHER), base)).toEqual({
      kind: 'refused',
      reason: 'owner_change_not_permitted',
    });
    // A caller who may not act learns nothing about whom they named.
    expect(decideOwnerCommand(owned(OTHER), { ...base, targetMayOwn: false })).toEqual({
      kind: 'refused',
      reason: 'owner_change_not_permitted',
    });
    expect(
      decideOwnerCommand(owned(null), {
        ...base,
        actorRole: 'maintainer',
        targetUserId: OTHER,
        targetMayOwn: false,
      }),
    ).toEqual({ kind: 'refused', reason: 'owner_not_project_member' });
    for (const taskState of ['done', 'cancelled'] as const) {
      expect(decideOwnerCommand(owned(null), { ...base, taskState })).toEqual({
        kind: 'refused',
        reason: 'task_finished',
      });
    }
  });

  it('takes an unassigned task as a platform change and leaves the stored assignee alone', () => {
    const assignee = person('bot', true);
    const decision = decideOwnerCommand(owned(null, assignee), base);
    expect(decision).toEqual({
      kind: 'write',
      next: {
        ownerUserId: ME,
        ownerSource: 'platform',
        ownerChangedAt: AT,
        ticketAssignee: assignee,
      },
      change: { ownerUserId: ME, previousOwnerUserId: null, source: 'platform', via: 'command' },
    });
  });

  it('answers unchanged for the owner the task already has', () => {
    expect(decideOwnerCommand(owned(ME), base)).toEqual({ kind: 'unchanged' });
    expect(
      decideOwnerCommand(owned(null), { ...base, actorRole: 'admin', targetUserId: null }),
    ).toEqual({ kind: 'unchanged' });
  });
});

describe('the task DTO’s flags come from the route’s function', () => {
  const ROLES: readonly UserRole[] = ['viewer', 'member', 'maintainer', 'admin'];
  const OWNERS: readonly (Id | null)[] = [null, ME, OTHER];
  const STATES: readonly TaskState[] = ['active', 'needs_human', 'done', 'cancelled'];

  it('offers each control exactly when the matrix permits it on a live task', () => {
    for (const role of ROLES) {
      for (const ownerUserId of OWNERS) {
        for (const heldElsewhere of [false, true]) {
          for (const taskState of STATES) {
            const flags = ownerCapabilities({
              actorUserId: ME,
              actorRole: role,
              ownerUserId,
              heldElsewhere,
              taskState,
            });
            const live = taskState !== 'done' && taskState !== 'cancelled';
            const permitted = (target: OwnerTarget) =>
              ownerChangePermitted({
                actorUserId: ME,
                actorRole: role,
                ownerUserId,
                heldElsewhere,
                target,
              });
            const label = `${role}/${String(ownerUserId)}/${String(heldElsewhere)}/${taskState}`;
            expect(flags, label).toEqual({
              can_take: live && ownerUserId !== ME && permitted('self'),
              can_assign: live && permitted('another'),
              can_unassign: live && ownerUserId !== null && permitted('nobody'),
            });
            // …and each flag the page shows is a request the command would accept.
            if (flags.can_take) {
              expect(
                decideOwnerCommand(owned(ownerUserId), {
                  actorUserId: ME,
                  actorRole: role,
                  taskState,
                  heldElsewhere,
                  targetUserId: ME,
                  targetMayOwn: true,
                  at: AT,
                }).kind,
                label,
              ).toBe('write');
            }
          }
        }
      }
    }
  });

  it('offers nothing to a caller with no role', () => {
    expect(
      ownerCapabilities({
        actorUserId: ME,
        actorRole: undefined,
        ownerUserId: null,
        heldElsewhere: false,
        taskState: 'active',
      }),
    ).toEqual({ can_take: false, can_assign: false, can_unassign: false });
  });
});

describe('a link adopts the owner (the hook S-26.6 calls)', () => {
  const link = { provider: 'jira-cloud', externalId: 'dev', userId: ME, userMayOwn: true, at: AT };

  it('adopts an unowned task whose stored assignee is the linked identity', () => {
    expect(adoptOwnerOnLink(owned(null, person('dev')), link)).toEqual({
      kind: 'write',
      next: {
        ownerUserId: ME,
        ownerSource: 'tracker',
        ownerChangedAt: AT,
        ticketAssignee: person('dev'),
      },
      change: { ownerUserId: ME, previousOwnerUserId: null, source: 'tracker', via: 'link' },
    });
  });

  it('leaves an owned task, another identity, a platform account and a non-member alone', () => {
    expect(adoptOwnerOnLink(owned(OTHER, person('dev')), link).kind).toBe('unchanged');
    expect(adoptOwnerOnLink(owned(null, person('someone')), link).kind).toBe('unchanged');
    expect(adoptOwnerOnLink(owned(null, person('dev', true)), link).kind).toBe('unchanged');
    expect(adoptOwnerOnLink(owned(null, person('dev')), { ...link, userMayOwn: false }).kind).toBe(
      'unchanged',
    );
    expect(adoptOwnerOnLink(owned(null, null), link).kind).toBe('unchanged');
  });
});

/**
 * S-26.2 criterion 4 (TD-031 item 2): the platform's own tracker writes are recorded as the
 * last-seen assignee, so the read that follows them is no change and costs nobody their owner.
 */
describe('the platform’s own tracker writes (S-26.2)', () => {
  const bot = person('bot', true);

  it('(4) the claim’s assign stores the binding’s account and keeps the owner; the next read of it changes nothing', () => {
    const before = owned(ME, null);
    const decision = recordPlatformAssign(before, bot);
    expect(decision).toEqual({
      kind: 'write',
      next: { ...before, ticketAssignee: bot },
      change: null,
    });
    const after = decision.kind === 'write' ? decision.next : before;
    expect(
      syncOwnerFromTracker(after, {
        assignee: { ...bot, display_name: 'renamed' },
        assigneeClass: { kind: 'platform' },
        at: AT,
      }),
    ).toEqual({ kind: 'unchanged' });
    // Recording it twice is a no-op.
    expect(recordPlatformAssign(after, bot)).toEqual({ kind: 'unchanged' });
  });

  it('the release’s unassign clears the binding’s account, keeps the owner, and never touches a person', () => {
    const held = owned(ME, bot);
    const decision = recordPlatformUnassign(held, bot);
    expect(decision).toEqual({
      kind: 'write',
      next: { ...held, ticketAssignee: null },
      change: null,
    });
    const after = decision.kind === 'write' ? decision.next : held;
    // The read after the release (nobody) is no change: the platform-set owner survives a Rework.
    expect(syncOwnerFromTracker(after, { assignee: null, assigneeClass: null, at: AT })).toEqual({
      kind: 'unchanged',
    });
    expect(recordPlatformUnassign(owned(ME, person('dev')), bot)).toEqual({ kind: 'unchanged' });
    expect(recordPlatformUnassign(owned(ME, null), bot)).toEqual({ kind: 'unchanged' });
  });
});
