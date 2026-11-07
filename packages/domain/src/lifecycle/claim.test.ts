/**
 * The ticket claim's pure rules — WP-177 (BD-031 ruling 5, TD-029 decisions 1, 3 and 5).
 *
 * Every status name here is an invented fixture value (BD-031 ruling 1).
 */
import type { ExternalIdentity, StoredTicketClaim, TicketLifecycle } from '@platform/contracts';
import { LIFECYCLE_SINGLE_SLOTS } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { PLATFORM_COMMENT_MARKERS } from '../ask/ask.js';
import {
  claimPreReadDecision,
  claimReadback,
  claimRefusedCommentMarker,
  intakeSkipsAssignedTicket,
  lifecycleClaims,
  lifecycleMapsAnySlot,
  sameAccount,
  ticketClaimHeld,
  ticketClaimIsFirst,
  ticketClaimNeeded,
} from './claim.js';

const identity = (external_id: string, provider = 'fake-task-management'): ExternalIdentity => ({
  provider,
  external_id,
  verified: false,
});

const SELF = identity('agentic-bot');
const PERSON = identity('jane');
const MEMBER = identity('acct-alice');
/** The directory's answer for an assignee who is not a linked member. */
const UNLINKED = { assigneeIsLinkedMember: false } as const;

const claim = (overrides: Partial<StoredTicketClaim> = {}): StoredTicketClaim => ({
  account_id: 'agentic-bot',
  claimed_at: '2026-10-08T09:00:00.000Z',
  status: 'confirmed',
  in_progress_written: true,
  stale: false,
  released_at: null,
  release_cause: null,
  ...overrides,
});

describe('lifecycleMapsAnySlot (TD-029 decision 3)', () => {
  it('is false for no block, an empty block, the switches alone and an empty returned list', () => {
    expect(lifecycleMapsAnySlot(undefined)).toBe(false);
    expect(lifecycleMapsAnySlot(null)).toBe(false);
    expect(lifecycleMapsAnySlot({})).toBe(false);
    expect(lifecycleMapsAnySlot({ claim: true, take_assigned_tickets: true })).toBe(false);
    expect(lifecycleMapsAnySlot({ returned: [] })).toBe(false);
  });

  it('is true for every single slot on its own, and for a returned status', () => {
    for (const slot of LIFECYCLE_SINGLE_SLOTS) {
      expect(lifecycleMapsAnySlot({ [slot]: 'Doing' }), slot).toBe(true);
    }
    expect(lifecycleMapsAnySlot({ returned: ['Sent back'] })).toBe(true);
  });

  it('property: true exactly when some single slot is named or returned is non-empty', () => {
    const name = fc.constantFrom('Doing', 'Waiting for review', 'Testing', 'Sent back');
    fc.assert(
      fc.property(
        fc.record(
          {
            in_progress: name,
            in_review: name,
            approved: name,
            qa: name,
            done: name,
            returned: fc.array(name, { maxLength: 2 }),
            claim: fc.boolean(),
          },
          { requiredKeys: [] },
        ),
        (block: TicketLifecycle) => {
          const named =
            LIFECYCLE_SINGLE_SLOTS.some((slot) => block[slot] !== undefined) ||
            (block.returned ?? []).length > 0;
          expect(lifecycleMapsAnySlot(block)).toBe(named);
        },
      ),
    );
  });
});

describe('lifecycleClaims (TD-029 decision 1)', () => {
  it('claims by default when a block exists, never without one, and not when switched off', () => {
    expect(lifecycleClaims(undefined)).toBe(false);
    expect(lifecycleClaims(null)).toBe(false);
    expect(lifecycleClaims({})).toBe(true);
    expect(lifecycleClaims({ claim: true })).toBe(true);
    expect(lifecycleClaims({ claim: false, in_progress: 'Doing' })).toBe(false);
  });
});

describe('intakeSkipsAssignedTicket (TD-029 decision 5)', () => {
  const block: TicketLifecycle = { in_progress: 'Doing' };

  it('skips a ticket assigned to somebody else on a claiming binding', () => {
    expect(
      intakeSkipsAssignedTicket({ lifecycle: block, self: SELF, assignee: PERSON, ...UNLINKED }),
    ).toBe(true);
  });

  it('takes an unassigned ticket, and one assigned to the binding’s own account', () => {
    expect(
      intakeSkipsAssignedTicket({ lifecycle: block, self: SELF, assignee: null, ...UNLINKED }),
    ).toBe(false);
    expect(
      intakeSkipsAssignedTicket({ lifecycle: block, self: SELF, assignee: SELF, ...UNLINKED }),
    ).toBe(false);
  });

  it('takes an assigned ticket when the project opts in, and on a binding that does not claim', () => {
    expect(
      intakeSkipsAssignedTicket({
        lifecycle: { ...block, take_assigned_tickets: true },
        self: SELF,
        assignee: PERSON,
        ...UNLINKED,
      }),
    ).toBe(false);
    expect(
      intakeSkipsAssignedTicket({
        lifecycle: undefined,
        self: SELF,
        assignee: PERSON,
        ...UNLINKED,
      }),
    ).toBe(false);
    expect(
      intakeSkipsAssignedTicket({
        lifecycle: { ...block, claim: false },
        self: SELF,
        assignee: PERSON,
        ...UNLINKED,
      }),
    ).toBe(false);
  });

  /**
   * S-26.2 criterion 1 (BD-031's 2026-11-06 amendment 2): the matrix — claiming or not, opted in
   * or not, and every kind of assignee. A linked member is never skipped; an unlinked person or a
   * non-member (a linked person below `member`: the directory answers *not a linked member* for
   * both) is skipped exactly as before.
   */
  it('S-26.2 (1): takes a linked member’s ticket even with take_assigned_tickets false; still skips an unlinked person or a non-member', () => {
    const lifecycles: readonly (TicketLifecycle | undefined)[] = [
      undefined,
      block,
      { ...block, take_assigned_tickets: false },
      { ...block, take_assigned_tickets: true },
      { ...block, claim: false },
    ];
    const assignees = [
      { name: 'nobody', assignee: null, linkedMember: false },
      { name: 'the binding’s own account', assignee: SELF, linkedMember: false },
      { name: 'a linked member', assignee: MEMBER, linkedMember: true },
      { name: 'an unlinked person', assignee: PERSON, linkedMember: false },
      { name: 'a linked non-member', assignee: identity('acct-viewer'), linkedMember: false },
    ] as const;
    for (const lifecycle of lifecycles) {
      const skipsOthers = lifecycleClaims(lifecycle) && lifecycle?.take_assigned_tickets !== true;
      for (const row of assignees) {
        const expected =
          skipsOthers &&
          row.assignee !== null &&
          !row.linkedMember &&
          !sameAccount(SELF, row.assignee);
        expect(
          intakeSkipsAssignedTicket({
            lifecycle,
            self: SELF,
            assignee: row.assignee,
            assigneeIsLinkedMember: row.linkedMember,
          }),
          `${JSON.stringify(lifecycle)} / ${row.name}`,
        ).toBe(expected);
      }
    }
    // The member rows, spelled out: never skipped, whatever the switch says.
    expect(
      intakeSkipsAssignedTicket({
        lifecycle: { ...block, take_assigned_tickets: false },
        self: SELF,
        assignee: MEMBER,
        assigneeIsLinkedMember: true,
      }),
    ).toBe(false);
    expect(
      intakeSkipsAssignedTicket({
        lifecycle: { ...block, take_assigned_tickets: false },
        self: SELF,
        assignee: PERSON,
        ...UNLINKED,
      }),
    ).toBe(true);
  });

  it('compares accounts by provider and id, never by name', () => {
    const lookalike: ExternalIdentity = { ...PERSON, display_name: 'Agentic Bot' };
    expect(sameAccount(SELF, lookalike)).toBe(false);
    expect(sameAccount(SELF, identity('agentic-bot', 'another-tracker'))).toBe(false);
    expect(sameAccount(SELF, { ...SELF, display_name: 'renamed', verified: true })).toBe(true);
  });
});

describe('the claim record', () => {
  it('needs a claim when there is none, when it is stale, and when it was released', () => {
    expect(ticketClaimNeeded(null)).toBe(true);
    expect(ticketClaimNeeded(claim())).toBe(false);
    expect(ticketClaimNeeded(claim({ stale: true }))).toBe(true);
    expect(
      ticketClaimNeeded(
        claim({ released_at: '2026-10-08T10:00:00.000Z', release_cause: 'cancelled' }),
      ),
    ).toBe(true);
  });

  it('property: a claim is held exactly when it is not needed', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.record({
            stale: fc.boolean(),
            released: fc.boolean(),
            status: fc.constantFrom('confirmed' as const, 'shadow' as const),
          }),
          { nil: null },
        ),
        (shape) => {
          const record =
            shape === null
              ? null
              : claim({
                  stale: shape.stale,
                  status: shape.status,
                  ...(shape.released
                    ? { released_at: '2026-10-08T10:00:00.000Z', release_cause: 'rework' as const }
                    : {}),
                });
          expect(ticketClaimHeld(record)).toBe(!ticketClaimNeeded(record));
        },
      ),
    );
  });

  /**
   * WP-178 criterion (17) (ii), PROGRESS backlog 543: a claim stale because its task stopped between
   * the assign and the record was never held by a running task, so the next claim is a first one
   * whether or not the `stopped` release ran. Only a human return's stale claim takes the ticket back.
   */
  it('(17) treats no claim, a released claim and a claim stale because its task stopped as a first claim', () => {
    expect(ticketClaimIsFirst(null)).toBe(true);
    expect(
      ticketClaimIsFirst(
        claim({ released_at: '2026-10-08T10:00:00.000Z', release_cause: 'rework' }),
      ),
    ).toBe(true);
    expect(ticketClaimIsFirst(claim({ stale: true, stale_cause: 'stopped' }))).toBe(true);
    // A re-claim: a human return's stale claim, and one written before the cause existed.
    expect(ticketClaimIsFirst(claim({ stale: true, stale_cause: 'human_return' }))).toBe(false);
    expect(ticketClaimIsFirst(claim({ stale: true }))).toBe(false);
    expect(ticketClaimIsFirst(claim({ stale: true, stale_cause: 'rework' }))).toBe(false);
    // A held claim is no claim at all to make.
    expect(ticketClaimIsFirst(claim())).toBe(false);
  });

  it('reads the re-read back: held only when the binding’s own account holds the ticket', () => {
    expect(claimReadback(SELF, SELF)).toEqual({ kind: 'held' });
    expect(claimReadback(SELF, PERSON)).toEqual({ kind: 'elsewhere', assignee: PERSON });
    expect(claimReadback(SELF, null)).toEqual({ kind: 'elsewhere', assignee: null });
  });

  it('opens the refusal comment with a marker the platform recognises as its own', () => {
    const marker = claimRefusedCommentMarker('task-1');
    expect(marker).toBe('agentic:claim-refused:task-1');
    expect(PLATFORM_COMMENT_MARKERS.some((prefix) => marker.startsWith(prefix))).toBe(true);
  });
});

/**
 * S-26.2 (TD-031's 2026-11-06 amendment item 5): what every claim does with the assignee it read
 * before it writes — criteria 2 and 3 at the domain tier.
 */
describe('claimPreReadDecision (S-26.2)', () => {
  const ask = (
    holder: ExternalIdentity | null,
    overrides: Partial<{
      holderIsLinkedMember: boolean;
      platformOwner: boolean;
      first: boolean;
      shadow: boolean;
      takeAssignedTickets: boolean;
    }> = {},
  ) =>
    claimPreReadDecision({
      self: SELF,
      holder,
      holderIsLinkedMember: false,
      platformOwner: false,
      first: true,
      shadow: false,
      takeAssignedTickets: false,
      ...overrides,
    });

  it('(2) keeps a linked member’s ticket on every claim: first, re-claim, shadow, opted in', () => {
    for (const first of [true, false]) {
      for (const shadow of [true, false]) {
        for (const takeAssignedTickets of [true, false]) {
          for (const platformOwner of [true, false]) {
            expect(
              ask(MEMBER, {
                holderIsLinkedMember: true,
                platformOwner,
                first,
                shadow,
                takeAssignedTickets,
              }),
              JSON.stringify({ platformOwner, first, shadow, takeAssignedTickets }),
            ).toEqual({ kind: 'keep', heldBy: 'member' });
          }
        }
      }
    }
  });

  it('(3) refuses a first claim of a person who is not a linked member, and re-assigns only them when opted in', () => {
    expect(ask(PERSON)).toEqual({ kind: 'refuse', assignee: PERSON });
    expect(ask(PERSON, { takeAssignedTickets: true })).toEqual({ kind: 'assign' });
    // A re-claim after a human return takes the ticket back from them, as before S-26.2.
    expect(ask(PERSON, { first: false })).toEqual({ kind: 'assign' });
    // A shadow claim writes nothing anyway, and never refuses.
    expect(ask(PERSON, { shadow: true })).toEqual({ kind: 'assign' });
  });

  it('assigns an unassigned ticket and one the binding’s own account holds', () => {
    expect(ask(null)).toEqual({ kind: 'assign' });
    expect(ask(null, { first: false })).toEqual({ kind: 'assign' });
    expect(ask(SELF)).toEqual({ kind: 'assign' });
  });

  /**
   * TD-031's amendment item 5 as amended for a take: a maintainer's *Take it* or *Assign…* on a task
   * whose ticket an unlinked person holds (AUT-6676) — the hand-back's claim neither refuses again
   * nor writes the binding's account over that person.
   */
  it('keeps a ticket somebody else holds when the task has a platform owner: first, re-claim, shadow, opted in', () => {
    for (const first of [true, false]) {
      for (const shadow of [true, false]) {
        for (const takeAssignedTickets of [true, false]) {
          const facts = { platformOwner: true, first, shadow, takeAssignedTickets };
          expect(ask(PERSON, facts), JSON.stringify(facts)).toEqual({
            kind: 'keep',
            heldBy: 'platform_owner',
          });
          // Canary: the same claim with no platform owner refuses or assigns, never keeps.
          expect(ask(PERSON, { ...facts, platformOwner: false }).kind).not.toBe('keep');
        }
      }
    }
  });

  it('a platform owner still assigns over nobody and over the binding’s own account', () => {
    for (const first of [true, false]) {
      expect(ask(null, { platformOwner: true, first })).toEqual({ kind: 'assign' });
      expect(ask(SELF, { platformOwner: true, first })).toEqual({ kind: 'assign' });
    }
  });

  it('the AUT-6676 matrix: an unlinked holder, by platform owner and by first or re-claim', () => {
    const cases = [
      { platformOwner: false, first: true, kind: 'refuse' },
      { platformOwner: false, first: false, kind: 'assign' },
      { platformOwner: true, first: true, kind: 'keep' },
      { platformOwner: true, first: false, kind: 'keep' },
    ] as const;
    for (const { platformOwner, first, kind } of cases) {
      expect(
        ask(PERSON, { platformOwner, first }).kind,
        JSON.stringify({ platformOwner, first }),
      ).toBe(kind);
    }
  });

  it('property: a linked member, or somebody else on a platform-owned task, is kept — nothing else is', () => {
    const holder = fc.constantFrom<ExternalIdentity | null>(null, SELF, PERSON, MEMBER);
    fc.assert(
      fc.property(
        holder,
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        fc.boolean(),
        (who, linked, platformOwner, first, shadow, takeAssignedTickets) => {
          const decision = ask(who, {
            holderIsLinkedMember: linked,
            platformOwner,
            first,
            shadow,
            takeAssignedTickets,
          });
          const elsewhere = who !== null && who !== SELF;
          expect(decision.kind === 'keep').toBe(
            who !== null && (linked || (elsewhere && platformOwner)),
          );
          if (decision.kind === 'keep') {
            expect(decision.heldBy).toBe(linked ? 'member' : 'platform_owner');
          }
          if (decision.kind === 'refuse') {
            expect(first && !shadow && !takeAssignedTickets && !linked && !platformOwner).toBe(
              true,
            );
          }
        },
      ),
    );
  });
});
