/**
 * The Approval aggregate — technical/02: `pending → approved | rejected | expired` — `expired` for
 * history, and for a cancelled task's withdrawn approval.
 *
 * **An approval waits until a person decides it** (BD-006's 2026-11-07 amendment, S-27.1): nothing
 * expires one. `expired` stays in the status and in the transition table because rows and
 * `task.approval.decided` events an earlier build wrote carry it, and a replay must still read them;
 * no function here produces it any more — the expiry command was deleted with the amendment, as the
 * Q95 amendment asked of a reversal.
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
  TaskState,
  UserRole,
} from '@platform/contracts';
import {
  ApprovalPendingError,
  IllegalTransitionError,
  InvariantViolationError,
} from '../errors.js';
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
  /**
   * **History, never an expiry** (BD-006's 2026-11-07 amendment, item 3). An approval requested
   * from S-27.1 on has none; one requested by an earlier build keeps the deadline it was written
   * with, which nothing reads as a time it expires at, and the API publishes `null` for every row.
   */
  readonly deadlineAt: IsoDateTime | null;
  readonly decidedByUserId: Id | null;
  readonly decidedAt: IsoDateTime | null;
  readonly reason: string | null;
  /**
   * How many reminders the platform raised (WP-84, migration 0059): at most
   * `APPROVAL_REMINDER_LIMIT`, the next one's ordinal being this plus one (BD-006's 2026-11-07
   * amendment, item 2). Not on {@link ApprovalRecord}: no event and no DTO carries it, and the row
   * is its only reader.
   */
  readonly remindersSent: number;
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
}

/**
 * Creates the approval. The task emits `task.approval.requested` carrying its record.
 *
 * **With no deadline** (BD-006's 2026-11-07 amendment): the input has no deadline rule to pass, so
 * no gate can give an approval one by accident.
 */
export const createApproval = (input: RequestApprovalInput, context: CommandContext): Approval => {
  const requestedAt = context.clock.now();
  return {
    id: input.id,
    taskId: input.taskId,
    projectId: input.projectId,
    kind: input.kind,
    status: 'pending',
    requestedAt,
    deadlineAt: null,
    decidedByUserId: null,
    decidedAt: null,
    reason: null,
    remindersSent: 0,
    sequence: FIRST_STREAM_SEQ,
  };
};

/**
 * How many reminders a waiting approval gets — BD-006's 2026-11-07 amendment, item 2: *"at most
 * five"*. With the default question timeout that is half a working day after the request and then
 * once a working day, about a working week in all; after the fifth, chat is quiet and the approval
 * stays a *Needs you* item.
 */
export const APPROVAL_REMINDER_LIMIT = 5;

/**
 * A reminder went out (WP-84). Like the question's, it changes no state worth replaying and emits
 * no event (technical/02); the counter is on the row. Only a pending approval is reminded about,
 * and never past {@link APPROVAL_REMINDER_LIMIT}.
 */
export const recordApprovalReminder = (approval: Approval): Approval => {
  if (approval.status !== 'pending') {
    throw new InvariantViolationError(
      'approval.reminder',
      `only a pending approval is reminded about, this one is "${approval.status}"`,
    );
  }
  if (approval.remindersSent >= APPROVAL_REMINDER_LIMIT) {
    throw new InvariantViolationError(
      'approval.reminder',
      `an approval is reminded about at most ${APPROVAL_REMINDER_LIMIT} times, and this one was reminded ${approval.remindersSent}`,
    );
  }
  return { ...approval, remindersSent: approval.remindersSent + 1 };
};

/** Why a withdrawn approval ended, as its row and its `task.approval.decided` record it. */
export const APPROVAL_WITHDRAWN_REASON = 'the task was cancelled';

/**
 * **A cancelled task's pending approval is withdrawn** (S-27.1, the review of #113): it can no longer
 * be decided, so it leaves the Inbox, and its chat message loses its buttons. Since an approval
 * never expires (BD-006's 2026-11-07 amendment) one left `pending` would stay there for ever.
 *
 * Recorded as **`expired`** with no decider and the reason {@link APPROVAL_WITHDRAWN_REASON}, not as
 * a status of its own: `approval_status` is a database enum, a new value is a migration this slice
 * does not need, and `expired` already means *ended without a decision* to every reader — the saga
 * (which ignores it on a finished task), the settled-message edit and the task page. The reason is
 * what tells it from an earlier build's expiry. Nobody's permission is asked: the canceller decided
 * the task, not the approval.
 */
export const withdrawApproval = (approval: Approval, context: CommandContext): ApprovalDecision => {
  assertApprovalTransition(approval.status, 'expired');
  const recorder = recorderFor(approval, context);
  const decidedAt = recorder.occurredAt;
  recorder.emit('task.approval.decided', {
    project_id: approval.projectId,
    task_id: approval.taskId,
    approval_id: approval.id,
    decision: 'expired',
    decided_by_user_id: null,
    reason: APPROVAL_WITHDRAWN_REASON,
  });
  return {
    aggregate: {
      ...approval,
      status: 'expired',
      decidedAt,
      reason: APPROVAL_WITHDRAWN_REASON,
      sequence: recorder.sequence,
    },
    events: recorder.events,
  };
};

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

/**
 * **A human command never moves a task past a pending approval** (BD-006's 2026-11-07 amendment,
 * S-27.1, closing BACKLOG 854 and 1480). `task.resume` is a `member` action and
 * `RESUMABLE_TASK_STATES` admits `waiting_approval`, so before this a member's resume entered the
 * stage and skipped a decision only a maintainer may take; a pause, a take-over and a hand-back —
 * or a take-over left to time out into `needs_human` — went round it the same way. So **every**
 * human entry into a stage asks this first, **in any state** (`humanEnter`,
 * `packages/application/src/pipeline/commands.ts`): resume, retry-stage, retry-run and hand-back.
 * The one way on that is not an entry is the resume **back into the wait**
 * (`resumeIntoApprovalWait`), which the resume command takes instead of entering the stage.
 *
 * The refusal is the same for **every role**, so it takes none: a maintainer decides through the
 * approval, which records the decision and its subject (TD-035), rather than around it. A task
 * with **no** pending approval — its approval decided, and the saga's move lost — still enters:
 * that is the rescue `RESUMABLE_TASK_STATES` keeps `waiting_approval` for.
 *
 * @throws {ApprovalPendingError} naming the approval.
 */
export const assertNoPendingApproval = (
  task: { readonly state: TaskState },
  pending: Pick<Approval, 'id' | 'kind' | 'status'> | null,
  entry: { readonly stage: string; readonly move: string },
): void => {
  if (pending === null || pending.status !== 'pending') {
    return;
  }
  throw new ApprovalPendingError({
    approvalId: pending.id,
    approvalKind: pending.kind,
    stage: entry.stage,
    move: entry.move,
    from: task.state,
  });
};
