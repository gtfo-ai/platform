/**
 * The automatic cancellation's words (M28 ruling 4b, TD-029 Amendment E.3, S-28.14): the ticket's
 * key, its status, who moved it when the delivery named them, and the merge request — open, not
 * open, or not read — never claimed open when it was read closed.
 */
import { describe, expect, it } from 'vitest';
import { ticketMovedCancelOutcome } from './task-cancel.js';

const MR = {
  provider: 'gitlab',
  iid: 12,
  url: 'https://git.example.test/acme/api/-/merge_requests/12',
};
const base = {
  key: 'AUT-123',
  provider: 'jira-cloud',
  status: 'Released',
  reason: 'ticket_closed_in_tracker' as const,
};

describe('ticketMovedCancelOutcome', () => {
  it('says where the ticket is when no move is known (the sweep, the claim)', () => {
    expect(ticketMovedCancelOutcome({ ...base, mergeRequest: null })).toBe(
      'Cancelled automatically: AUT-123 is "Released" in Jira, a status that means it is finished.',
    );
  });

  it('names who moved the ticket and when, as the stop’s brief does (Amendment E.3)', () => {
    expect(
      ticketMovedCancelOutcome({
        ...base,
        movedBy: 'Vojtěch Kaizr',
        movedAt: '2026-11-04T10:00:00.000Z',
        mergeRequest: null,
      }),
    ).toBe(
      'Cancelled automatically: AUT-123 was moved to "Released" in Jira by Vojtěch Kaizr on 2026-11-04, a status that means it is finished.',
    );
  });

  it('says an open merge request is still open, a closed one is not, and an unread one is not claimed', () => {
    expect(ticketMovedCancelOutcome({ ...base, mergeRequest: { ref: MR, open: true } })).toContain(
      'Its merge request !12 is still open — close or merge it yourself: https://git.example.test/acme/api/-/merge_requests/12',
    );
    const closed = ticketMovedCancelOutcome({ ...base, mergeRequest: { ref: MR, open: false } });
    expect(closed).toContain('Its merge request !12 is not open; it was left as it is.');
    expect(closed).not.toContain('still open');
    expect(ticketMovedCancelOutcome({ ...base, mergeRequest: { ref: MR, open: null } })).toContain(
      'if it is still open, close or merge it yourself',
    );
  });
});
