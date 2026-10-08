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
    expect(intakeSkipsAssignedTicket({ lifecycle: block, self: SELF, assignee: PERSON })).toBe(
      true,
    );
  });

  it('takes an unassigned ticket, and one assigned to the binding’s own account', () => {
    expect(intakeSkipsAssignedTicket({ lifecycle: block, self: SELF, assignee: null })).toBe(false);
    expect(intakeSkipsAssignedTicket({ lifecycle: block, self: SELF, assignee: SELF })).toBe(false);
  });

  it('takes an assigned ticket when the project opts in, and on a binding that does not claim', () => {
    expect(
      intakeSkipsAssignedTicket({
        lifecycle: { ...block, take_assigned_tickets: true },
        self: SELF,
        assignee: PERSON,
      }),
    ).toBe(false);
    expect(intakeSkipsAssignedTicket({ lifecycle: undefined, self: SELF, assignee: PERSON })).toBe(
      false,
    );
    expect(
      intakeSkipsAssignedTicket({
        lifecycle: { ...block, claim: false },
        self: SELF,
        assignee: PERSON,
      }),
    ).toBe(false);
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
