/**
 * **Latest change wins** — S-26.1 criterion 2, TD-031's 2026-11-06 amendment item 2, as a property
 * over interleaved tracker changes, tracker reads, platform commands and the claim's own assign.
 *
 * The model is the amendment's sentence, written without the decision functions: the owner is
 * whatever the **latest change** made it — a platform command's target, or the mapping of the
 * tracker's assignee at a read that saw a **different** assignee from the one last read — with one
 * exception the review of PR #92 added: a read that names a **platform** assignee (the binding's
 * own account) keeps the owner it finds. Folded over the real decisions (`syncOwnerFromTracker`,
 * `decideOwnerCommand`) it must agree with the model after every step, and a read must change
 * nothing when the read assignee is the stored one.
 *
 * The claim's assign comes in two shapes, and each proves one thing:
 *
 *  - `claim_assign` is **this build's** claim: `assignToSelf` moves the tracker to the binding's
 *    account and stores nothing. It proves the guard — the next read sees a different, platform
 *    assignee, and the owner a person set survives it.
 *  - `claim_assign_recorded` is **S-26.2's** claim, which also writes the binding's account into
 *    `ticket_assignee` in its transaction. The step writes the column directly, as that claim
 *    will; what it proves is only that a read after such a write is no change at all, never that
 *    the claim makes it.
 */
import type { Id, IsoDateTime, TicketAssignee } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PROPERTY_TEST_TIMEOUT_MS } from '../testing/property.js';
import {
  type AssigneeClass,
  decideOwnerCommand,
  syncOwnerFromTracker,
  type TaskOwnership,
  UNOWNED,
} from './owner.js';

const ALICE = '00000000-0000-4000-8000-00000000a11c' as Id;
const BOB = '00000000-0000-4000-8000-0000000000b0' as Id;
const MAINTAINER = '00000000-0000-4000-8000-00000000ffff' as Id;
const AT = '2026-11-07T09:00:00.000Z' as IsoDateTime;

/** The tracker accounts: two linked members, one unlinked person, the binding's own account. */
type Account = 'alice' | 'bob' | 'carol' | 'bot';

const CLASS: Readonly<Record<Account, AssigneeClass>> = {
  alice: { kind: 'member', userId: ALICE },
  bob: { kind: 'member', userId: BOB },
  carol: { kind: 'person' },
  bot: { kind: 'platform' },
};

const stored = (account: Account | null): TicketAssignee | null =>
  account === null
    ? null
    : {
        provider: 'jira-cloud',
        external_id: `acct-${account}`,
        display_name: account,
        platform: CLASS[account].kind === 'platform',
      };

/** The mapping a tracker change gives the owner: a linked member, or nobody. */
const mapped = (account: Account | null): Id | null => {
  if (account === null) return null;
  const assignee = CLASS[account];
  return assignee.kind === 'member' ? assignee.userId : null;
};

type Step =
  | { readonly kind: 'tracker'; readonly account: Account | null }
  | { readonly kind: 'read' }
  | { readonly kind: 'command'; readonly target: Id | null }
  | { readonly kind: 'claim_assign' }
  | { readonly kind: 'claim_assign_recorded' };

const steps = fc.array(
  fc.oneof(
    fc.record({
      kind: fc.constant('tracker' as const),
      account: fc.constantFrom<Account | null>('alice', 'bob', 'carol', 'bot', null),
    }),
    fc.constant({ kind: 'read' as const }),
    fc.record({
      kind: fc.constant('command' as const),
      target: fc.constantFrom<Id | null>(ALICE, BOB, null),
    }),
    fc.constant({ kind: 'claim_assign' as const }),
    fc.constant({ kind: 'claim_assign_recorded' as const }),
  ),
  { maxLength: 40 },
);

describe('latest change wins (S-26.1 criterion 2)', () => {
  it(
    'agrees with the model after every step: a read changes the owner only on a new assignee, the claim’s assign never',
    () => {
      fc.assert(
        fc.property(steps, (sequence: readonly Step[]) => {
          let tracker: Account | null = null;
          let ownership: TaskOwnership = UNOWNED;
          // The model: the latest change, and the assignee the platform last read.
          let modelOwner: Id | null = null;
          let modelLastRead: Account | null = null;
          for (const step of sequence) {
            const before = ownership;
            switch (step.kind) {
              case 'tracker': {
                tracker = step.account;
                break;
              }
              case 'read': {
                const decision = syncOwnerFromTracker(ownership, {
                  assignee: stored(tracker),
                  assigneeClass: tracker === null ? null : CLASS[tracker],
                  at: AT,
                });
                const differs = tracker !== modelLastRead;
                if (!differs) {
                  // A read of the assignee already stored changes nothing at all.
                  expect(decision).toEqual({ kind: 'unchanged' });
                }
                if (decision.kind === 'write') {
                  ownership = decision.next;
                  if (decision.change !== null) {
                    expect(decision.change).toMatchObject({
                      source: 'tracker',
                      via: 'tracker_sync',
                    });
                    expect(decision.change.previousOwnerUserId).toBe(before.ownerUserId);
                  }
                }
                if (differs) {
                  // A platform assignee keeps the owner; any other change maps it.
                  if (tracker === null || CLASS[tracker].kind !== 'platform') {
                    modelOwner = mapped(tracker);
                  }
                  modelLastRead = tracker;
                }
                break;
              }
              case 'command': {
                const decision = decideOwnerCommand(ownership, {
                  actorUserId: MAINTAINER,
                  actorRole: 'maintainer',
                  taskState: 'active',
                  heldElsewhere: false,
                  targetUserId: step.target,
                  targetMayOwn: true,
                  at: AT,
                });
                expect(decision.kind).not.toBe('refused');
                if (decision.kind === 'write') {
                  ownership = decision.next;
                  // A platform assignment never touches the stored assignee.
                  expect(ownership.ticketAssignee).toEqual(before.ticketAssignee);
                }
                modelOwner = step.target;
                break;
              }
              case 'claim_assign': {
                // This build's claim: only the tracker moves; the next read meets the guard.
                tracker = 'bot';
                break;
              }
              case 'claim_assign_recorded': {
                // S-26.2's claim, written directly: the tracker and the stored assignee together.
                tracker = 'bot';
                ownership = { ...ownership, ticketAssignee: stored('bot') };
                modelLastRead = 'bot';
                break;
              }
            }
            expect(ownership.ownerUserId).toBe(modelOwner);
          }
          // …and the read right after either claim keeps the owner: no change at all after
          // S-26.2's, and at most the stored assignee after this build's.
          const last = sequence.at(-1)?.kind;
          if (last === 'claim_assign' || last === 'claim_assign_recorded') {
            const after = syncOwnerFromTracker(ownership, {
              assignee: stored('bot'),
              assigneeClass: CLASS.bot,
              at: AT,
            });
            if (last === 'claim_assign_recorded') {
              expect(after).toEqual({ kind: 'unchanged' });
            }
            expect(after.kind === 'write' ? after.change : null).toBeNull();
            expect(after.kind === 'write' ? after.next.ownerUserId : ownership.ownerUserId).toBe(
              ownership.ownerUserId,
            );
          }
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );

  it(
    'records an owner change exactly when the owner moved',
    () => {
      fc.assert(
        fc.property(steps, (sequence: readonly Step[]) => {
          let tracker: Account | null = null;
          let ownership: TaskOwnership = UNOWNED;
          for (const step of sequence) {
            const decision =
              step.kind === 'read'
                ? syncOwnerFromTracker(ownership, {
                    assignee: stored(tracker),
                    assigneeClass: tracker === null ? null : CLASS[tracker],
                    at: AT,
                  })
                : step.kind === 'command'
                  ? decideOwnerCommand(ownership, {
                      actorUserId: MAINTAINER,
                      actorRole: 'admin',
                      taskState: 'active',
                      heldElsewhere: true,
                      targetUserId: step.target,
                      targetMayOwn: true,
                      at: AT,
                    })
                  : null;
            if (step.kind === 'tracker') {
              tracker = step.account;
            }
            if (decision !== null && decision.kind === 'write') {
              const moved = decision.next.ownerUserId !== ownership.ownerUserId;
              expect(decision.change !== null).toBe(moved);
              ownership = decision.next;
            }
            if (decision !== null && decision.kind === 'unchanged') {
              expect(step.kind === 'command' ? step.target : ownership.ownerUserId).toBe(
                ownership.ownerUserId,
              );
            }
          }
        }),
      );
    },
    PROPERTY_TEST_TIMEOUT_MS,
  );
});
