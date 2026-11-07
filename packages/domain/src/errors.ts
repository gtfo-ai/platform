/**
 * Typed domain errors.
 *
 * Every rejection in this package is one of these: an illegal state-machine transition, a
 * violated policy, a violated invariant or a missing permission. Nothing is silently ignored —
 * `CLAUDE.md`: "errors are typed, never swallowed" — and nothing throws a bare `Error`, so the
 * application ring can map each class onto an HTTP status and an audit line.
 */

/** Discriminator for exhaustive handling in the rings above. */
export type DomainErrorCode =
  | 'illegal_transition'
  | 'policy_violation'
  | 'invariant_violation'
  | 'permission_denied';

/** Base class for everything this package throws. */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = new.target.name;
  }
}

/**
 * A command asked an aggregate to move somewhere its transition table does not allow.
 * technical/02's state machines are enforced, never approximated: an illegal transition is an
 * error, not a no-op, so a bug in a saga surfaces instead of quietly dropping a state change.
 */
export class IllegalTransitionError extends DomainError {
  readonly aggregate: string;
  readonly from: string;
  readonly to: string;

  constructor(aggregate: string, from: string, to: string) {
    super('illegal_transition', `${aggregate}: illegal transition ${from} -> ${to}`);
    this.aggregate = aggregate;
    this.from = from;
    this.to = to;
  }
}

/**
 * A command would take a task that has been **merged** — it entered `merged_gate` — anywhere but the
 * stages that follow the merge (technical/02's 2026-10-06 (M9) amendment, PROGRESS backlog 497,
 * WP-152). A merged task never goes back to work: its branch is already in the default branch, so a
 * Developer run on it would re-do work that has shipped. The way forward from an escalation after
 * the merge is `resume` or `retry-stage` at the retrospective (or the librarian), a hand-back to
 * one of them, or `cancel`. Since WP-165 (Q117 (a)) it is also what refuses a pause or a take-over
 * of a merged task, which from `paused` would have had no way to the retrospective.
 *
 * An {@link IllegalTransitionError}, so every caller that already treats a refused move as one —
 * the saga escalates or drops it, a command answers 409 — keeps doing so; the HTTP surface names
 * it `task_merged` rather than `illegal_transition` because the fix is different: not "the task
 * is in the wrong state" but "this task is past that stage for good".
 */
export class TaskMergedError extends IllegalTransitionError {
  /** The stage the refused command aimed at. */
  readonly stage: string;

  /**
   * `move` is set for a pause or a take-over (WP-165, Q117 (a)): neither sends the task to a stage,
   * so the message names the move rather than a stage, and `stage` is the state it aimed at.
   */
  constructor(from: string, stage: string, move?: 'paused' | 'taken over') {
    super('Task', from, `${stage} (the task was merged)`);
    this.stage = stage;
    this.message =
      (move === undefined
        ? `this task was merged, so it cannot be sent to "${stage}": a merged task never goes back to work. `
        : `this task was merged, so it cannot be ${move}: its branch is already in the default branch, so there is nothing to stop or hand over. `) +
      'Resume or retry its retrospective, hand it back to a stage after the merge, or cancel it';
  }
}

/**
 * A human command would move a task past an approval that is still **pending** (BD-006's 2026-11-07
 * amendment, S-27.1; closes BACKLOG 854). `waiting_approval → active` is an edge of the task's
 * table, because the approval's own decision takes it, so the table cannot refuse a resume, a retry
 * or a retry-run that takes the same edge; the approval can. Whatever the caller's role: a member
 * may resume, only a maintainer may approve, and a maintainer decides on the approval rather than
 * around it.
 *
 * An {@link IllegalTransitionError}, so a caller that already treats a refused move as one keeps
 * doing so; the HTTP surface names it `approval_pending` and the approval, because the way on is a
 * decision, not another state.
 */
export class ApprovalPendingError extends IllegalTransitionError {
  readonly approvalId: string;
  readonly approvalKind: string;

  constructor(input: {
    readonly approvalId: string;
    readonly approvalKind: string;
    readonly stage: string;
    readonly move: string;
    /** The task's state: `waiting_approval`, or `paused` out of that wait (BACKLOG 1480). */
    readonly from?: string;
  }) {
    super(
      'Task',
      input.from ?? 'waiting_approval',
      `${input.stage} (approval ${input.approvalId} is pending)`,
    );
    this.approvalId = input.approvalId;
    this.approvalKind = input.approvalKind;
    this.message =
      `this task waits for its ${input.approvalKind} approval ${input.approvalId}, so a ${input.move} ` +
      'cannot move it: only that approval’s decision does. Approve or reject it, or cancel the task';
  }
}

/** A policy (iteration limit, WIP limit, budget, autonomy preset, command list) refused. */
export class PolicyViolationError extends DomainError {
  readonly policy: string;

  constructor(policy: string, message: string) {
    super('policy_violation', `${policy}: ${message}`);
    this.policy = policy;
  }
}

/** An invariant from technical/02 § "Invariants" would have been broken. */
export class InvariantViolationError extends DomainError {
  readonly invariant: string;

  constructor(invariant: string, message: string) {
    super('invariant_violation', `${invariant}: ${message}`);
    this.invariant = invariant;
  }
}

/** `can()` said no. Carries the action so the audit log records what was attempted. */
export class PermissionDeniedError extends DomainError {
  readonly action: string;
  readonly role: string;

  constructor(action: string, role: string) {
    super('permission_denied', `role "${role}" may not perform "${action}"`);
    this.action = action;
    this.role = role;
  }
}
