/**
 * The Approval aggregate — technical/02: `pending → approved | rejected | expired`.
 *
 * "Only mapped maintainers decide" (technical/02, BD-006/Q10). That is enforced here through
 * `can()`: the permission depends on the approval's *kind*, so a plan approval needs
 * `task.approve_plan`, a knowledge approval `kb.proposal.decide`, and so on.
 *
 * `task.approval.requested` is the task's event (it moves the task to `waiting_approval`);
 * `task.approval.decided` is emitted here, on the approval's own stream.
 */
import type {
  ApprovalKind,
  ApprovalRecord,
  ApprovalStatus,
  Id,
  IsoDateTime,
  UserRole,
} from '@platform/contracts';
import { isBefore } from '../clock.js';
import { IllegalTransitionError } from '../errors.js';
import { type CommandContext, type Decision, eventRecorder, FIRST_STREAM_SEQ } from '../events.js';
import { APPROVAL_ACTIONS, assertCan } from '../permissions.js';

export const APPROVAL_TRANSITIONS = {
  pending: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
} as const satisfies Record<ApprovalStatus, readonly ApprovalStatus[]>;

export const canTransitionApproval = (from: ApprovalStatus, to: ApprovalStatus): boolean =>
  (APPROVAL_TRANSITIONS[from] as readonly ApprovalStatus[]).includes(to);

export const assertApprovalTransition = (from: ApprovalStatus, to: ApprovalStatus): void => {
  if (!canTransitionApproval(from, to)) {
    throw new IllegalTransitionError('Approval', from, to);
  }
};

export interface Approval {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly kind: ApprovalKind;
  readonly status: ApprovalStatus;
  readonly requestedAt: IsoDateTime;
  readonly deadlineAt: IsoDateTime | null;
  readonly decidedByUserId: Id | null;
  readonly decidedAt: IsoDateTime | null;
  readonly reason: string | null;
  readonly sequence: number;
}

export type ApprovalDecision = Decision<Approval>;

const recorderFor = (approval: Approval, context: CommandContext) =>
  eventRecorder({ streamType: 'approval', streamId: approval.id }, approval.sequence, {
    ...context,
    correlationId: context.correlationId ?? approval.taskId,
  });

export interface RequestApprovalInput {
  readonly id: Id;
  readonly taskId: Id;
  readonly projectId: Id;
  readonly kind: ApprovalKind;
  readonly deadlineAt?: IsoDateTime;
}

/** Creates the approval. The task emits `task.approval.requested` carrying its record. */
export const createApproval = (input: RequestApprovalInput, context: CommandContext): Approval => ({
  id: input.id,
  taskId: input.taskId,
  projectId: input.projectId,
  kind: input.kind,
  status: 'pending',
  requestedAt: context.clock.now(),
  deadlineAt: input.deadlineAt ?? null,
  decidedByUserId: null,
  decidedAt: null,
  reason: null,
  sequence: FIRST_STREAM_SEQ,
});

export const toApprovalRecord = (approval: Approval): ApprovalRecord => ({
  id: approval.id,
  task_id: approval.taskId,
  kind: approval.kind,
  status: approval.status,
  requested_at: approval.requestedAt,
  deadline_at: approval.deadlineAt,
  decided_by_user_id: approval.decidedByUserId,
  decided_at: approval.decidedAt,
  reason: approval.reason,
});

export const isApprovalOverdue = (approval: Approval, now: IsoDateTime): boolean =>
  approval.status === 'pending' &&
  approval.deadlineAt !== null &&
  isBefore(approval.deadlineAt, now);

export interface DecideApprovalInput {
  readonly decision: 'approved' | 'rejected';
  readonly userId: Id;
  readonly role: UserRole;
  readonly reason?: string;
}

/** A mapped maintainer decided. The permission required depends on the approval's kind. */
export const decideApproval = (
  approval: Approval,
  input: DecideApprovalInput,
  context: CommandContext,
): ApprovalDecision => {
  assertApprovalTransition(approval.status, input.decision);
  assertCan(input.role, APPROVAL_ACTIONS[approval.kind], {
    kind: 'approval',
    status: approval.status,
  });
  const recorder = recorderFor(approval, context);
  const decidedAt = recorder.occurredAt;
  recorder.emit('task.approval.decided', {
    project_id: approval.projectId,
    task_id: approval.taskId,
    approval_id: approval.id,
    decision: input.decision,
    decided_by_user_id: input.userId,
    reason: input.reason ?? null,
  });
  return {
    aggregate: {
      ...approval,
      status: input.decision,
      decidedByUserId: input.userId,
      decidedAt,
      reason: input.reason ?? null,
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

/** Nobody decided in time. Recorded with no decider, so the audit shows the timer acted. */
export const expireApproval = (approval: Approval, context: CommandContext): ApprovalDecision => {
  assertApprovalTransition(approval.status, 'expired');
  const recorder = recorderFor(approval, context);
  const decidedAt = recorder.occurredAt;
  recorder.emit('task.approval.decided', {
    project_id: approval.projectId,
    task_id: approval.taskId,
    approval_id: approval.id,
    decision: 'expired',
    decided_by_user_id: null,
    reason: 'deadline passed',
  });
  return {
    aggregate: {
      ...approval,
      status: 'expired',
      decidedAt,
      reason: 'deadline passed',
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};
