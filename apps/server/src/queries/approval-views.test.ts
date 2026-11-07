/**
 * The decision half of the approval read (S-25.1, TD-035 decisions 4 and 5): recorded, derived by
 * the one exact chain, or *not recorded* — never "the task's latest plan". The SQL that feeds it,
 * and its agreement with the decide command's store read, is
 * `test/integration/server/approval-subject.integration.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { type ApprovalRow, assembleApprovalViews } from './approval-views.js';

const TASK = '00000000-0000-4000-8000-0000000000a1';
const PLAN_1 = '00000000-0000-4000-8000-0000000000d1';
const PLAN_2 = '00000000-0000-4000-8000-0000000000d2';
const AT = new Date('2026-11-06T09:00:00.000Z');

const row = (over: Partial<ApprovalRow> = {}): ApprovalRow => ({
  id: '00000000-0000-4000-8000-0000000000c1',
  taskId: TASK,
  kind: 'plan',
  status: 'pending',
  requestedAt: AT,
  deadlineAt: null,
  remindersSent: 0,
  decidedByUserId: null,
  decidedAt: null,
  reason: null,
  stage: 'architecture',
  attempt: 1,
  subjectArtifactId: null,
  subjectDetail: null,
  reasons: null,
  ...over,
});

const chained = (id: string, version: number, attempt = 1) => ({
  id,
  version,
  taskId: TASK,
  stage: 'architecture',
  attempt,
});

describe('assembleApprovalViews', () => {
  it('publishes every approval’s deadline_at as null, a stored one included (S-27.1)', () => {
    const views = assembleApprovalViews(
      [
        row(),
        // An earlier build's row: its stored deadline is history, never a due time on the wire.
        row({
          id: '00000000-0000-4000-8000-0000000000c2',
          deadlineAt: new Date('2026-11-07T09:00:00.000Z'),
        }),
        row({
          id: '00000000-0000-4000-8000-0000000000c3',
          kind: 'budget',
          status: 'expired',
          deadlineAt: new Date('2026-11-07T09:00:00.000Z'),
        }),
      ],
      [],
      [],
    );
    expect(views.map((view) => view.deadline_at)).toEqual([null, null, null]);
    // The other instants are still read off the row.
    expect(views[1]?.requested_at).toBe('2026-11-06T09:00:00.000Z');
  });

  it('publishes a recorded plan with the version read through its id, and the stored reasons', () => {
    const reasons = [{ code: 'probation', completed: 1, of: 5 }];
    const [view] = assembleApprovalViews(
      [row({ subjectArtifactId: PLAN_2, reasons })],
      [{ id: PLAN_2, version: 2 }],
      [],
    );
    expect(view).toMatchObject({
      requested_at: '2026-11-06T09:00:00.000Z',
      subject: {
        kind: 'plan',
        artifact_id: PLAN_2,
        artifact_version: 2,
        stage: 'architecture',
        attempt: 1,
        basis: 'recorded',
      },
      reasons,
    });
  });

  it('derives an old row’s plan only from exactly one plan at its own stage attempt', () => {
    const [one] = assembleApprovalViews([row()], [], [chained(PLAN_1, 1)]);
    expect(one?.subject).toMatchObject({ artifact_id: PLAN_1, basis: 'derived' });
    // Reasons are never derived (the policy may have changed since).
    expect(one?.reasons).toBeNull();

    const [two] = assembleApprovalViews([row()], [], [chained(PLAN_1, 1), chained(PLAN_2, 2)]);
    expect(two?.subject).toBeNull();
    // A plan from another attempt is not this approval's subject.
    const [other] = assembleApprovalViews([row()], [], [chained(PLAN_2, 2, 2)]);
    expect(other?.subject).toBeNull();
  });

  it('reads not recorded for an old row nothing pins, and for a recorded id the read did not find', () => {
    expect(assembleApprovalViews([row()], [], [])[0]?.subject).toBeNull();
    expect(
      assembleApprovalViews([row({ subjectArtifactId: PLAN_1 })], [], [chained(PLAN_1, 1)])[0]
        ?.subject,
    ).toBeNull();
    expect(
      assembleApprovalViews([row({ stage: null, attempt: null })], [], [])[0]?.subject,
    ).toBeNull();
  });

  it('publishes a budget approval’s figures, and nothing for one that recorded none', () => {
    const detail = {
      estimate_usd: 61.5,
      threshold_usd: 50,
      estimate_basis: 'project_history',
      estimate_samples: 7,
    };
    const [recorded, old] = assembleApprovalViews(
      [row({ kind: 'budget', subjectDetail: detail }), row({ kind: 'budget' })],
      [],
      [],
    );
    expect(recorded?.subject).toEqual({ kind: 'budget', ...detail });
    expect(old?.subject).toBeNull();
  });

  it('refuses stored reasons or figures outside the vocabulary rather than defaulting them', () => {
    expect(() =>
      assembleApprovalViews([row({ reasons: [{ code: 'because' }] })], [], []),
    ).toThrow();
    expect(() =>
      assembleApprovalViews([row({ kind: 'budget', subjectDetail: { estimate_usd: -1 } })], [], []),
    ).toThrow();
  });
});
