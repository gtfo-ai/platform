/**
 * S-26.3 — writing the owner back to the tracker, the pure half (TD-031's 2026-11-06 amendment
 * item 4): which changes ask for it, the re-validation on fire, and the stored assignee's preset and
 * restore. The duty that asks these is `packages/application/src/pipeline/owner-write-back.test.ts`'s.
 */
import type { Id, IsoDateTime, TicketAssignee } from '@platform/contracts';
import { describe, expect, it } from 'vitest';
import { syncOwnerFromTracker, type TaskOwnership, UNOWNED } from './owner.js';
import {
  intendedTicketAssignee,
  ownerChangeWritesBack,
  ownerWriteBackBlocker,
  ownerWriteBackReachesTracker,
  ownerWriteBackStillDue,
  presetTicketAssignee,
  restoreTicketAssignee,
} from './owner-write-back.js';

const BOB = '00000000-0000-4000-8000-0000000000b0' as Id;
const CAROL = '00000000-0000-4000-8000-0000000000c0' as Id;
const AT = '2026-11-07T09:00:00.000Z' as IsoDateTime;
const LATER = '2026-11-07T09:05:00.000Z' as IsoDateTime;

const assignee = (account: string, platform = false): TicketAssignee => ({
  provider: 'jira-cloud',
  external_id: `acct-${account}`,
  display_name: `${account} name`,
  platform,
});

const ownedByBob: TaskOwnership = {
  ownerUserId: BOB,
  ownerSource: 'platform',
  ownerChangedAt: AT,
  ticketAssignee: assignee('alice'),
};

describe('which owner changes ask for the write-back (criteria 1 and 6)', () => {
  it('is a platform change that names somebody — never a release, never a tracker sync', () => {
    expect(ownerChangeWritesBack({ ownerUserId: BOB, source: 'platform' })).toBe(true);
    expect(ownerChangeWritesBack({ ownerUserId: null, source: 'platform' })).toBe(false);
    expect(ownerChangeWritesBack({ ownerUserId: BOB, source: 'tracker' })).toBe(false);
    expect(ownerChangeWritesBack({ ownerUserId: null, source: 'tracker' })).toBe(false);
  });
});

describe('the duty’s re-validation on fire (criterion 3, TD-004)', () => {
  it('is due while the owner, its source and its instant are the event’s', () => {
    expect(ownerWriteBackStillDue(ownedByBob, { ownerUserId: BOB, ownerChangedAt: AT })).toBeNull();
    // The row reads back in another spelling of the same instant.
    expect(
      ownerWriteBackStillDue(
        { ...ownedByBob, ownerChangedAt: '2026-11-07T09:00:00Z' as IsoDateTime },
        { ownerUserId: BOB, ownerChangedAt: AT },
      ),
    ).toBeNull();
  });

  it('is not due once the tracker moved the task to Carol', () => {
    const moved = syncOwnerFromTracker(ownedByBob, {
      assignee: assignee('carol'),
      assigneeClass: { kind: 'member', userId: CAROL },
      at: LATER,
    });
    expect(moved.kind).toBe('write');
    const current = moved.kind === 'write' ? moved.next : ownedByBob;
    expect(ownerWriteBackStillDue(current, { ownerUserId: BOB, ownerChangedAt: AT })).toBe(
      'owner_changed',
    );
  });

  it('is not due for the same owner set again later, nor for an owner the tracker gave', () => {
    expect(
      ownerWriteBackStillDue(
        { ...ownedByBob, ownerChangedAt: LATER },
        { ownerUserId: BOB, ownerChangedAt: AT },
      ),
    ).toBe('owner_changed_again');
    expect(
      ownerWriteBackStillDue(
        { ...ownedByBob, ownerSource: 'tracker' },
        { ownerUserId: BOB, ownerChangedAt: AT },
      ),
    ).toBe('owner_not_platform');
    expect(
      ownerWriteBackStillDue(
        { ...ownedByBob, ownerChangedAt: null },
        { ownerUserId: BOB, ownerChangedAt: AT },
      ),
    ).toBe('owner_changed_again');
    expect(ownerWriteBackStillDue(UNOWNED, { ownerUserId: BOB, ownerChangedAt: AT })).toBe(
      'owner_changed',
    );
  });
});

describe('the stored assignee before and after the call (criterion 2)', () => {
  const intended = intendedTicketAssignee({ provider: 'jira-cloud', externalId: 'acct-bob' });

  it('presets the intended identity, keeping the owner, and the next read of it changes nothing', () => {
    const preset = presetTicketAssignee(ownedByBob, intended);
    expect(preset).toEqual({
      kind: 'write',
      next: { ...ownedByBob, ticketAssignee: intended },
      change: null,
    });
    const after = preset.kind === 'write' ? preset.next : ownedByBob;
    // The tracker answers the call's own result, display name and all: the same identity.
    expect(
      syncOwnerFromTracker(after, {
        assignee: { ...intended, display_name: 'Bob Example' },
        assigneeClass: { kind: 'member', userId: BOB },
        at: LATER,
      }),
    ).toEqual({ kind: 'unchanged' });
    // Without the preset, the same read would have been a change (the counter moves).
    expect(
      syncOwnerFromTracker(ownedByBob, {
        assignee: { ...intended, display_name: 'Bob Example' },
        assigneeClass: { kind: 'member', userId: BOB },
        at: LATER,
      }).kind,
    ).toBe('write');
  });

  it('presets nothing when the column already names the identity', () => {
    expect(presetTicketAssignee({ ...ownedByBob, ticketAssignee: intended }, intended)).toEqual({
      kind: 'unchanged',
    });
  });

  it('puts the previous value back while the column still holds the intended one', () => {
    const previous = assignee('alice');
    expect(
      restoreTicketAssignee({ ...ownedByBob, ticketAssignee: intended }, { intended, previous }),
    ).toEqual({
      kind: 'write',
      next: { ...ownedByBob, ticketAssignee: previous },
      change: null,
    });
    expect(
      restoreTicketAssignee(
        { ...ownedByBob, ticketAssignee: intended },
        { intended, previous: null },
      ),
    ).toEqual({ kind: 'write', next: { ...ownedByBob, ticketAssignee: null }, change: null });
  });

  it('leaves a newer read alone, and restores nothing when nothing was replaced', () => {
    expect(
      restoreTicketAssignee(
        { ...ownedByBob, ticketAssignee: assignee('carol') },
        { intended, previous: assignee('alice') },
      ),
    ).toEqual({ kind: 'unchanged' });
    expect(
      restoreTicketAssignee(
        { ...ownedByBob, ticketAssignee: intended },
        { intended, previous: intended },
      ),
    ).toEqual({ kind: 'unchanged' });
  });

  it('stores no display name and never a platform flag for the owner', () => {
    expect(intended).toEqual({
      provider: 'jira-cloud',
      external_id: 'acct-bob',
      display_name: null,
      platform: false,
    });
  });
});

describe('the one predicate every promise of the write asks (review of #97)', () => {
  const all = { assignOwner: true, providerTicket: true, hasPersonIdentity: true };

  it('names the first thing in the way, or nothing', () => {
    expect(ownerWriteBackBlocker(all)).toBeNull();
    expect(ownerWriteBackBlocker({ ...all, assignOwner: false })).toBe('switch_off');
    expect(ownerWriteBackBlocker({ ...all, providerTicket: false })).toBe('no_provider_ticket');
    expect(ownerWriteBackBlocker({ ...all, hasPersonIdentity: false })).toBe(
      'owner_has_no_identity',
    );
  });

  it('reaches the tracker only with nothing in the way and not in shadow mode', () => {
    expect(ownerWriteBackReachesTracker({ ...all, shadow: false })).toBe(true);
    expect(ownerWriteBackReachesTracker({ ...all, shadow: true })).toBe(false);
    for (const key of ['assignOwner', 'providerTicket', 'hasPersonIdentity'] as const) {
      expect(ownerWriteBackReachesTracker({ ...all, [key]: false, shadow: false }), key).toBe(
        false,
      );
    }
  });
});
