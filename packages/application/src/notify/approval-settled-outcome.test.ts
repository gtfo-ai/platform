/**
 * S-28.16 review: an approval the platform decided names no person, so the edited chat message must
 * not say *"Approved by a maintainer"*. A budget approval settled as no longer required says so.
 */
import type { Id, IsoDateTime } from '@platform/contracts';
import { APPROVAL_WITHDRAWN_REASON } from '@platform/domain';
import { describe, expect, it } from 'vitest';
import type { StoredApproval } from '../pipeline/store.js';
import { settledOutcomeOf } from './approval-settled.js';
import { settledApprovalBody } from './render.js';

const stored = (over: {
  readonly kind?: 'plan' | 'budget';
  readonly status?: 'approved' | 'rejected' | 'expired';
  readonly reason?: string | null;
  readonly autoDecided?: boolean;
}): StoredApproval => ({
  approval: {
    id: '00000000-0000-4000-8000-0000000017a1' as Id,
    taskId: '00000000-0000-4000-8000-0000000017a2' as Id,
    projectId: '00000000-0000-4000-8000-0000000017a3' as Id,
    kind: over.kind ?? 'budget',
    status: over.status ?? 'approved',
    requestedAt: '2026-11-10T09:00:00.000Z' as IsoDateTime,
    deadlineAt: null,
    decidedByUserId: null,
    decidedAt: '2026-11-10T09:05:00.000Z' as IsoDateTime,
    reason: over.reason ?? null,
    remindersSent: 0,
    sequence: 2,
  },
  stage: null,
  attempt: null,
  autoDecided: over.autoDecided ?? false,
});

describe('what the settled approval message says happened', () => {
  it('says a budget approval the platform settled was no longer required — never a maintainer', () => {
    const outcome = settledOutcomeOf(stored({ autoDecided: true }), 'approved');
    expect(outcome).toBe('not_required');
    const markdown = settledApprovalBody({
      subject: { name: 'AUT-1', url: null },
      outcome,
      decider: null,
    }).markdown;
    expect(markdown).toContain('No longer required: the estimate rested on too few finished tasks');
    expect(markdown).toContain('within its cap');
    expect(markdown).not.toContain('maintainer');
  });

  it('keeps a person’s approval, a withdrawal and a plan the rule let through apart', () => {
    expect(settledOutcomeOf(stored({}), 'approved')).toBe('approved');
    expect(settledOutcomeOf(stored({ kind: 'plan', autoDecided: true }), 'approved')).toBe(
      'went_ahead',
    );
    expect(
      settledOutcomeOf(stored({ status: 'expired', reason: APPROVAL_WITHDRAWN_REASON }), 'expired'),
    ).toBe('withdrawn');
    expect(settledOutcomeOf(stored({ status: 'rejected' }), 'rejected')).toBe('rejected');
  });
});
