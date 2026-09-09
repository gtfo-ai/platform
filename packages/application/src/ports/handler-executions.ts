/**
 * The idempotency guard of TD-005: one `handler_executions` row per `(event, handler)`.
 *
 * This is what turns at-least-once delivery into exactly-once *effects*. The claim row and the
 * handler's own writes are made in **one transaction**, so the two can never disagree: either the
 * effect and the "this handler ran" record both commit, or neither does and the event is
 * redelivered. A handler whose effect leaves the database (a Slack post, a ticket comment) gets
 * the weaker guarantee at-least-once gives — which is why every handler must be idempotent.
 *
 * The `$dispatch` marker is a synthetic handler name recording that an event finished dispatching
 * with the registry as it stood. It is why `handler` names are validated on registration: nothing
 * a caller can register can collide with it.
 */

/** Synthetic handler name marking "every handler of this event reached a terminal state". */
export const DISPATCH_MARKER = '$dispatch';

/** Priority stored for the `$dispatch` marker; above every real band (TD-005 tops out at 999). */
export const DISPATCH_MARKER_PRIORITY = 1000;

export type HandlerExecutionStatus =
  /** Claimed by a transaction that has not committed yet. Never observed by another reader. */
  | 'running'
  /** Ran and committed. Never runs again for this event. */
  | 'succeeded'
  /** Threw. Its transaction rolled back, so it has no effects; the event is retried. */
  | 'failed'
  /** A higher-priority handler called `stop()`, durably, before this one ran. */
  | 'stopped';

/** Statuses that must never be re-run for the same event. */
export const TERMINAL_HANDLER_STATUSES: readonly HandlerExecutionStatus[] = [
  'succeeded',
  'stopped',
];

export interface HandlerRef {
  readonly handler: string;
  readonly priority: number;
}

export interface HandlerExecutionRecord {
  readonly eventPosition: number;
  readonly handler: string;
  readonly priority: number;
  readonly status: HandlerExecutionStatus;
  readonly attempts: number;
  readonly error: string | null;
}

/** Transaction-bound writes. Reached through `TransactionScope.handlerExecutions`. */
export interface HandlerExecutionWriter {
  /**
   * Claims `(position, handler)` for this transaction.
   *
   * Returns `false` when the pair already reached a terminal status — the handler has run, so this
   * delivery is a duplicate and must be skipped. Concurrent claimants of the same pair serialise
   * on the row.
   */
  claim(position: number, handler: HandlerRef): Promise<boolean>;

  /**
   * Marks a handler as succeeded, inserting the row when there is none — which is how the
   * `$dispatch` marker is written, since nothing ever claims it.
   */
  complete(position: number, handler: HandlerRef): Promise<void>;

  /**
   * Records the failure of a handler whose own transaction rolled back. Called from the
   * dispatcher's transaction, which commits, so `attempts` and `error` survive.
   */
  recordFailure(position: number, handler: HandlerRef, error: string): Promise<void>;

  /**
   * Durably skips `remaining` because a higher-priority handler called `stop()`.
   *
   * Written inside the stopping handler's transaction, so the decision and the effect that
   * justified it are atomic. It must make each remaining handler **terminal**: on a redelivery the
   * policy handler is skipped (it already succeeded), so nothing re-derives the decision — only the
   * `stopped` rows keep the silenced handlers from running. A handler that already succeeded is
   * left alone; that cannot be unrung.
   */
  markStopped(position: number, remaining: readonly HandlerRef[], reason: string): Promise<void>;
}

/** Connection-scoped reads, for the dispatcher's own assertions, tests and operations. */
export interface HandlerExecutionReader {
  read(position: number): Promise<readonly HandlerExecutionRecord[]>;
}
