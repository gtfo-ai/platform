/**
 * The status policy's pure rules — M28 rulings 1–3 (S-28.4).
 *
 * Every status name here is an invented fixture value except the dogfood workflow's, which the
 * brief quotes (AUT's To Do / In Progress / Done categories) and which is the case that motivated
 * the rule: a labelled ticket released three weeks earlier became a task again.
 */
import type { TicketStatusCategory } from '@platform/contracts';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { lifecycleClaims } from './claim.js';
import {
  claimStatusDecision,
  DEFAULT_TICKET_STATUS_POLICY,
  intakeStatusDecision,
  ticketStatusDisposition,
  ticketStatusPolicyOf,
  ticketStatusStopDecision,
  withStatusMappingStatuses,
} from './status-disposition.js';

const DEFAULTS = DEFAULT_TICKET_STATUS_POLICY;

describe('ticketStatusDisposition with the category defaults (M28 ruling 2)', () => {
  it.each<[string, TicketStatusCategory | null, string]>([
    ['To Do', 'todo', 'startable'],
    ['Idea', 'todo', 'startable'],
    ['Released', 'done', 'closed'],
    ['Canceled', 'done', 'closed'],
    ['Ready for Merge', 'in_progress', 'hands_off'],
    ['QA Request Changes', 'in_progress', 'hands_off'],
    ['Somewhere', 'unknown', 'not_ready'],
    ['Unreported', null, 'not_ready'],
  ])('%s (%s) is %s for a ticket the platform does not hold', (status, category, expected) => {
    expect(ticketStatusDisposition(status, category, DEFAULTS, false)).toBe(expected);
  });

  it('never calls a status of an unknown category startable', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 20 }), fc.boolean(), (status, holds) => {
        expect(ticketStatusDisposition(status, 'unknown', DEFAULTS, holds)).not.toBe('startable');
      }),
    );
  });
});

describe('ticketStatusDisposition with explicit lists', () => {
  const policy = ticketStatusPolicyOf(null, {
    start_from: ['To Do', 'Ready'],
    closed: ['Released', 'Done'],
  });

  it('starts only from the listed statuses, compared case-insensitively', () => {
    expect(ticketStatusDisposition('ready ', 'todo', policy, false)).toBe('startable');
    expect(ticketStatusDisposition('Idea', 'todo', policy, false)).toBe('not_ready');
    // A list decides without a category: a provider that reports none is still judged.
    expect(ticketStatusDisposition('To Do', null, policy, false)).toBe('startable');
  });

  it('closes only on the listed statuses — Ready to Release is not closed when the list omits it', () => {
    expect(ticketStatusDisposition('Released', null, policy, false)).toBe('closed');
    expect(ticketStatusDisposition('Ready to Release', 'done', policy, false)).toBe('not_ready');
  });

  it('always starts from pickup_status, whatever its category', () => {
    const withPickup = ticketStatusPolicyOf('For the agent', { start_from: ['To Do'] });
    expect(ticketStatusDisposition('for the agent', 'in_progress', withPickup, false)).toBe(
      'startable',
    );
    expect(
      ticketStatusDisposition(
        'For the agent',
        'in_progress',
        ticketStatusPolicyOf('For the agent', null),
        false,
      ),
    ).toBe('startable');
  });
});

describe('the platform’s own statuses (M28 ruling 4’s exemption, decided here)', () => {
  const policy = ticketStatusPolicyOf('To pick up', {
    in_progress: 'Doing',
    in_review: 'With reviewers',
    done: 'Finished',
    returned: ['Sent back'],
  });

  it('are never hands-off or closed for a ticket the platform holds', () => {
    expect(ticketStatusDisposition('Doing', 'in_progress', policy, true)).toBe('not_ready');
    expect(ticketStatusDisposition('Sent back', 'in_progress', policy, true)).toBe('not_ready');
    // The platform's own `done` write is not a person closing the ticket.
    expect(ticketStatusDisposition('Finished', 'done', policy, true)).toBe('not_ready');
  });

  it('are what they are for a ticket the platform does not hold', () => {
    expect(ticketStatusDisposition('Doing', 'in_progress', policy, false)).toBe('hands_off');
    expect(ticketStatusDisposition('Finished', 'done', policy, false)).toBe('closed');
  });

  it('do not shield a status outside the slots', () => {
    expect(ticketStatusDisposition('Elsewhere', 'in_progress', policy, true)).toBe('hands_off');
    expect(ticketStatusDisposition('Released', 'done', policy, true)).toBe('closed');
  });
});

describe('intakeStatusDecision (M28 ruling 3 (c))', () => {
  it('takes a To Do ticket and skips a released one with the label still on', () => {
    expect(intakeStatusDecision('To Do', 'todo', DEFAULTS)).toEqual({ kind: 'take' });
    expect(intakeStatusDecision('Released', 'done', DEFAULTS)).toEqual({
      kind: 'skip',
      disposition: 'closed',
    });
    expect(intakeStatusDecision('Ready for Merge', 'in_progress', DEFAULTS)).toEqual({
      kind: 'skip',
      disposition: 'hands_off',
    });
    expect(intakeStatusDecision('Somewhere', 'unknown', DEFAULTS)).toEqual({
      kind: 'skip',
      disposition: 'not_ready',
    });
  });

  it('fails open on a category the provider did not report, unless a list decides', () => {
    expect(intakeStatusDecision('Anything', null, DEFAULTS)).toEqual({ kind: 'take' });
    const lists = ticketStatusPolicyOf(null, { start_from: ['To Do'], closed: ['Released'] });
    expect(intakeStatusDecision('Released', null, lists).kind).toBe('skip');
    expect(intakeStatusDecision('Anything', null, lists).kind).toBe('skip');
    const closedOnly = ticketStatusPolicyOf(null, { closed: ['Released'] });
    expect(intakeStatusDecision('Released', null, closedOnly).kind).toBe('skip');
    expect(intakeStatusDecision('Anything', null, closedOnly).kind).toBe('take');
  });

  it('does not exempt the platform’s own statuses: intake holds no ticket', () => {
    const policy = ticketStatusPolicyOf(null, { in_progress: 'Doing' });
    expect(intakeStatusDecision('Doing', 'in_progress', policy).kind).toBe('skip');
  });
});

describe('claimStatusDecision (M28 ruling 3 (d))', () => {
  const policy = ticketStatusPolicyOf(null, { in_progress: 'Doing', returned: ['Sent back'] });

  it('refuses a closed ticket on every claim, unless the binding ignores closed tickets', () => {
    for (const first of [true, false]) {
      expect(claimStatusDecision({ status: 'Released', category: 'done', policy, first })).toEqual({
        kind: 'refuse',
        reason: 'ticket_closed_in_tracker',
      });
    }
    const ignoring = ticketStatusPolicyOf(null, { on_ticket_closed: 'ignore' });
    expect(
      claimStatusDecision({ status: 'Released', category: 'done', policy: ignoring, first: true }),
    ).toEqual({ kind: 'proceed' });
  });

  it('refuses a first claim of a ticket a person took or put back to wait', () => {
    expect(
      claimStatusDecision({ status: 'Review', category: 'in_progress', policy, first: true }),
    ).toEqual({ kind: 'refuse', reason: 'ticket_not_startable' });
    const lists = ticketStatusPolicyOf(null, { start_from: ['Ready'] });
    expect(
      claimStatusDecision({ status: 'Idea', category: 'todo', policy: lists, first: true }),
    ).toEqual({ kind: 'refuse', reason: 'ticket_not_startable' });
  });

  it('lets a first claim meet the platform’s own in_progress move, and a re-claim any open status', () => {
    expect(
      claimStatusDecision({ status: 'Doing', category: 'in_progress', policy, first: true }),
    ).toEqual({ kind: 'proceed' });
    expect(
      claimStatusDecision({ status: 'Review', category: 'in_progress', policy, first: false }),
    ).toEqual({ kind: 'proceed' });
    expect(claimStatusDecision({ status: 'To Do', category: 'todo', policy, first: true })).toEqual(
      { kind: 'proceed' },
    );
    expect(
      claimStatusDecision({ status: 'Anything', category: null, policy, first: true }),
    ).toEqual({ kind: 'proceed' });
  });
});

describe('lifecycleClaims and the status policy keys (M28 ruling 1)', () => {
  it('does not claim for a block that holds only the status policy', () => {
    expect(lifecycleClaims({ start_from: ['To Do'] })).toBe(false);
    expect(lifecycleClaims({ closed: ['Done'], on_ticket_closed: 'ignore' })).toBe(false);
  });

  it('claims as before for an empty block, a slot, or an explicit claim beside the policy', () => {
    expect(lifecycleClaims({})).toBe(true);
    expect(lifecycleClaims({ start_from: ['To Do'], in_progress: 'Doing' })).toBe(true);
    expect(lifecycleClaims({ start_from: ['To Do'], claim: true })).toBe(true);
    expect(lifecycleClaims({ start_from: ['To Do'], claim: false, in_progress: 'Doing' })).toBe(
      false,
    );
  });
});

describe('the S-28.4 review rulings', () => {
  it('a claim a person commanded is never refused, closed or not (ruling (a))', () => {
    for (const [status, category] of [
      ['Released', 'done'],
      ['Review', 'in_progress'],
    ] as const) {
      expect(
        claimStatusDecision({
          status,
          category,
          policy: DEFAULTS,
          first: true,
          humanCommanded: true,
        }),
      ).toEqual({ kind: 'proceed' });
    }
  });

  it('counts status_mapping targets as the platform’s own only when no slot is mapped (finding 1)', () => {
    const unslotted = withStatusMappingStatuses(
      ticketStatusPolicyOf(null, { assign_owner: true }),
      { assign_owner: true },
      { implementation: 'In Progress', merged: 'Shipped' },
    );
    expect(
      claimStatusDecision({
        status: 'In Progress',
        category: 'in_progress',
        policy: unslotted,
        first: true,
      }),
    ).toEqual({ kind: 'proceed' });
    // A Done-category mapping target does not read as a person closing the ticket.
    expect(ticketStatusDisposition('Shipped', 'done', unslotted, true)).toBe('not_ready');
    const slotted = { in_progress: 'Doing' };
    expect(
      withStatusMappingStatuses(ticketStatusPolicyOf(null, slotted), slotted, {
        implementation: 'In Progress',
      }).platformStatuses,
    ).toEqual(['Doing']);
  });
});

describe('ticketStatusStopDecision — the reverse sync (M28 ruling 4, S-28.5)', () => {
  const stop = (over: Partial<Parameters<typeof ticketStatusStopDecision>[0]>) =>
    ticketStatusStopDecision({
      state: 'active',
      humanStage: false,
      disposition: 'closed',
      onTicketClosed: 'stop',
      mayAmend: true,
      ...over,
    });

  it('cancels a queued task, escalates a working one, amends another stop', () => {
    expect(stop({ state: 'queued' })).toEqual({
      kind: 'cancel',
      reason: 'ticket_closed_in_tracker',
    });
    for (const state of ['active', 'returned', 'waiting_answers', 'waiting_approval', 'paused']) {
      expect(stop({ state })).toEqual({ kind: 'escalate', reason: 'ticket_closed_in_tracker' });
    }
    expect(stop({ state: 'needs_human' })).toEqual({
      kind: 'amend',
      reason: 'ticket_closed_in_tracker',
    });
    // A polled edit of a ticket that stays closed does not amend it again.
    expect(stop({ state: 'needs_human', mayAmend: false })).toEqual({ kind: 'none' });
  });

  it('a person taking the ticket cancels a queued task and escalates a working one, never amends', () => {
    expect(stop({ state: 'queued', disposition: 'hands_off' })).toEqual({
      kind: 'cancel',
      reason: 'ticket_taken_by_person',
    });
    expect(stop({ disposition: 'hands_off' })).toEqual({
      kind: 'escalate',
      reason: 'ticket_taken_by_person',
    });
    expect(stop({ state: 'needs_human', disposition: 'hands_off' })).toEqual({ kind: 'none' });
  });

  it('never stops a finished or merged task, a human stage, a startable or waiting status, or when told to ignore', () => {
    for (const state of ['done', 'cancelled', 'merged', 'retro']) {
      expect(stop({ state })).toEqual({ kind: 'none' });
    }
    expect(stop({ state: 'ready_for_merge', humanStage: true })).toEqual({ kind: 'none' });
    expect(stop({ disposition: 'startable' })).toEqual({ kind: 'none' });
    expect(stop({ disposition: 'not_ready' })).toEqual({ kind: 'none' });
    expect(stop({ onTicketClosed: 'ignore' })).toEqual({ kind: 'none' });
  });

  it('never stops a task for a status the platform wrote — a slot, or a status_mapping target, Done included', () => {
    const slotted = ticketStatusPolicyOf(null, { in_progress: 'Doing', done: 'Ready for Merge' });
    expect(ticketStatusDisposition('Ready for Merge', 'done', slotted, true)).toBe('not_ready');
    const mapped = withStatusMappingStatuses(
      ticketStatusPolicyOf(null, {}),
      {},
      {
        implementation: 'In Progress',
        done: 'Released',
      },
    );
    expect(ticketStatusDisposition('Released', 'done', mapped, true)).toBe('not_ready');
    expect(ticketStatusDisposition('In Progress', 'in_progress', mapped, true)).toBe('not_ready');
  });
});
