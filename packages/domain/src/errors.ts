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
